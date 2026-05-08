/**
 * 切片 19 — E2E 共享真实 MySQL pool（任务卡 §7 MUST NOT §3：禁 mock 数据库）
 *
 * 实现策略：
 *   - 默认走 docker-compose.dev 的 storepilot-mysql（root/rootpw @ 127.0.0.1:3306），
 *     测试连不上时整组 skip（与 strategy-invalidation.integration.test.ts 同形）。
 *   - Pool 复用：进程内单例，避免 20 条 E2E 各起 20 个连接池打爆 DB。
 *   - 每条用例在 beforeAll/beforeEach 通过 cleanTenantData(merchantId) 清掉自己租户痕迹，
 *     避免 20 条 E2E 跨用例污染。
 *
 * 与 packages/agent-service/src/safety/draft-manager.ts DraftPool / confirm-manager.ts
 * ConfirmManagerPool 同形（query / execute / transaction）。E2E 直接把本 pool 传给
 * setDraftPool / setConfirmManagerPool / setAuthPool / setStrategyLoader 各 DI hook。
 *
 * @since 切片 19
 */
import mysql, { type Pool } from 'mysql2/promise';
import type { ConfirmManagerPool, ConfirmTx } from '../../../src/safety/confirm-manager.js';
import type { DraftPool } from '../../../src/safety/draft-manager.js';
import type { AuthPool } from '../../../src/bridge/auth.js';
import { E2E_DEFAULT_DATABASE_URL } from './env.js';

/** 测试运行时 MySQL URL —— 优先取环境变量 MYSQL_TEST_URL，便于 CI 切换。 */
function resolveTestMysqlUrl(): string {
  // ESLint no-direct-env 在 src/ 之外不生效；这里仅读取调用方在 npm script 注入的测试值，
  // 不写 process.env，因此与切片 18 §7 MUST NOT §2 不冲突。
  // eslint-disable-next-line @typescript-eslint/dot-notation
  const fromEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.['MYSQL_TEST_URL'];
  return fromEnv ?? E2E_DEFAULT_DATABASE_URL;
}

/**
 * 模块加载期一次性探测 MySQL 可达性 + 创建 Pool（top-level await）。
 *
 * 这样 `describe.skipIf(!isMysqlReady())` 在 describe 注册期就能拿到正确值，
 * 不会因 beforeAll 时序问题导致 it.skip 全部 skip。
 *
 * 不可达时 `mysqlPool=null`，所有 e2e 用例 `describe.skipIf(!isMysqlReady())` 整组 skip。
 */
async function probeAndCreatePool(): Promise<Pool | null> {
  try {
    const probe = await mysql.createConnection({ uri: resolveTestMysqlUrl() });
    await probe.query('SELECT 1');
    await probe.end();
    return mysql.createPool({
      uri: resolveTestMysqlUrl(),
      connectionLimit: 8,
      queueLimit: 50,
      waitForConnections: true,
    });
  } catch {
    return null;
  }
}

let mysqlPool: Pool | null = await probeAndCreatePool();

/** 是否成功连上 MySQL（用于 describe.skipIf） */
export function isMysqlReady(): boolean {
  return mysqlPool !== null;
}

/** 获取已初始化的 mysql2 Pool；未 ready 时抛错（caller 应 skip）。 */
export function getMysqlPool(): Pool {
  if (!mysqlPool) {
    throw new Error('[e2e/mysql] MySQL 不可达；请确认 docker-compose.dev.yml 已 up mysql');
  }
  return mysqlPool;
}

/** （兼容旧 API）等价于 isMysqlReady；为保留 caller 兼容性而存在。 */
export async function ensureMysqlReady(): Promise<boolean> {
  return Promise.resolve(isMysqlReady());
}

/** 关闭进程级 pool（CI 单进程跑完 20 条后调一次；幂等）。 */
export async function closeMysqlPool(): Promise<void> {
  if (!mysqlPool) return;
  const local = mysqlPool;
  mysqlPool = null;
  await local.end().catch(() => undefined);
}

/* ============================================================================
 * Pool 适配器 —— 统一桥接 mysql2 Pool 到各业务 DI 接口形状
 * ========================================================================== */

