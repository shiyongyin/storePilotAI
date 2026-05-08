/**
 * 切片 13 — DraftManager（状态机 + 30 分钟过期 + 5 分钟兜底索引 + 跨租户硬隔离）
 *
 * 严格按 docs/tanks/13-safety-draft-manager.md §7-§8 + F-业务安全层.md §T-SAFETY-02.5 落地。
 *
 * 公开能力：
 *   - {@link assertDraftTransitAllowed}：7 状态 + 4 终态状态机校验。
 *   - {@link create}：INSERT replenishment_draft；items 走 `JSON.stringify(stripUndefinedDeep)`；
 *     `expires_at = NOW(3) + INTERVAL 30 MINUTE`；DB 默认值同时托底（切片 03 DDL）。
 *   - {@link getByIdStrict}：跨租户硬隔离查询（`WHERE merchant_id = ? AND store_id = ?`）。
 *   - {@link findRecentDraft}：5 分钟兜底索引（命中 idx_draft_tenant_recent）。
 *   - {@link transit}：状态机校验 + 乐观并发保护（affectedRows=0 抛 SCHEMA_FAIL）。
 *   - {@link markSubmitted}：CONFIRMED→SUBMITTED 幂等（同 poNo 无操作；不同 poNo 抛 DRAFT_ALREADY_SUBMITTED）。
 *
 * 强约束（违反即拒收）：
 *   - 所有读 / 写 SQL 都必须带 `merchant_id = ? AND store_id = ?` WHERE 条件（防跨租户）。
 *   - 任意状态流转都必须经 {@link assertDraftTransitAllowed}（不得 UPDATE status 跳过状态机）。
 *   - 终态（SUBMITTED / EXPIRED / CANCELLED / FAILED）`TRANSITIONS.get(终态) = []`，不得再流转。
 *   - 短事务边界：本文件不包含显式事务启动 SQL，也不得等待上游模型 / 工具调用。
 *     §9 步骤 9 grep 守门会扫描事务关键字与上游调用关键字。
 *   - items JSON 必须 `JSON.stringify(stripUndefinedDeep(items))`，不得用 markdown 反解析。
 *
 * 设计决策（DI 注入 Pool）：
 *   切片 13 落地时切片 20 尚未接入真实 mysql2 pool；本模块通过 {@link setDraftPool} / {@link getDraftPool}
 *   做单例注入，与 strategy-engine 的 loader 注入模式保持一致。生产由 server bootstrap（切片 20）
 *   注入 mysql2 Pool；测试在 beforeEach 注入 in-memory fake pool（保留 SQL 字符串与参数痕迹用于断言）。
 *
 * 引用：
 *   - 任务卡 docs/tanks/13-safety-draft-manager.md §7-§9
 *   - F-业务安全层.md §T-SAFETY-02.5
 *   - migrations/002-init-replenishment.sql（DraftStatus + idx_draft_tenant_recent）
 *   - shared-contracts/drafts.ts（DraftStatus / DraftItem / ReplenishmentDraft SSOT）
 */
import { randomBytes } from 'node:crypto';

import { BizError, type DraftItem, type DraftStatus } from '@storepilot/shared-contracts';

import type { AgentRuntime, RuntimeContext } from '../mastra/runtime-context.js';

/* ============================================================================
 * 1) 状态机
 * ========================================================================== */

/**
 * Draft 状态流转表（任务卡 §8.1）。
 *
 * 7 状态、4 终态：
 *   - DRAFT          → WAIT_CONFIRM / CANCELLED / EXPIRED
 *   - WAIT_CONFIRM   → CONFIRMED / CANCELLED / EXPIRED
 *   - CONFIRMED      → SUBMITTED / FAILED / CANCELLED
 *   - SUBMITTED / EXPIRED / CANCELLED / FAILED → []（终态，禁止再流转）
 */
export const TRANSITIONS: ReadonlyMap<DraftStatus, readonly DraftStatus[]> = new Map<
  DraftStatus,
  readonly DraftStatus[]
