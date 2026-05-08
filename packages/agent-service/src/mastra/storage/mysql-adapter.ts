/**
 * 切片 07 — Mastra MySQL Storage Adapter（HIGH 风险独立切片）。
 *
 * 严格按 docs/tanks/07-mastra-mysql-storage.md §6-§9 + D-Mastra.md §T-MASTRA-02.5 落地。
 *
 * 9 个方法（任务卡 §7 / §8）：
 *   | 方法                        | 行为                                                     |
 *   | --------------------------- | -------------------------------------------------------- |
 *   | init()                      | 启动期校验三表存在；缺任一抛错（上游 process.exit(1)）   |
 *   | saveWorkflowSnapshot        | UPSERT mastra_workflow_snapshot                          |
 *   | loadWorkflowSnapshot        | SELECT 单行，返回 { snapshot, status } 或 null           |
 *   | appendEvent                 | INSERT mastra_workflow_event；失败仅 pino error 不阻断   |
 *   | listEvents                  | NOOP 兜底返回 []（V1 不消费事件流读取）                   |
 *   | saveSuspendPayload          | UPSERT mastra_workflow_suspend                           |
 *   | loadSuspendPayload          | SELECT 单行，返回 { stepId, payload } 或 null            |
 *   | deleteSuspendPayload        | DELETE WHERE run_id = ?（resume 完成后清理）              |
 *   | saveMemory / loadMemory     | 必须 throw BizError(NOT_IMPLEMENTED_IN_V1)（红线 3 双保险）|
 *
 * 强约束（违反即拒收）:
 *   - JSON 字段写入必须 {@link stripUndefinedDeep} + JSON.stringify（避免嵌套 undefined 丢字段）
 *   - saveWorkflowSnapshot 必须 ON DUPLICATE KEY UPDATE（同 runId 多次 save → 1 行）
 *   - appendEvent 失败必须不阻断 workflow（仅 logger.error）
 *   - mysql2 Pool 必须复用（{@link getOrCreateMysqlStoragePool} 单例）
 *   - saveMemory / loadMemory 必须显式抛 NOT_IMPLEMENTED_IN_V1（红线 3 双保险）
 *   - storage 方法不得抛业务 BizError 之外的异常（除 NOT_IMPLEMENTED_IN_V1）
 *
 * !! DDL 适配说明（任务卡 §3 禁止读取 + §6 DDL 已就位本切片只校验）!!
 *   - 实际 DDL（migrations/008/009/010）字段名与任务卡 §8.2 示例 SQL 略有差异：
 *       * mastra_workflow_snapshot：(workflow_name, run_id) 联合 PK，**无 status 列** →
 *         本 adapter 把 status 与 snapshot 一同序列化进 snapshot_json：
 *         `{ "snapshot": <user-snapshot>, "status": "<status>" }`，
 *         load 时再拆出，对外 API 完全保持任务卡口径 `{ snapshot, status } | null`。
 *       * mastra_workflow_event：列名是 workflow_name（非 workflow_id）；本 adapter
 *         在 SQL 层映射 args.workflowId → workflow_name，对外 API 不变。
 *       * mastra_workflow_suspend：(run_id, step_id) 联合 PK，理论上同 run_id 可有多个
 *         step；loadSuspendPayload 取最新一条（ORDER BY created_at DESC LIMIT 1），
 *         deleteSuspendPayload 清空整个 run_id 的所有 suspend 行（resume 完成后清理）。
 */
import {
  BizError,
  type ErrorCode,
} from '@storepilot/shared-contracts';

import { logger } from '../../observability/logger.js';

import {
  getOrCreateMysqlStoragePool,
  type MysqlStoragePool,
  type MysqlStoragePoolEnv,
} from './sql.js';
import { stripUndefinedDeep } from './strip-undefined-deep.js';

/* ============================================================================
 * 1) 公开类型
 * ========================================================================== */

