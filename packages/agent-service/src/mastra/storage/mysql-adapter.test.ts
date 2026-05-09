/**
 * 切片 07 — Mastra MySQL Storage Adapter **真实连接** 集成测试。
 *
 * 测试策略（按用户规则：涉数据库的测试尽量走真实连接，让测试反映实现类的真实问题）：
 *   - 顶部探活 mysql 连接：本地 / CI 已就绪 → 跑全套 9 方法 + UPSERT + HITL E2E + 缺表 fail-fast；
 *     连不上 → describe.skip 优雅降级（仅打 warn，不阻断 CI）。
 *   - 测试库名 `storepilot_test_slice07_<ts>` 随机后缀，避免并行 / 重跑互相干扰；
 *     beforeAll：CREATE DATABASE + 三张 mastra 表 DDL（按 migrations/008/009/010 1:1 拷贝）；
 *     afterAll：DROP DATABASE（任意失败都不会留垃圾）。
 *   - 用真实 mysql2 Pool 注入到 createMysqlStorage，覆盖：
 *       1. happy 写读 snapshot
 *       2. UPSERT —— 同 (workflow_name, run_id) 多次 save → 仅 1 行
 *       3. saveSuspendPayload UPSERT + loadSuspendPayload + deleteSuspendPayload 全链路
 *       4. appendEvent 落库验证
 *       5. listEvents NOOP 返回 []
 *       6. saveMemory / loadMemory 抛 NOT_IMPLEMENTED_IN_V1（红线 3 双保险）
 *       7. init() 三表全在 → 绿灯日志；删一表 → 抛错且错误信息含表名
 *       8. appendEvent 鲁棒 —— 故意把 pool 替换成抛错 fake → 日志 error 但不抛错
 *       9. stripUndefinedDeep —— payload 含嵌套 undefined → 入库后该字段消失
 *
 * 凭据约定：
 *   - 默认 `mysql://root:rootpw@127.0.0.1:3306` —— 本地 dev 默认；可被
 *     `MYSQL_TEST_URL` env 覆盖（CI 推荐覆盖）。
 *   - 不复用 store_pilot 库（开发库会被污染；建独立 schema）。
 */
import mysql, { type Pool } from 'mysql2/promise';

/** 借用 mysql2 自身的 ExecuteValues 类型（与 sql.ts 同一处理）避免 unknown[] 与 ExecuteValues 漂移 */
type MysqlExecuteParams = Parameters<Pool['execute']>[1];
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { BizError } from '@storepilot/shared-contracts';

import { logger } from '../../observability/logger.js';

import {
  createMysqlStorage,
  REQUIRED_TABLES,
  type MysqlStorage,
} from './mysql-adapter.js';
import { type MysqlStoragePool } from './sql.js';

/* ============================================================================
 * 探活 + 测试库准备（顶层 await：让 describe.skipIf 在 collect 阶段就拿到结果）
 *
 * vitest 的 describe.skipIf(condition) 在 describe 调用时立即求值；
 * 若把 condition 放进 beforeAll 里 mutate 一个 let，等 beforeAll 执行时 describe
 * 早已注册完毕 —— 全部 it 都被 skip。所以这里**必须**在模块顶层 await 完成探活
 * 和建表，再让下方 describe 静态读取常量 mysqlAvailable / storage。
 * ========================================================================== */

const BASE_URL = process.env.MYSQL_TEST_URL ?? 'mysql://root:rootpw@127.0.0.1:3306';
const TEST_SCHEMA = `storepilot_test_slice07_${Date.now()}`;

/**
 * 把 BASE_URL 拼上指定 schema —— mysql2 Pool 必须指定 database，不然 information_schema
 * 查询里 `DATABASE()` 返回 null，init() 会判定缺表（与生产语义不一致）。
 */
function urlWithSchema(schema: string | null): string {
  return schema ? `${BASE_URL}/${schema}` : BASE_URL;
}

interface RealEnv {
  pool: Pool;
  storage: MysqlStorage;
}