/** 把 mysql2 Pool 包装成 AuthPool（auth.ts 接口） */
export function asAuthPool(pool: Pool): AuthPool {
  return {
    query: <T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<[T[], unknown]> =>
      pool
        .query(sql, params as unknown[])
        .then(([rows, fields]) => [rows as T[], fields]) as Promise<[T[], unknown]>,
    execute: (
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<[{ affectedRows: number }, unknown]> =>
      pool
        .execute(sql, params as unknown[])
        .then(([result, fields]) => [
          result as unknown as { affectedRows: number },
          fields,
        ]) as Promise<[{ affectedRows: number }, unknown]>,
  };
}

/** 把 mysql2 Pool 包装成 DraftPool（draft-manager.ts 接口） */
export function asDraftPool(pool: Pool): DraftPool {
  return asAuthPool(pool) as unknown as DraftPool;
}

/** 把 mysql2 Pool 包装成 ConfirmManagerPool —— 含 transaction(BEGIN/COMMIT/ROLLBACK) */
export function asConfirmManagerPool(pool: Pool): ConfirmManagerPool {
  const adapter = asAuthPool(pool) as unknown as ConfirmManagerPool;
  adapter.transaction = async <T>(fn: (tx: ConfirmTx) => Promise<T>): Promise<T> => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const tx: ConfirmTx = {
        query: <T2 extends Record<string, unknown>>(
          sql: string,
          params: readonly unknown[],
        ): Promise<[T2[], unknown]> =>
          conn
            .query(sql, params as unknown[])
            .then(([rows, fields]) => [rows as T2[], fields]) as Promise<[T2[], unknown]>,
        execute: (sql: string, params: readonly unknown[]) =>
          conn
            .execute(sql, params as unknown[])
            .then(([result, fields]) => [
              result as unknown as { affectedRows: number },
              fields,
            ]) as Promise<[{ affectedRows: number }, unknown]>,
      };
      const r = await fn(tx);
      await conn.commit();
      return r;
    } catch (err) {
      await conn.rollback().catch(() => undefined);
      throw err;
    } finally {
      conn.release();
    }
  };
  return adapter;
}

/* ============================================================================
 * 数据清理 —— 按租户清理痕迹（不删表 / 不清整库），保留隔离性
 * ========================================================================== */

/**
 * 删除某租户在所有 E2E 相关表里的痕迹（按 merchant_id 范围圈定；不影响其它用例）。
 *
 * 表关系：
 *   - agent_session.merchant_id（直接关联）
 *   - replenishment_draft.merchant_id（直接关联）
 *   - replenishment_adjustment_log.draft_id → 通过子查询关联到 merchant_id
 *   - agent_api_key.merchant_id（直接关联）
 *   - agent_merchant_strategy / agent_store_strategy.merchant_id（直接关联）
 *   - mastra_workflow_suspend.run_id → 通过 agent_session.active_run_id 反查
 *
 * 顺序：先 child（adjustment_log / suspend）后 parent（draft / session / strategy / api_key），
 * 避免外键 / 索引依赖（V1 没建外键，但保持顺序便于以后拓展）。
 */
export async function cleanTenantData(pool: Pool, merchantId: string): Promise<void> {
  const [activeSessions] = await pool.query<{ active_run_id: string | null }[]>(
    `SELECT active_run_id FROM agent_session WHERE merchant_id = ?`,
    [merchantId],
  );
  const runIds = activeSessions
    .map((row) => row.active_run_id)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (runIds.length > 0) {
    await pool.query(
      `DELETE FROM mastra_workflow_suspend WHERE run_id IN (${runIds.map(() => '?').join(',')})`,
      runIds,
    );
  }
  await pool.query(
    `DELETE FROM replenishment_adjustment_log
       WHERE draft_id IN (SELECT draft_id FROM replenishment_draft WHERE merchant_id = ?)`,
    [merchantId],
  );
  await pool.query(`DELETE FROM replenishment_draft WHERE merchant_id = ?`, [merchantId]);
  await pool.query(`DELETE FROM agent_session WHERE merchant_id = ?`, [merchantId]);
  await pool.query(`DELETE FROM agent_api_key WHERE merchant_id = ?`, [merchantId]);
  await pool.query(`DELETE FROM agent_store_strategy WHERE merchant_id = ?`, [merchantId]);
  await pool.query(`DELETE FROM agent_merchant_strategy WHERE merchant_id = ?`, [merchantId]);
}