/** 启动期 init() 必须确保存在的三张表（任务卡 §7 MUST DO §2） */
export const REQUIRED_TABLES: readonly [string, string, string] = [
  'mastra_workflow_snapshot',
  'mastra_workflow_event',
  'mastra_workflow_suspend',
] as const;

/** saveWorkflowSnapshot 入参（任务卡 §7 §1 表） */
export interface SaveWorkflowSnapshotArgs {
  runId: string;
  workflowId: string;
  snapshot: unknown;
  status: string;
}

/** loadWorkflowSnapshot 入参 */
export interface LoadWorkflowSnapshotArgs {
  runId: string;
}

/** loadWorkflowSnapshot 返回（任务卡 §7 §1 表） */
export interface WorkflowSnapshotLoadResult {
  snapshot: unknown;
  status: string;
}

/** appendEvent 入参（任务卡 §7 §1 表） */
export interface AppendEventArgs {
  runId: string;
  workflowId: string;
  stepId: string;
  eventType: string;
  payload: unknown;
}

/** listEvents 入参 */
export interface ListEventsArgs {
  runId: string;
  limit?: number;
}

/** loadSuspendPayload 返回 */
export interface SuspendPayloadLoadResult {
  stepId: string;
  payload: unknown;
}

/**
 * MySQL Storage Adapter 公开形态 —— 与任务卡 §7 「9 方法签名」1:1 对齐。
 *
 * 注：mastra 1.0 的 `MastraCompositeStore` 形态远超 9 方法；本切片不接入 1.0 的
 * Composite store（避免侵入），只对外承诺这 9 个原子方法 —— 后续切片若需要把 storage
 * 注入 `new Mastra({ storage })`，再单独写 CompositeStore 适配层。
 */
export interface MysqlStorage {
  init(): Promise<void>;
  saveWorkflowSnapshot(args: SaveWorkflowSnapshotArgs): Promise<void>;
  loadWorkflowSnapshot(args: LoadWorkflowSnapshotArgs): Promise<WorkflowSnapshotLoadResult | null>;
  appendEvent(args: AppendEventArgs): Promise<void>;
  listEvents(args: ListEventsArgs): Promise<unknown[]>;
  saveSuspendPayload(runId: string, stepId: string, payload: unknown): Promise<void>;
  loadSuspendPayload(runId: string): Promise<SuspendPayloadLoadResult | null>;
  deleteSuspendPayload(runId: string): Promise<void>;
  saveMemory(): Promise<never>;
  loadMemory(): Promise<never>;
}

/**
 * 兼容历史命名 —— 切片 06 用 `MysqlStorageStub`；切片 07 升级为完整实现 `MysqlStorage`。
 * 两个名字共享一份接口，避免下游导入路径破坏。
 *
 * @deprecated 新代码请使用 {@link MysqlStorage}。
 */
export type MysqlStorageStub = MysqlStorage;

/**
 * createMysqlStorage 入参。
 *
 * - {@link CreateMysqlStorageArgs.env}：DATABASE_URL / DB_POOL_MAX / DB_QUEUE_LIMIT。
 * - {@link CreateMysqlStorageArgs.pool}：可选；测试 / 多实例隔离场景下注入。
 *   未传 → 走 {@link getOrCreateMysqlStoragePool} 单例。
 */
export interface CreateMysqlStorageArgs {
  env: MysqlStoragePoolEnv;
  /**
   * 可选注入；只在测试 / 二阶段实例化场景使用。生产路径必须不传，
   * 走 sql.ts 单例（任务卡 §7 MUST DO §6 池复用）。
   */
  pool?: MysqlStoragePool;
}

/* ============================================================================
 * 2) 工厂方法
 * ========================================================================== */

/**
 * 创建 MySQL Storage Adapter 实例（任务卡 §6）。
 *
 * - 多次调用同一 env 返回的 adapter 共享同一 Pool（mysql2 进程内单例）。
 * - 对外 9 方法严格遵循任务卡 §7 / §8 的行为约定 —— 见各方法 javadoc。
 *
 * @param args 工厂参数（env + 可选 pool 注入）
 * @returns MysqlStorage 实例
 */