>([
  ['DRAFT', ['WAIT_CONFIRM', 'CANCELLED', 'EXPIRED']],
  ['WAIT_CONFIRM', ['CONFIRMED', 'CANCELLED', 'EXPIRED']],
  ['CONFIRMED', ['SUBMITTED', 'FAILED', 'CANCELLED']],
  ['SUBMITTED', []],
  ['EXPIRED', []],
  ['CANCELLED', []],
  ['FAILED', []],
]);

/**
 * 4 个终态集合（用于 markSubmitted / transit 边界检查）。
 */
export const TERMINAL_STATUSES: ReadonlySet<DraftStatus> = new Set<DraftStatus>([
  'SUBMITTED',
  'EXPIRED',
  'CANCELLED',
  'FAILED',
]);

/**
 * 状态机校验（任务卡 §7 MUST DO §1）。
 *
 * @param from 当前状态
 * @param to 目标状态
 * @throws BizError(SCHEMA_FAIL) 非法流转 / 终态再流转
 */
export function assertDraftTransitAllowed(from: DraftStatus, to: DraftStatus): void {
  const allowed = TRANSITIONS.get(from);
  if (!allowed?.includes(to)) {
    throw new BizError('SCHEMA_FAIL', `非法状态流转 ${from} -> ${to}`);
  }
}

/* ============================================================================
 * 2) Pool DI（与 strategy-engine 同模式）
 * ========================================================================== */

/**
 * Draft 模块依赖的最小 Pool 抽象（mysql2/promise.Pool 的子集）。
 *
 * - {@link query}：返回 `[rows, fields]` 形式（mysql2 风格），rows 为 plain object。
 * - {@link execute}：返回 `[ResultSetHeader, fields]` 形式，仅取 `affectedRows`。
 *
 * 生产以 `import { Pool } from 'mysql2/promise'` 注入；测试用 in-memory fake 注入。
 */
export interface DraftPool {
  query<T extends Record<string, unknown>>(
    sql: string,
    params: readonly unknown[],
  ): Promise<[T[], unknown]>;
  execute(
    sql: string,
    params: readonly unknown[],
  ): Promise<[{ affectedRows: number }, unknown]>;
}

let registeredPool: DraftPool | null = null;

/**
 * 注入全局 DraftPool 实例。
 *
 * - 生产：由切片 20 在 server bootstrap 完成 mysql2 pool 创建后调用一次。
 * - 测试：每个 beforeEach 注入 fake pool；afterEach 调用 {@link resetDraftManagerForTest} 清理。
 */
export function setDraftPool(pool: DraftPool): void {
  registeredPool = pool;
}

/**
 * 测试辅助：清空已注册的 pool，避免用例间相互污染。
 */
export function resetDraftManagerForTest(): void {
  registeredPool = null;
}

/**
 * 取注册的 pool。未注册抛错，防止生产忘记 bootstrap。
 */
function getDraftPool(): DraftPool {
  if (!registeredPool) {
    throw new BizError(
      'INTERNAL_ERROR',
      'DraftPool 未注入；请在 bootstrap 期调用 setDraftPool(pool) 或在调用处显式传入。',
    );
  }
  return registeredPool;
}

/**
 * 公开取池（供同切片 jobs/expire-drafts.ts 共享同一连接池）。
 *
 * 注意：仅 jobs/* 与 manager 内部使用；外部 Skill / Workflow 必须通过本文件提供的
 * {@link create} / {@link transit} / {@link markSubmitted} 等公开 API 访问 DB，
 * 不得直接拿池绕过状态机。
 */
export function getRegisteredDraftPool(): DraftPool {
  return getDraftPool();
}

/**
 * 仅供单测的内部 helper 暴露窗口（如有需要）；占位以便 jobs/* 跨文件 import 不变。
 *
 * @internal
 */
export const __testInternals = {
  /** 让单测可读取注册的 pool 以做断言（非生产 API） */
  getRegisteredPool: (): DraftPool | null => registeredPool,
};

/* ============================================================================
 * 3) 工具：stripUndefinedDeep + items 序列化
 * ========================================================================== */

