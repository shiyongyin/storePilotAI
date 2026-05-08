/**
 * 切片 07 — Mastra Storage 专用 SQL helper（mysql2 Pool 复用 + DI 友好）。
 *
 * 强约束（任务卡 §7 MUST DO §6 / §6 池复用）:
 *   - 进程内**单例** Pool（不允许在 9 方法中每次 new connection）。
 *   - Pool 配置由切片 01 env 提供：DATABASE_URL / DB_POOL_MAX / DB_QUEUE_LIMIT。
 *   - 暴露最小 {@link MysqlStoragePool} 接口（mysql2/promise.Pool 的 `query/execute/end` 子集），
 *     生产由 mysql2 真实 Pool 实现；测试可注入 in-memory fake，避免依赖真实 DB。
 *   - {@link setMysqlStoragePoolForTest} / {@link resetMysqlStoragePoolForTest} 仅供单测；
 *     生产路径只走 {@link getOrCreateMysqlStoragePool}。
 *
 * 设计决策：
 *   - 与切片 13 `safety/draft-manager.ts` 的 DraftPool 保持**形状一致**（query/execute 同签名），
 *     便于切片 20 注入同一个 mysql2 Pool 实例 → 全 workspace 一个连接池（避免连接数浪费）。
 *   - 不在本文件落 readonly transaction / SELECT FOR UPDATE 等业务 helper（属切片 13 / 16）；
 *     storage adapter 只读 information_schema + 写 mastra_workflow_* 三表，无事务边界需求。
 */
import mysql, { type Pool, type PoolOptions } from 'mysql2/promise';

type MysqlExecuteParams = Parameters<Pool['execute']>[1];

/**
 * mysql2 Pool 的最小子集 —— storage adapter 需要的所有 SQL 调用都通过本接口走。
 *
 * - {@link query}：SELECT；返回 `[rows, fields]`。
 * - {@link execute}：INSERT / UPDATE / DELETE / DDL；返回 `[ResultSetHeader, fields]`，仅取 `affectedRows`。
 * - {@link end}：进程退出时释放连接池（与 SIGTERM/SIGINT 钩子配合，避免连接泄漏）。
 */