export function createMysqlStorage(args: CreateMysqlStorageArgs): MysqlStorage {
  const pool = args.pool ?? getOrCreateMysqlStoragePool(args.env);

  return {
    init: () => initImpl(pool),
    saveWorkflowSnapshot: (a) => saveWorkflowSnapshotImpl(pool, a),
    loadWorkflowSnapshot: (a) => loadWorkflowSnapshotImpl(pool, a),
    appendEvent: (a) => appendEventImpl(pool, a),
    listEvents: (a) => listEventsImpl(a),
    saveSuspendPayload: (runId, stepId, payload) =>
      saveSuspendPayloadImpl(pool, runId, stepId, payload),
    loadSuspendPayload: (runId) => loadSuspendPayloadImpl(pool, runId),
    deleteSuspendPayload: (runId) => deleteSuspendPayloadImpl(pool, runId),
    saveMemory: () => memoryNotImplemented(),
    loadMemory: () => memoryNotImplemented(),
  };
}

/* ============================================================================
 * 3) init() —— 启动期三表存在性校验
 * ========================================================================== */

/**
 * 启动期校验三张表（mastra_workflow_snapshot / event / suspend）必须存在。
 *
 * - 缺任一表 → 抛错（上游 server.ts bootstrap 捕获后 process.exit(1)）。
 * - 三张表全部就位 → logger.info('[startup] mastra-storage-ok')，
 *   即启动六行绿灯第 3 行（任务卡 §8.1 / §9 step 6）。
 *
 * 注：information_schema 查询不依赖任何业务表；若 DB 未启动会在 query 阶段抛 mysql2 错误，
 * 与缺表错误同样会被 bootstrap 捕获并 fail-fast。
 *
 * @throws BizError 缺任一表（上游捕获）
 */
async function initImpl(pool: MysqlStoragePool): Promise<void> {
  for (const table of REQUIRED_TABLES) {
    const [rows] = await pool.query<Record<string, unknown>>(
      `SELECT 1 AS ok FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = ?
        LIMIT 1`,
      [table],
    );
    if (rows.length === 0) {
      // 任务卡 §7 MUST DO §2：错误信息必须明确缺哪张表，便于运维定位
      throw new BizError(
        'INTERNAL_ERROR' satisfies ErrorCode,
        `[mastra-storage] 缺少表 ${table}，请先 pnpm migrate:up`,
      );
    }
  }
  logger.info('[startup] mastra-storage-ok');
}

/* ============================================================================
 * 4) saveWorkflowSnapshot —— UPSERT
 * ========================================================================== */

/**
 * 写入 / 覆盖 workflow snapshot（任务卡 §7 / §8.2）。
 *
 * 关键决策：
 *   - 实际 DDL `mastra_workflow_snapshot` PK 为 `(workflow_name, run_id)`，**无 status 列**。
 *     本 adapter 把 status 一并塞进 snapshot_json，形态：
 *     `{ "snapshot": <用户传入>, "status": "<RUNNING|SUSPENDED|...>" }`
 *     load 时再拆出 —— 对外 API 严格保持任务卡口径 `{ snapshot, status }`。
 *   - JSON 入库必须 stripUndefinedDeep + JSON.stringify，避免 mysql2 把 undefined 丢字段。
 *   - 用 `CAST(? AS JSON)` 确保 mysql2 binary protocol 把字符串识别为 JSON 列值，
 *     落库后 SHOW CREATE TABLE 时仍是 JSON 类型（而非 LONGTEXT）。
 */
async function saveWorkflowSnapshotImpl(
  pool: MysqlStoragePool,
  args: SaveWorkflowSnapshotArgs,
): Promise<void> {
  const wrapped = { snapshot: args.snapshot, status: args.status };
  const json = JSON.stringify(stripUndefinedDeep(wrapped));

  await pool.execute(
    `INSERT INTO mastra_workflow_snapshot (workflow_name, run_id, snapshot_json, updated_at)
     VALUES (?, ?, CAST(? AS JSON), NOW(3))
     ON DUPLICATE KEY UPDATE
       snapshot_json = VALUES(snapshot_json),
       updated_at    = VALUES(updated_at)`,
    [args.workflowId, args.runId, json],
  );
}