/**
 * 深度剥离 `undefined` 字段 / 数组元素。
 *
 * 与 docs/tanks/07-mastra-mysql-storage.md §8.4 同语义；切片 07 落地真正 storage 时
 * 会复用本仓库版本（届时可重构为 shared util）。本切片就地实现以避免与切片 07 互锁。
 *
 * 规则：
 *   - undefined → 跳过（数组中也跳过；与 JSON.stringify 行为一致但提前剥离）
 *   - null      → 保留（与 undefined 区分）
 *   - 普通对象 → 递归
 *   - 其它（number/string/boolean/Date/Buffer/...）→ 原样返回
 *
 * @param v 任意值
 * @returns 剥离 undefined 后的同结构值
 */
export function stripUndefinedDeep<T>(v: T): T {
  return stripUndefinedDeepInner(v) as T;
}

function stripUndefinedDeepInner(v: unknown): unknown {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const x of v) {
      const stripped = stripUndefinedDeepInner(x);
      if (stripped !== undefined) out.push(stripped);
    }
    return out;
  }
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const stripped = stripUndefinedDeepInner(x);
      if (stripped !== undefined) out[k] = stripped;
    }
    return out;
  }
  return v;
}

/* ============================================================================
 * 4) 行解析（DB row → ReplenishmentDraft 视图对象）
 * ========================================================================== */

/**
 * `replenishment_draft` 表的原始行形态（snake_case，按 mysql2 默认行为）。
 *
 * `items` 在 mysql2 中读取 JSON 列时通常返回已 parse 后的 object/array；
 * 但部分驱动 / 透传场景可能返回字符串，这里做兼容解析。
 */