export interface MysqlStoragePool {
  query<T extends Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<[T[], unknown]>;
  execute(
    sql: string,
    params?: readonly unknown[],
  ): Promise<[{ affectedRows: number }, unknown]>;
  transaction?<T>(fn: (tx: MysqlStorageTx) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

/**
 * 单连接事务接口。
 *
 * `MysqlStoragePool` 自身仍只暴露 query/execute/end 最小集；transaction 是可选能力，
 * 由生产 mysql2 wrapper 提供，供 ConfirmManager 的 `SELECT ... FOR UPDATE` 复用同一连接池。
 */
export interface MysqlStorageTx {
  query<T extends Record<string, unknown>>(
    sql: string,
    params: readonly unknown[],
  ): Promise<[T[], unknown]>;
  execute(
    sql: string,
    params: readonly unknown[],
  ): Promise<[{ affectedRows: number }, unknown]>;
}

/**
 * Pool 创建所需的 env 子集（仅 DATABASE_URL 必填；池容量为可选，未给走默认）。
 *
 * 与 `config/env.ts` 中的字段名 1:1 对齐，避免上层手抄。
 */
export interface MysqlStoragePoolEnv {
  DATABASE_URL: string;
  DB_POOL_MAX?: number;
  DB_QUEUE_LIMIT?: number;
}

/** 默认池容量（与切片 01 env 默认值一致；env 给定时优先用 env） */
const DEFAULT_POOL_MAX = 20;
const DEFAULT_QUEUE_LIMIT = 200;

let sharedPool: MysqlStoragePool | null = null;

/**
 * 获取/创建进程内单例 Pool。
 *
 * - 首次调用：按 env.DATABASE_URL 创建 mysql2 Pool（Pool 内部维护连接，不阻塞）。
 * - 再次调用：直接返回已创建的实例（任务卡 §7 MUST DO §6：禁止每次 new connection）。
 *
 * @param env DATABASE_URL 必填；DB_POOL_MAX / DB_QUEUE_LIMIT 未给则默认 20 / 200。
 * @returns 进程内单例 Pool（多次调用同一实例）。
 */
export function getOrCreateMysqlStoragePool(env: MysqlStoragePoolEnv): MysqlStoragePool {
  if (sharedPool) return sharedPool;
  const opts: PoolOptions = {
    uri: env.DATABASE_URL,
    connectionLimit: env.DB_POOL_MAX ?? DEFAULT_POOL_MAX,
    queueLimit: env.DB_QUEUE_LIMIT ?? DEFAULT_QUEUE_LIMIT,
    // dateStrings 与 .env.example 中的 DATABASE_URL 查询参数一致；
    // information_schema.tables 查询无日期字段，本配置不影响 init() 行为。
    waitForConnections: true,
    enableKeepAlive: true,
  };
  const pool: Pool = mysql.createPool(opts);
  sharedPool = wrapMysql2Pool(pool);
  return sharedPool;
}

/**
 * 把 mysql2 Pool 包装成 {@link MysqlStoragePool} —— 屏蔽 mysql2 的 generic 形态差异，
 * 让 adapter 直接面向最小接口编程。
 */
function wrapMysql2Pool(pool: Pool): MysqlStoragePool {
  return {
    query: <T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<[T[], unknown]> => {
      // mysql2 query 签名兼容 readonly any[]；这里强制为 unknown[] 已足够安全。
      return pool.query<T[] & mysql.RowDataPacket[]>(sql, params as unknown[]) as unknown as Promise<
        [T[], unknown]
      >;
    },
    execute: (
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<[{ affectedRows: number }, unknown]> => {
      return pool.execute<mysql.ResultSetHeader>(sql, params as MysqlExecuteParams) as unknown as Promise<
        [{ affectedRows: number }, unknown]
      >;
    },
    transaction: async <T>(fn: (tx: MysqlStorageTx) => Promise<T>): Promise<T> => {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const tx: MysqlStorageTx = {
          query: <T2 extends Record<string, unknown>>(
            sql: string,
            params: readonly unknown[],
          ): Promise<[T2[], unknown]> => {
            return conn.query<T2[] & mysql.RowDataPacket[]>(
              sql,
              params as unknown[],
            ) as unknown as Promise<[T2[], unknown]>;
          },
          execute: (
            sql: string,
            params: readonly unknown[],
          ): Promise<[{ affectedRows: number }, unknown]> => {
            return conn.execute<mysql.ResultSetHeader>(
              sql,
              params as MysqlExecuteParams,
            ) as unknown as Promise<[{ affectedRows: number }, unknown]>;
          },
        };
        const result = await fn(tx);
        await conn.commit();
        return result;
      } catch (err) {
        await conn.rollback().catch(() => undefined);
        throw err;
      } finally {
        conn.release();
      }
    },
    end: async () => {
      await pool.end();
    },
  };
}

/**
 * 注入测试用 Pool —— 让 mysql-adapter.test.ts 可在不依赖真实 mysql2 的前提下
 * 验证 9 方法的 SQL 形态、UPSERT 语义、表存在性校验、appendEvent 鲁棒性。
 *
 * @internal 测试专用；生产代码不允许调用。
 */
export function setMysqlStoragePoolForTest(pool: MysqlStoragePool): void {
  sharedPool = pool;
}

/**
 * 测试 afterEach 清理；避免用例间共享同一 fake Pool 状态。
 *
 * @internal 测试专用。
 */
export function resetMysqlStoragePoolForTest(): void {
  sharedPool = null;
}

/**
 * 进程退出时释放连接池（SIGTERM / SIGINT 主动调用；与 server.ts shutdown 串联）。
 *
 * 幂等：未创建过 Pool 时 NOOP；多次调用安全。
 */
export async function closeMysqlStoragePool(): Promise<void> {
  if (!sharedPool) return;
  const local = sharedPool;
  sharedPool = null;
  try {
    await local.end();
  } catch {
    // 关闭失败不阻断 shutdown 流程；上游 logger 由调用方决定是否记录。
  }
}