/* ============================================================================
 * 5) loadWorkflowSnapshot —— SELECT 单行
 * ========================================================================== */

/**
 * 按 runId 查最新 snapshot；多个 workflow_name 同 runId 时取 updated_at 最新一条。
 *
 * @returns `{ snapshot, status }` 或 `null`
 */
async function loadWorkflowSnapshotImpl(
  pool: MysqlStoragePool,
  args: LoadWorkflowSnapshotArgs,
): Promise<WorkflowSnapshotLoadResult | null> {
  const [rows] = await pool.query<{ snapshot_json: unknown }>(
    `SELECT snapshot_json
       FROM mastra_workflow_snapshot
      WHERE run_id = ?
      ORDER BY updated_at DESC
      LIMIT 1`,
    [args.runId],
  );
  if (rows.length === 0) return null;
  const first = rows[0];
  if (!first) return null;
  const wrapped = parseJsonColumn(first.snapshot_json) as
    | { snapshot?: unknown; status?: unknown }
    | null;
  if (!wrapped || typeof wrapped !== 'object') {
    // 历史脏数据兜底：snapshot_json 不是合法对象时返回 null（不抛错），
    // 与 appendEvent 的鲁棒性原则一致 —— Mastra 期望 storage 鲁棒。
    return null;
  }
  return {
    snapshot: wrapped.snapshot ?? null,
    status: typeof wrapped.status === 'string' ? wrapped.status : '',
  };
}

/* ============================================================================
 * 6) appendEvent —— 失败仅 pino error 不阻断
 * ========================================================================== */

/**
 * 追加 workflow event；任务卡 §7 MUST DO §5：失败必须**不阻断 workflow**，仅 pino error。
 *
 * 设计动机：
 *   - 事件流是观测信号，不是业务真相单源。DB 抖动 / 暂时不可达不应让正在运行的 workflow 失败。
 *   - 业务真相落 replenishment_draft / agent_skill_run_log 等业务表（切片 13 / 21），
 *     与本表互不替代。
 */
async function appendEventImpl(pool: MysqlStoragePool, args: AppendEventArgs): Promise<void> {
  try {
    const json = JSON.stringify(stripUndefinedDeep(args.payload));
    await pool.execute(
      `INSERT INTO mastra_workflow_event
         (workflow_name, run_id, step_id, event_type, payload_json, created_at)
       VALUES (?, ?, ?, ?, CAST(? AS JSON), NOW(3))`,
      [args.workflowId, args.runId, args.stepId, args.eventType, json],
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        runId: args.runId,
        stepId: args.stepId,
        eventType: args.eventType,
      },
      '[mastra-storage] appendEvent failed (non-blocking)',
    );
    // 不抛错；事件是观测，不是业务真相。
  }
}

/* ============================================================================
 * 7) listEvents —— NOOP 兜底返回 []
 * ========================================================================== */

/**
 * V1 不消费事件流读取（运维侧通过 `mastra_workflow_event` 表直接 SQL 查），
 * 故任务卡 §7 §1 表口径直接 NOOP 返回 []。
 *
 * 不查 DB → 不会因 DB 抖动让 workflow 跑挂；与 appendEvent 鲁棒性原则同源。
 */
function listEventsImpl(_args: ListEventsArgs): Promise<unknown[]> {
  void _args;
  return Promise.resolve([]);
}

/* ============================================================================
 * 8) saveSuspendPayload —— UPSERT
 * ========================================================================== */

/**
 * 写入 / 覆盖 HITL suspend payload；PK = (run_id, step_id)。
 *
 * - 同 (run_id, step_id) 二次调用 → 更新 payload_json（覆盖旧值）。
 * - expires_at 由 DDL DEFAULT 自动填 30 分钟（与 SUSPEND_TTL_MINUTES env 一致）；
 *   ON DUPLICATE KEY UPDATE 时也刷新 expires_at（重新挂起视为延长 TTL）。
 */