export interface DraftRow extends Record<string, unknown> {
  draft_id: string;
  session_id: string;
  merchant_id: string;
  store_id: string;
  user_id: string;
  trace_id: string;
  forecast_days: number;
  status: DraftStatus;
  items: DraftItem[] | string;
  strategy_version: string;
  submitted_po_no: string | null;
  expires_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * 业务层 ReplenishmentDraft 视图（camelCase；与 shared-contracts/drafts.ts ReplenishmentDraft 字段对齐，
 * 但本切片不强制 Zod parse — 上游调用方按需 parse；保留 `Date` / `string` 双形便于跨 driver）。
 */
export interface DraftView {
  draftId: string;
  sessionId: string;
  merchantId: string;
  storeId: string;
  userId: string;
  traceId: string;
  forecastDays: number;
  status: DraftStatus;
  items: DraftItem[];
  strategyVersion: string;
  submittedPoNo: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 把 DB 行转为业务视图。`items` 列同时兼容字符串（旧驱动 / TEXT 场景）与 array。
 */
export function parseDraftRow(row: DraftRow): DraftView {
  let items: DraftItem[];
  if (typeof row.items === 'string') {
    try {
      const parsed = JSON.parse(row.items) as unknown;
      items = Array.isArray(parsed) ? (parsed as DraftItem[]) : [];
    } catch {
      items = [];
    }
  } else {
    items = row.items;
  }

  return {
    draftId: row.draft_id,
    sessionId: row.session_id,
    merchantId: row.merchant_id,
    storeId: row.store_id,
    userId: row.user_id,
    traceId: row.trace_id,
    forecastDays: row.forecast_days,
    status: row.status,
    items,
    strategyVersion: row.strategy_version,
    submittedPoNo: row.submitted_po_no,
    expiresAt: toIsoString(row.expires_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function toIsoString(v: Date | string): string {
  if (v instanceof Date) return v.toISOString();
  return v;
}

/* ============================================================================
 * 5) draftId 生成（drf_ + 24 hex chars，符合 ReplenishmentDraft.draftId 正则）
 * ========================================================================== */

/**
 * 生成符合 `^drf_[a-z0-9]{16,32}$`（切片 04 ReplenishmentDraft）的 draftId。
 *
 * 实现细节：
 *   - 12 字节随机 → 24 hex 字符（满足 16..32 的硬约束）
 *   - 不依赖 ulid（项目已用 ulid 但 ulid 含大写；本字段限定小写）
 */
export function newDraftId(): string {
  return `drf_${randomBytes(12).toString('hex')}`;
}

/* ============================================================================
 * 6) 公开操作：create / getByIdStrict / findRecentDraft / transit / markSubmitted
 * ========================================================================== */

/**
 * 创建 Draft（任务卡 §8.4 / §7 MUST DO §7-§8）。
 *
 * 关键点：
 *   - 应用层兜底设置 `expires_at = NOW(3) + INTERVAL 30 MINUTE`（DDL 也有 DEFAULT，双保险）。
 *   - items 通过 `JSON.stringify(stripUndefinedDeep(items))` 后用 `CAST(? AS JSON)` 入库，
 *     避免 mysql2 把字符串再转义；不允许 markdown 反解析。
 *   - 跨租户硬隔离：merchantId / storeId 由调用方从 RuntimeContext 取出后显式传参，
 *     便于 server bootstrap 链路审计；本函数 INSERT 行的 merchant/store/user 与参数一致。
 *
 * @returns 新建的 DraftView（再次 SELECT 由调用方按需做；本函数返回内存视图避免短事务边界外读）
 */
export async function create(args: {
  sessionId: string;
  merchantId: string;
  storeId: string;
  userId: string;
  traceId: string;
  forecastDays: number;
  items: DraftItem[];
  strategyVersion: string;
}): Promise<DraftView> {
  const pool = getDraftPool();
  const draftId = newDraftId();
  const itemsJson = JSON.stringify(stripUndefinedDeep(args.items));

  await pool.execute(
    `INSERT INTO replenishment_draft
       (draft_id, session_id, merchant_id, store_id, user_id, trace_id,
        forecast_days, status, items, strategy_version, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', CAST(? AS JSON), ?, NOW(3) + INTERVAL 30 MINUTE)`,
    [
      draftId,
      args.sessionId,
      args.merchantId,
      args.storeId,
      args.userId,
      args.traceId,
      args.forecastDays,
      itemsJson,
      args.strategyVersion,
    ],
  );

  // 内存视图：避免对刚 INSERT 的行再走一次 SELECT（短事务边界更易守门）。
  // 实际 created_at / updated_at / expires_at 由 DB 默认值生成；这里返回应用层近似 ISO 串，
  // 调用方需要权威值时应再调用 getByIdStrict。
  const nowIso = new Date().toISOString();
  const expiresIso = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  return {
    draftId,
    sessionId: args.sessionId,
    merchantId: args.merchantId,
    storeId: args.storeId,
    userId: args.userId,
    traceId: args.traceId,
    forecastDays: args.forecastDays,
    status: 'DRAFT',
    items: args.items,
    strategyVersion: args.strategyVersion,
    submittedPoNo: null,
    expiresAt: expiresIso,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/**
 * 跨租户硬隔离的 Draft 查询（任务卡 §8.2 / §7 MUST DO §2）。
 *
 * - WHERE 必须同时带 merchant_id / store_id，仅命中租户自己的行。
 * - 找不到 → BizError(DRAFT_NOT_FOUND)（不能返回 null，避免上游忘做空判把跨租户回填漏出）。
 *
 * @throws BizError(DRAFT_NOT_FOUND) 当 draftId 不存在 / 跨租户 / 已删除
 */
export async function getByIdStrict(
  draftId: string,
  runtimeContext: RuntimeContext<AgentRuntime>,
): Promise<DraftView> {
  const pool = getDraftPool();
  const merchantId = runtimeContext.get('merchantId');
  const storeId = runtimeContext.get('storeId');

  const [rows] = await pool.query<DraftRow>(
    `SELECT draft_id, session_id, merchant_id, store_id, user_id, trace_id,
            forecast_days, status, items, strategy_version,
            submitted_po_no, expires_at, created_at, updated_at
       FROM replenishment_draft
      WHERE draft_id = ? AND merchant_id = ? AND store_id = ?
      LIMIT 1`,
    [draftId, merchantId, storeId],
  );

  const row = rows[0];
  if (!row) {
    throw new BizError('DRAFT_NOT_FOUND', '草稿不存在', {
      meta: { draftId, merchantId, storeId },
    });
  }
  return parseDraftRow(row);
}

/**
 * 5 分钟兜底索引：sessionId 漂移时按 (merchantId + storeId + userId + created_at) 找最近未提交草稿。
 *
 * 关键约束（任务卡 §7 MUST DO §3 / §8.3）：
 *   - WHERE 带 merchantId / storeId / userId（命中 idx_draft_tenant_recent）。
 *   - status IN ('DRAFT','WAIT_CONFIRM','CONFIRMED')：终态草稿不参与漂移恢复。
 *   - created_at > NOW(3) - INTERVAL ? MINUTE：5 分钟窗口（默认 5，可调，但不超过 30）。
 *   - ORDER BY created_at DESC LIMIT 5：恢复最近 5 条，UI 由上层选择。
 *
 * @returns 命中条目数组（可能为空）
 */
export async function findRecentDraft(
  runtimeContext: RuntimeContext<AgentRuntime>,
  withinMinutes = 5,
): Promise<DraftView[]> {
  const pool = getDraftPool();
  const [rows] = await pool.query<DraftRow>(
    `SELECT draft_id, session_id, merchant_id, store_id, user_id, trace_id,
            forecast_days, status, items, strategy_version,
            submitted_po_no, expires_at, created_at, updated_at
       FROM replenishment_draft
      WHERE merchant_id = ? AND store_id = ? AND user_id = ?
        AND status IN ('DRAFT', 'WAIT_CONFIRM', 'CONFIRMED')
        AND created_at > NOW(3) - INTERVAL ? MINUTE
      ORDER BY created_at DESC
      LIMIT 5`,
    [
      runtimeContext.get('merchantId'),
      runtimeContext.get('storeId'),
      runtimeContext.get('userId'),
      withinMinutes,
    ],
  );
  return rows.map(parseDraftRow);
}

/**
 * 状态流转 + 乐观并发保护（任务卡 §8.4 / §7 MUST DO §1）。
 *
 * 流程：
 *   1. {@link assertDraftTransitAllowed} 校验状态机（含 4 终态拒绝）。
 *   2. UPDATE ... WHERE merchant_id=? AND store_id=? AND status=from（同时承担乐观锁与跨租户硬隔离）。
 *   3. affectedRows=0 → BizError(SCHEMA_FAIL)：可能并发 / 不存在 / 跨租户。
 *
 * 注：本函数不开 DB 事务（短事务边界 §7 MUST DO §5；跨表写由调用方在更外层组合）。
 */
export async function transit(args: {
  draftId: string;
  from: DraftStatus;
  to: DraftStatus;
  runtimeContext: RuntimeContext<AgentRuntime>;
}): Promise<void> {
  assertDraftTransitAllowed(args.from, args.to);

  const pool = getDraftPool();
  const merchantId = args.runtimeContext.get('merchantId');
  const storeId = args.runtimeContext.get('storeId');

  const [result] = await pool.execute(
    `UPDATE replenishment_draft
        SET status = ?, updated_at = NOW(3)
      WHERE draft_id = ? AND merchant_id = ? AND store_id = ? AND status = ?`,
    [args.to, args.draftId, merchantId, storeId, args.from],
  );

  if (result.affectedRows === 0) {
    throw new BizError(
      'SCHEMA_FAIL',
      '状态流转失败：可能已被并发修改 / 草稿不存在 / 跨租户',
      { meta: { draftId: args.draftId, from: args.from, to: args.to } },
    );
  }
}

/**
 * 更新 Draft items（切片 15 调整 Skill 用；保持 status 不变）。
 *
 * 关键约束：
 *   - WHERE 必须带 merchant_id / store_id（跨租户硬隔离，与 getByIdStrict 一致）。
 *   - 仅当 status ∈ {DRAFT, WAIT_CONFIRM, CONFIRMED}（即非终态）允许 update；
 *     EXPIRED / SUBMITTED / CANCELLED / FAILED 不得修改 items（§7 MUST NOT §4）。
 *   - items 通过 `JSON.stringify(stripUndefinedDeep(items))` + `CAST(? AS JSON)` 入库。
 *   - 不开启 DB 事务（短事务边界）；调用方在 workflow 层组合"更新 items + 写 adjustment_log"。
 *   - 无副作用：updated_at 由 DB 自动刷新（ON UPDATE CURRENT_TIMESTAMP(3)）；同时显式 SET 兜底
 *     非 ON UPDATE 配置的环境。
 *
 * @returns affectedRows（0 表示草稿不存在 / 跨租户 / 已是终态；调用方需要兜底）
 */
export async function updateItems(args: {
  draftId: string;
  items: DraftItem[];
  runtimeContext: RuntimeContext<AgentRuntime>;
}): Promise<number> {
  const pool = getDraftPool();
  const merchantId = args.runtimeContext.get('merchantId');
  const storeId = args.runtimeContext.get('storeId');
  const itemsJson = JSON.stringify(stripUndefinedDeep(args.items));

  const [result] = await pool.execute(
    `UPDATE replenishment_draft
        SET items = CAST(? AS JSON), updated_at = NOW(3)
      WHERE draft_id = ? AND merchant_id = ? AND store_id = ?
        AND status IN ('DRAFT', 'WAIT_CONFIRM', 'CONFIRMED')`,
    [itemsJson, args.draftId, merchantId, storeId],
  );
  return result.affectedRows;
}

/**
 * CONFIRMED → SUBMITTED 幂等提交（任务卡 §8.4 / §7 MUST DO §6）。
 *
 * 幂等语义：
 *   - 已经 SUBMITTED 且 submitted_po_no 与入参一致 → 无操作（直接 return）。
 *   - 已经 SUBMITTED 但 submitted_po_no 不同 → BizError(DRAFT_ALREADY_SUBMITTED)。
 *   - 未 CONFIRMED → 状态机断言失败（SCHEMA_FAIL）。
 *
 * 注：本函数读一次 + 写一次；为保证语义一致，写入 WHERE 仍带 status='CONFIRMED'，
 * 防止"先读后写"窗口内被其它路径流转。
 */
export async function markSubmitted(
  draftId: string,
  purchaseOrderNo: string,
  runtimeContext: RuntimeContext<AgentRuntime>,
): Promise<void> {
  const draft = await getByIdStrict(draftId, runtimeContext);

  // 幂等：同 poNo 已存在 → 无操作
  if (draft.status === 'SUBMITTED' && draft.submittedPoNo === purchaseOrderNo) return;

  // 不同 poNo 已存在 → 抛错（任务卡 §7 MUST NOT §7）
  if (draft.submittedPoNo && draft.submittedPoNo !== purchaseOrderNo) {
    throw new BizError(
      'DRAFT_ALREADY_SUBMITTED',
      `已存在采购单 ${draft.submittedPoNo}`,
      { meta: { draftId, existingPoNo: draft.submittedPoNo, newPoNo: purchaseOrderNo } },
    );
  }

  // 状态机校验（防止 CONFIRMED 之外的状态进入 SUBMITTED）
  assertDraftTransitAllowed(draft.status, 'SUBMITTED');

  const pool = getDraftPool();
  const [result] = await pool.execute(
    `UPDATE replenishment_draft
        SET status = 'SUBMITTED', submitted_po_no = ?, updated_at = NOW(3)
      WHERE draft_id = ? AND merchant_id = ? AND store_id = ? AND status = 'CONFIRMED'`,
    [
      purchaseOrderNo,
      draftId,
      runtimeContext.get('merchantId'),
      runtimeContext.get('storeId'),
    ],
  );

  if (result.affectedRows === 0) {
    // 并发场景：getByIdStrict 时是 CONFIRMED，但 UPDATE 之间被其他路径流转走了。
    // 抛 SCHEMA_FAIL 让上层重试 / 兜底（与 transit 一致）。
    throw new BizError(
      'SCHEMA_FAIL',
      '状态流转失败：CONFIRMED → SUBMITTED 期间被并发修改',
      { meta: { draftId, purchaseOrderNo } },
    );
  }
}