/**
 * 顶层探活 + 建库 + 建表 —— 返回真实连接句柄；连不上则 null（describe.skipIf 触发）。
 *
 * 注：{@link Pool} 在 createPool 时**不**真连，只在第一次查询才真连；这里通过一次
 * createConnection + SELECT 1 提前发现 dial / auth 失败，让 skip 路径快速生效。
 */
async function setupRealMysql(): Promise<RealEnv | null> {
  let probe: mysql.Connection | null = null;
  try {
    probe = await mysql.createConnection({ uri: urlWithSchema(null) });
    await probe.query('SELECT 1');
    await probe.query(
      `CREATE DATABASE IF NOT EXISTS \`${TEST_SCHEMA}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e), baseUrl: BASE_URL },
      '[test/slice07] MySQL 不可达，本套真实连接集成测试将 skip；如需启用请设置 MYSQL_TEST_URL',
    );
    if (probe) await probe.end().catch(() => undefined);
    return null;
  } finally {
    if (probe) await probe.end().catch(() => undefined);
  }

  // 创建测试库专用 mysql2 Pool；指定 database = TEST_SCHEMA
  const realPool = mysql.createPool({
    uri: urlWithSchema(TEST_SCHEMA),
    connectionLimit: 5,
    queueLimit: 50,
    waitForConnections: true,
  });

  // 按 migrations/008/009/010 1:1 在测试库建三张表（无需走 migrate-runner）。
  // CHARSET / 字段顺序 / 索引名都与迁移文件保持一致，让本测试反映"生产 DDL 之上"的
  // adapter 行为。
  await realPool.query(`
    CREATE TABLE IF NOT EXISTS mastra_workflow_snapshot (
      workflow_name   VARCHAR(128) NOT NULL,
      run_id          VARCHAR(64)  NOT NULL,
      snapshot_json   JSON         NOT NULL,
      created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (workflow_name, run_id),
      KEY idx_snapshot_updated (updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await realPool.query(`
    CREATE TABLE IF NOT EXISTS mastra_workflow_event (
      id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
      workflow_name   VARCHAR(128) NOT NULL,
      run_id          VARCHAR(64)  NOT NULL,
      step_id         VARCHAR(128) NOT NULL,
      event_type      VARCHAR(32)  NOT NULL,
      payload_json    JSON         NULL,
      created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_event_run (workflow_name, run_id, created_at),
      KEY idx_event_type_time (event_type, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await realPool.query(`
    CREATE TABLE IF NOT EXISTS mastra_workflow_suspend (
      run_id        VARCHAR(64)  NOT NULL,
      step_id       VARCHAR(128) NOT NULL,
      payload_json  JSON         NOT NULL,
      expires_at    DATETIME(3)  NOT NULL DEFAULT (NOW(3) + INTERVAL 30 MINUTE),
      created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (run_id, step_id),
      KEY idx_expires (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // 把 mysql2 Pool 包装成 MysqlStoragePool 注入 adapter（不走 sql.ts 单例，避免污染其它测试）
  const wrapped: MysqlStoragePool = wrapMysql2Pool(realPool);
  const realStorage = createMysqlStorage({
    env: { DATABASE_URL: urlWithSchema(TEST_SCHEMA) },
    pool: wrapped,
  });
  return { pool: realPool, storage: realStorage };
}

const realEnv = await setupRealMysql();
const mysqlAvailable = realEnv !== null;
// 在 skip 路径下提供占位，避免后续 describe 中类型推断报 undefined（运行时不会用到）
const pool = (realEnv?.pool ?? null) as unknown as Pool;
const storage = (realEnv?.storage ?? null) as unknown as MysqlStorage;

afterAll(async () => {
  if (!mysqlAvailable) return;
  // afterAll 兜底：把测试库整体 DROP，避免重跑残留
  try {
    await pool.end();
  } catch {
    // ignore
  }
  const cleanup = await mysql.createConnection({ uri: urlWithSchema(null) });
  try {
    await cleanup.query(`DROP DATABASE IF EXISTS \`${TEST_SCHEMA}\``);
  } finally {
    await cleanup.end().catch(() => undefined);
  }
}, 15_000);

/**
 * 把 mysql2 Pool 包成 storage adapter 期望的最小子集。与 sql.ts wrapMysql2Pool 同形态，
 * 这里就地实现是为避免测试触碰 sql.ts 的进程级单例（{@link setMysqlStoragePoolForTest}
 * 用于其它独立单测）。
 */
function wrapMysql2Pool(p: Pool): MysqlStoragePool {
  return {
    query: <T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<[T[], unknown]> =>
      p.query<T[] & mysql.RowDataPacket[]>(sql, params as unknown[]) as unknown as Promise<
        [T[], unknown]
      >,
    execute: (sql: string, params: readonly unknown[] = []) =>
      p.execute<mysql.ResultSetHeader>(sql, params as MysqlExecuteParams) as unknown as Promise<
        [{ affectedRows: number }, unknown]
      >,
    end: () => p.end(),
  };
}

/**
 * 每个测试用例使用独立的 runId / workflowName，避免跨用例脏数据。
 */
function uniqueId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

/* ============================================================================
 * 1) init() —— 三表存在性校验 + startup 第三行绿灯
 * ========================================================================== */

describe.skipIf(!mysqlAvailable)('切片 07 — init() 三表存在性校验', () => {
  it('三表全在 → 不抛错', async () => {
    await expect(storage.init()).resolves.toBeUndefined();
  });

  it('REQUIRED_TABLES 必须严格 = 三张 mastra 表（防漂移）', () => {
    expect([...REQUIRED_TABLES]).toEqual([
      'mastra_workflow_snapshot',
      'mastra_workflow_event',
      'mastra_workflow_suspend',
    ]);
  });

  it('缺任一表 → 抛错 + 错误信息含表名（缺 mastra_workflow_event）', async () => {
    // 故意 DROP 一张表（用例末尾恢复，避免影响后续 it）
    await pool.query('DROP TABLE mastra_workflow_event');
    try {
      const caught: unknown = await storage.init().catch((err: unknown) => err);
      expect(caught).toBeInstanceOf(BizError);
      if (!(caught instanceof BizError)) throw new Error('expected BizError');
      expect(caught.code).toBe('INTERNAL_ERROR');
      expect(caught.message).toMatch(/缺少表 mastra_workflow_event/);
    } finally {
      // 恢复，便于后续 describe 正常跑
      await pool.query(`
        CREATE TABLE IF NOT EXISTS mastra_workflow_event (
          id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
          workflow_name   VARCHAR(128) NOT NULL,
          run_id          VARCHAR(64)  NOT NULL,
          step_id         VARCHAR(128) NOT NULL,
          event_type      VARCHAR(32)  NOT NULL,
          payload_json    JSON         NULL,
          created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          KEY idx_event_run (workflow_name, run_id, created_at),
          KEY idx_event_type_time (event_type, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    }
  });

  it('缺 mastra_workflow_suspend → 抛错 + 错误信息含表名', async () => {
    await pool.query('DROP TABLE mastra_workflow_suspend');
    try {
      const caught: unknown = await storage.init().catch((err: unknown) => err);
      expect(caught).toBeInstanceOf(BizError);
      if (!(caught instanceof BizError)) throw new Error('expected BizError');
      expect(caught.code).toBe('INTERNAL_ERROR');
      expect(caught.message).toMatch(/缺少表 mastra_workflow_suspend/);
    } finally {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS mastra_workflow_suspend (
          run_id        VARCHAR(64)  NOT NULL,
          step_id       VARCHAR(128) NOT NULL,
          payload_json  JSON         NOT NULL,
          expires_at    DATETIME(3)  NOT NULL DEFAULT (NOW(3) + INTERVAL 30 MINUTE),
          created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          PRIMARY KEY (run_id, step_id),
          KEY idx_expires (expires_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    }
  });
});

/* ============================================================================
 * 2) saveWorkflowSnapshot / loadWorkflowSnapshot —— happy + UPSERT
 * ========================================================================== */

describe.skipIf(!mysqlAvailable)('切片 07 — workflow snapshot UPSERT', () => {
  it('save → load 等值（含 status 透传）', async () => {
    const runId = uniqueId('run');
    const workflowId = 'business_daily_report';
    const snapshot = { phase: 'collecting', cards: [{ sku: 'SKU-1', qty: 5 }] };

    await storage.saveWorkflowSnapshot({ runId, workflowId, snapshot, status: 'RUNNING' });
    const loaded = await storage.loadWorkflowSnapshot({ runId });
    expect(loaded).not.toBeNull();
    expect(loaded?.snapshot).toEqual(snapshot);
    expect(loaded?.status).toBe('RUNNING');
  });

  it('未写入的 runId → loadWorkflowSnapshot 返回 null', async () => {
    const result = await storage.loadWorkflowSnapshot({ runId: uniqueId('run-missing') });
    expect(result).toBeNull();
  });

  it('UPSERT —— 同 (workflowId, runId) 多次 save → 仅 1 行（任务卡 §9 step 3）', async () => {
    const runId = uniqueId('run-upsert');
    const workflowId = 'replenishment_forecast';

    await storage.saveWorkflowSnapshot({
      runId,
      workflowId,
      snapshot: { phase: 'init' },
      status: 'RUNNING',
    });
    await storage.saveWorkflowSnapshot({
      runId,
      workflowId,
      snapshot: { phase: 'collecting' },
      status: 'RUNNING',
    });
    await storage.saveWorkflowSnapshot({
      runId,
      workflowId,
      snapshot: { phase: 'done', cards: 3 },
      status: 'COMPLETED',
    });

    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS cnt FROM mastra_workflow_snapshot WHERE workflow_name = ? AND run_id = ?',
      [workflowId, runId],
    );
    expect(rows[0]?.cnt).toBe(1);

    // 最新值生效
    const loaded = await storage.loadWorkflowSnapshot({ runId });
    expect(loaded?.snapshot).toEqual({ phase: 'done', cards: 3 });
    expect(loaded?.status).toBe('COMPLETED');
  });

  it('stripUndefinedDeep —— 嵌套 undefined 字段入库后消失', async () => {
    const runId = uniqueId('run-strip');
    const workflowId = 'strip-test';
    const snapshot = {
      a: undefined,
      b: 1,
      nested: { x: undefined, y: 'keep', deep: { z: undefined, w: true } },
      list: [{ k: undefined, v: 2 }],
    };
    await storage.saveWorkflowSnapshot({ runId, workflowId, snapshot, status: 'RUNNING' });
    const loaded = await storage.loadWorkflowSnapshot({ runId });
    expect(loaded?.snapshot).toEqual({
      b: 1,
      nested: { y: 'keep', deep: { w: true } },
      list: [{ v: 2 }],
    });
  });
});

/* ============================================================================
 * 3) appendEvent / listEvents
 * ========================================================================== */

describe.skipIf(!mysqlAvailable)('切片 07 — appendEvent + listEvents', () => {
  it('appendEvent 落库 —— 行数 +1 + payload_json 可读', async () => {
    const runId = uniqueId('run-evt');
    const workflowId = 'business_daily_report';
    await storage.appendEvent({
      runId,
      workflowId,
      stepId: 'step.collect',
      eventType: 'STEP_START',
      payload: { ts: 1715073600000, op: 'start' },
    });
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT step_id, event_type, payload_json
         FROM mastra_workflow_event
        WHERE workflow_name = ? AND run_id = ?
        ORDER BY id DESC LIMIT 1`,
      [workflowId, runId],
    );
    expect(rows[0]?.step_id).toBe('step.collect');
    expect(rows[0]?.event_type).toBe('STEP_START');
    // mysql2 默认 JSON 列已 parse 成对象
    expect(rows[0]?.payload_json).toEqual({ ts: 1715073600000, op: 'start' });
  });

  it('listEvents NOOP 返回 []（V1 不消费事件流读取）', async () => {
    const result = await storage.listEvents({ runId: uniqueId('any') });
    expect(result).toEqual([]);
  });

  it('appendEvent 失败必须不阻断（fake pool 抛错 → 仅 logger.error，不 reject）', async () => {
    // 用注入抛错 fake pool 的 adapter 验证鲁棒性；不污染主 pool 的真实数据
    const errorPool: MysqlStoragePool = {
      query: () => Promise.reject(new Error('mysql gone (test)')),
      execute: () => Promise.reject(new Error('mysql gone (test)')),
      end: () => Promise.resolve(),
    };
    const robustStorage = createMysqlStorage({
      env: { DATABASE_URL: 'mysql://test:test@127.0.0.1:3306/none' },
      pool: errorPool,
    });
    await expect(
      robustStorage.appendEvent({
        runId: 'r-x',
        workflowId: 'w-x',
        stepId: 's-x',
        eventType: 'STEP_FAIL',
        payload: { e: 'boom' },
      }),
    ).resolves.toBeUndefined();
  });
});

/* ============================================================================
 * 4) suspend payload —— save / load / delete + UPSERT
 * ========================================================================== */

describe.skipIf(!mysqlAvailable)('切片 07 — suspend payload 生命周期 (HITL)', () => {
  it('save → load 等值 + delete 后 load 为 null', async () => {
    const runId = uniqueId('run-suspend');
    const stepId = 'step.confirm';
    const payload = { draftId: 'drf_abc', traceId: 'trace_xyz', items: [{ sku: 'A', qty: 3 }] };

    await storage.saveSuspendPayload(runId, stepId, payload);
    const loaded = await storage.loadSuspendPayload(runId);
    expect(loaded).not.toBeNull();
    expect(loaded?.stepId).toBe(stepId);
    expect(loaded?.payload).toEqual(payload);

    await storage.deleteSuspendPayload(runId);
    expect(await storage.loadSuspendPayload(runId)).toBeNull();
  });

  it('未存在 → loadSuspendPayload 返回 null（任务卡 §7 表）', async () => {
    expect(await storage.loadSuspendPayload(uniqueId('missing'))).toBeNull();
  });

  it('saveSuspendPayload UPSERT —— 同 (runId, stepId) 多次 save → 仅 1 行', async () => {
    const runId = uniqueId('run-suspend-up');
    const stepId = 'step.confirm';
    await storage.saveSuspendPayload(runId, stepId, { v: 1 });
    await storage.saveSuspendPayload(runId, stepId, { v: 2 });
    await storage.saveSuspendPayload(runId, stepId, { v: 3 });

    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS cnt FROM mastra_workflow_suspend WHERE run_id = ?',
      [runId],
    );
    expect(rows[0]?.cnt).toBe(1);

    const loaded = await storage.loadSuspendPayload(runId);
    expect(loaded?.payload).toEqual({ v: 3 });
  });

  it('deleteSuspendPayload —— 同 runId 多 step_id 一并清空', async () => {
    const runId = uniqueId('run-suspend-multi');
    await storage.saveSuspendPayload(runId, 'step.a', { v: 'a' });
    await storage.saveSuspendPayload(runId, 'step.b', { v: 'b' });
    await storage.deleteSuspendPayload(runId);
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS cnt FROM mastra_workflow_suspend WHERE run_id = ?',
      [runId],
    );
    expect(rows[0]?.cnt).toBe(0);
  });

  it('deleteSuspendPayload —— 不存在的 runId 不抛错（幂等）', async () => {
    await expect(storage.deleteSuspendPayload(uniqueId('nope'))).resolves.toBeUndefined();
  });
});

/* ============================================================================
 * 5) Memory NOOP 双保险（红线 3）—— 任意环境都校验，不依赖 DB
 * ========================================================================== */

describe('切片 07 — Memory NOOP 双保险（红线 3，不依赖 MySQL）', () => {
  // 用纯 fake pool；本组校验语义即可，不需要真实 DB
  const noopPool: MysqlStoragePool = {
    query: () => Promise.resolve([[], undefined]),
    execute: () => Promise.resolve([{ affectedRows: 0 }, undefined]),
    end: () => Promise.resolve(),
  };
  const noopStorage = createMysqlStorage({
    env: { DATABASE_URL: 'mysql://test:test@127.0.0.1:3306/none' },
    pool: noopPool,
  });

  it('saveMemory 必须抛 BizError(NOT_IMPLEMENTED_IN_V1)', async () => {
    await expect(noopStorage.saveMemory()).rejects.toBeInstanceOf(BizError);
    await expect(noopStorage.saveMemory()).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED_IN_V1',
    });
  });

  it('loadMemory 必须抛 BizError(NOT_IMPLEMENTED_IN_V1)', async () => {
    await expect(noopStorage.loadMemory()).rejects.toBeInstanceOf(BizError);
    await expect(noopStorage.loadMemory()).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED_IN_V1',
    });
  });
});

/* ============================================================================
 * 6) 9 方法签名齐全（任务卡 §9 step 7：node -e console.log typeof adapter[m]）
 * ========================================================================== */

describe('切片 07 — 9 方法签名齐全（不依赖 MySQL）', () => {
  const noopPool: MysqlStoragePool = {
    query: () => Promise.resolve([[], undefined]),
    execute: () => Promise.resolve([{ affectedRows: 0 }, undefined]),
    end: () => Promise.resolve(),
  };
  const s = createMysqlStorage({
    env: { DATABASE_URL: 'mysql://test:test@127.0.0.1:3306/none' },
    pool: noopPool,
  });

  it.each([
    'init',
    'saveWorkflowSnapshot',
    'loadWorkflowSnapshot',
    'appendEvent',
    'listEvents',
    'saveSuspendPayload',
    'loadSuspendPayload',
    'deleteSuspendPayload',
    'saveMemory',
    'loadMemory',
  ] as const)('方法 %s 必须为 function', (name) => {
    expect(typeof (s as unknown as Record<string, unknown>)[name]).toBe('function');
  });
});

/* ============================================================================
 * 7) JSON 列解析兜底 —— 不依赖 MySQL，补齐 mysql2 行为差异分支
 * ========================================================================== */

describe('切片 07 — JSON 列解析兜底（不依赖 MySQL）', () => {
  function storageWithQueryRows(rows: Record<string, unknown>[]): MysqlStorage {
    const poolForRows: MysqlStoragePool = {
      query: <T extends Record<string, unknown>>(): Promise<[T[], unknown]> =>
        Promise.resolve([rows as T[], undefined]),
      execute: () => Promise.resolve([{ affectedRows: 0 }, undefined]),
      end: () => Promise.resolve(),
    };
    return createMysqlStorage({
      env: { DATABASE_URL: 'mysql://test:test@127.0.0.1:3306/none' },
      pool: poolForRows,
    });
  }

  it('loadWorkflowSnapshot 可解析 mysql2 返回的 JSON 字符串', async () => {
    const s = storageWithQueryRows([
      { snapshot_json: '{"snapshot":{"phase":"done"},"status":"COMPLETED"}' },
    ]);

    await expect(s.loadWorkflowSnapshot({ runId: 'run_json_string' })).resolves.toEqual({
      snapshot: { phase: 'done' },
      status: 'COMPLETED',
    });
  });

  it('loadWorkflowSnapshot 遇到非法 JSON 字符串时返回 null 而不抛错', async () => {
    const s = storageWithQueryRows([{ snapshot_json: 'not-json' }]);

    await expect(s.loadWorkflowSnapshot({ runId: 'run_bad_json' })).resolves.toBeNull();
  });

  it('loadSuspendPayload 可解析 JSON 字符串 payload', async () => {
    const s = storageWithQueryRows([
      { step_id: 'step.confirm', payload_json: '{"draftId":"drf_test","ok":true}' },
    ]);

    await expect(s.loadSuspendPayload('run_suspend_json')).resolves.toEqual({
      stepId: 'step.confirm',
      payload: { draftId: 'drf_test', ok: true },
    });
  });

  it('loadSuspendPayload 遇到非法 JSON 字符串时 payload 兜底为 null', async () => {
    const s = storageWithQueryRows([{ step_id: 'step.confirm', payload_json: 'not-json' }]);

    await expect(s.loadSuspendPayload('run_suspend_bad_json')).resolves.toEqual({
      stepId: 'step.confirm',
      payload: null,
    });
  });
});

// 防 vitest 报"empty test file"
afterEach(() => {
  // 没有共享状态需要重置，placeholder 保留以便未来扩展
});