async function saveSuspendPayloadImpl(
  pool: MysqlStoragePool,
  runId: string,
  stepId: string,
  payload: unknown,
): Promise<void> {
  const json = JSON.stringify(stripUndefinedDeep(payload));
  await pool.execute(
    `INSERT INTO mastra_workflow_suspend
       (run_id, step_id, payload_json, expires_at, created_at)
     VALUES (?, ?, CAST(? AS JSON), NOW(3) + INTERVAL 30 MINUTE, NOW(3))
     ON DUPLICATE KEY UPDATE
       payload_json = VALUES(payload_json),
       expires_at   = VALUES(expires_at)`,
    [runId, stepId, json],
  );
}

/* ============================================================================
 * 9) loadSuspendPayload —— 取最新一条
 * ========================================================================== */

/**
 * 取 runId 对应的最新 suspend payload；多 step_id 时按 created_at DESC 取首条。
 *
 * @returns `{ stepId, payload }` 或 `null`
 */
async function loadSuspendPayloadImpl(
  pool: MysqlStoragePool,
  runId: string,
): Promise<SuspendPayloadLoadResult | null> {
  const [rows] = await pool.query<{ step_id: string; payload_json: unknown }>(
    `SELECT step_id, payload_json
       FROM mastra_workflow_suspend
      WHERE run_id = ?
      ORDER BY created_at DESC
      LIMIT 1`,
    [runId],
  );
  if (rows.length === 0) return null;
  const first = rows[0];
  if (!first) return null;
  return {
    stepId: first.step_id,
    payload: parseJsonColumn(first.payload_json),
  };
}

/* ============================================================================
 * 10) deleteSuspendPayload —— resume 完成后清理
 * ========================================================================== */

/**
 * 清空指定 runId 的所有 suspend 行（任务卡 §7 §1 表："resume 后清理"）。
 *
 * 必须存在该方法 —— 任务卡 §7 MUST DO §1：「不能少 deleteSuspendPayload」。
 * 缺它会让 suspend 表无界增长；TTL 兜底仅在切片 16 cron 才生效，平时 resume
 * 成功路径必须主动清理。
 */
async function deleteSuspendPayloadImpl(pool: MysqlStoragePool, runId: string): Promise<void> {
  await pool.execute(`DELETE FROM mastra_workflow_suspend WHERE run_id = ?`, [runId]);
}

/* ============================================================================
 * 11) Memory NOOP 双保险（红线 3）
 * ========================================================================== */

/**
 * Mastra Memory V1 关闭（任务卡 §7 MUST DO §1 / §8.3 红线 3 双保险）：
 *   - 第一道：mastra/index.ts `new Mastra({...})` 不传 memory（V1 关闭）；
 *   - 第二道：本 adapter saveMemory / loadMemory 显式抛 NOT_IMPLEMENTED_IN_V1，
 *     防止任何其它路径误开 Memory（双源真相隐患）。
 */
function memoryNotImplemented(): Promise<never> {
  return Promise.reject(
    new BizError(
      'NOT_IMPLEMENTED_IN_V1' satisfies ErrorCode,
      'Mastra Memory disabled in V1',
    ),
  );
}

/* ============================================================================
 * 12) JSON 列解析（mysql2 行为差异兼容）
 * ========================================================================== */

/**
 * 把 JSON 列读出值统一成 plain JS 对象。
 *
 * mysql2 的行为差异：
 *   - 默认 mysql2 driver 会自动把 JSON 列 parse 成对象 → 直接返回；
 *   - 部分驱动 / 透传场景 / Connector/J 兼容模式下返回字符串 → 这里做 JSON.parse 兜底；
 *   - 非合法 JSON 字符串 → 返回 null（兜底，不抛错）。
 */
function parseJsonColumn(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  }
  return v;
}
