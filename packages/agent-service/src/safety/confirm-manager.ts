/**
 * 切片 16 — ConfirmManager（HITL 网关 + 5 种边界 + resume 锁）
 *
 * 严格按 docs/tanks/16-safety-confirm-manager-hitl.md §6-§9 + F-业务安全层.md §T-SAFETY-03.5 落地。
 *
 * 公开能力（任务卡 §7 MUST DO §1）：
 *   - {@link tickAtUserMessage}：每条用户消息进入桥接层 dispatch **前**调用一次。
 *     - active_run_id 为空 → NONE（无挂起）
 *     - active_run_expires_at 已过 → 调 cancelInflight EXPIRED → 返回 EXPIRED（边界 2）
 *     - intent 不属于 CONFIRM_xx / CANCEL_xx → 调 cancelInflight PREEMPT → 返回 CANCELLED（边界 1）
 *     - 其它（CONFIRM/CANCEL intent）→ NONE（resume 由 confirmDraft 处理）
 *   - {@link confirmDraft}：用户说"确认创建采购单"时调用。
 *     - 边界 5：sessionId 漂移 → DraftManager.findRecentDraft 兜底找回最近草稿
 *     - 边界 3 / 4：FOR UPDATE + resume_locked_at 10s 排他锁；并发第二条命中 RESUME_RACE
 *     - 严格遵守"先 COMMIT 释放锁租约 → 再 await mastra.resume"（不在事务内 await Mastra）
 *     - try { await resume } finally { UPDATE resume_locked_at = NULL } 锁释放保护
 *   - {@link cancelInflight}：USER_CANCEL / PREEMPT / ABORT / EXPIRED 四种语义统一收口。
 *     - 尽力 mastra.resume({ decision: 'CANCEL', reason })（错误 swallow）
 *     - DELETE 全部 suspend 行 + UPDATE agent_session 清 active_run_*
 *
 * 强约束（违反即拒收）：
 *   - MUST：3 公开方法签名（任务卡 §7 表）
 *   - MUST：tickAtUserMessage 必须在桥接层 dispatch **之前**调用（由 server.ts 钩 chat-completions
 *     pre-dispatch hook 实现）
 *   - MUST：resume 锁 FOR UPDATE + resume_locked_at 10s 自动释放
 *   - MUST：try { resume } finally { UPDATE NULL } 锁释放保护
 *   - MUST：5 种边界全覆盖
 *   - MUST：抢占（PREEMPT）在桥接层 markdown 顶加"已为您取消上一次的待确认采购单"
 *     （提示文本注入由 chat-completions 完成，本文件返回 kind=CANCELLED 告知）
 *   - MUST：边界 5 用 DraftManager.findRecentDraft(runtimeContext, 5) 兜底
 *   - MUST NOT：跳过 DraftManager 直接读写 draft 表
 *   - MUST NOT：在事务内 await mastra.resume（事务必须先 COMMIT 释放锁租约）
 *   - MUST NOT：让"重复确认"创建多个采购单（RESUME_RACE 必须返回幂等）
 *   - MUST NOT：让多实例并发 resume 同 runId（FOR UPDATE 守门）
 *
 * DI（与 draft-manager / strategy-engine 一致）：
 *   - {@link setConfirmManagerPool}：注入支持事务的 ConfirmManagerPool（生产由 server bootstrap）
 *   - {@link setMastraResolver}：注入 MastraResolver（getWorkflow(id).resume({...})）
 *   - 测试在 beforeEach 注入 fake；afterEach 调 {@link resetConfirmManagerForTest} 清理
 *
 * 引用：
 *   - 任务卡 docs/tanks/16-safety-confirm-manager-hitl.md
 *   - F-业务安全层.md §T-SAFETY-03.5（5 边界 / resume 锁 / 5 分钟 cron 全文）
 *   - 切片 03（agent_session 5 个 HITL 字段 + idx_active_run）
 *   - 切片 04（SUSPEND_NOT_FOUND / SUSPEND_EXPIRED / USER_CANCELLED / RESUME_RACE）
 *   - 切片 06（RuntimeContext + AgentRuntime 7 字段）
 *   - 切片 07（mastra_workflow_suspend 行管理；资源回收）
 *   - 切片 13（DraftManager.findRecentDraft 兜底）
 */
import {
  BizError,
  Intent,
  type IntentCode,
} from '@storepilot/shared-contracts';

import { logger } from '../observability/logger.js';
import { stripUndefinedDeep } from '../mastra/storage/strip-undefined-deep.js';

import {
  findRecentDraft,
  getByIdStrict,
  transit as transitDraft,
  type DraftView,
} from './draft-manager.js';
import type { AgentRuntime, RuntimeContext } from '../mastra/runtime-context.js';
import { buildRuntimeContext } from '../mastra/runtime-context.js';

/* ============================================================================
 * 1) 公开类型 / 常量
 * ========================================================================== */

/**
 * tickAtUserMessage 返回值（任务卡 §7 表）。
 *
 * - `NONE`：当前无挂起 / 用户意图属于 CONFIRM/CANCEL（由 confirmDraft 处理）
 * - `RESUMED`：保留语义（V1 不在 tick 内 resume；只在 confirmDraft 内 resume）
 * - `CANCELLED`：抢占成功（PREEMPT），桥接层应在 markdown 顶加提示
 * - `EXPIRED`：挂起已过期（边界 2），已对旧 run 发 CANCEL，并清空 active_run_*
 */
export type TickResult =
  | { kind: 'NONE' }
  | { kind: 'RESUMED'; result: unknown }
  | { kind: 'CANCELLED' }
  | { kind: 'EXPIRED' };

/**
 * confirmDraft 返回值（任务卡 §7 表）。
 *
 * - `CONFIRMED`：mastra.resume 成功；result 透传给上层 Skill 链路
 * - `PREVIEW_FIRST`：当前没有 active suspend（即没有 awaiting confirm 的 workflow），
 *   需要先让 Skill 走 preview 流程；preview 文本由桥接层渲染
 */
export type ConfirmResult =
  | { kind: 'CONFIRMED'; result: unknown }
  | { kind: 'PREVIEW_FIRST'; preview: string };

/**
 * cancelInflight 的取消原因（任务卡 §7 表）。
 *
 * - USER_CANCEL：用户主动说"取消"
 * - PREEMPT：用户带着挂起说别的（边界 1）
 * - ABORT：桥接层 onAbort（连接断开）
 * - EXPIRED：30 分钟过期（tick 内 / cron 内）
 */
export type CancelReason = 'USER_CANCEL' | 'PREEMPT' | 'ABORT' | 'EXPIRED';

/**
 * resume 锁的租约毫秒数（任务卡 §7 MUST DO §3 + §10 测试场景 8）。
 *
 * 第二条并发请求看到 resume_locked_at 在过去 10 秒内 → 抛 RESUME_RACE 幂等返回。
 * 超过 10 秒视为锁泄漏（前一条 resume 卡死或进程崩溃），下一条请求可继续。
 */
export const RESUME_LOCK_LEASE_MS = 10_000;

/**
 * V1 唯一的 HITL workflow ID。
 *
 * 切片 17 落地 `purchase_order_create` workflow；本切片调用 mastra.getWorkflow() 时使用本常量。
 * 若后续新增 HITL workflow，必须把对应 workflowId 持久化到 agent_session（V2）。
 */
export const HITL_WORKFLOW_ID = 'purchase_order_create';

/**
 * 抢占场景桥接层 markdown 顶部提示（任务卡 §8.5 / §7 MUST DO §7）。
 *
 * 任务卡示例文案（验收 §9 step 9 grep 命中）：
 *   "已为您取消上一次的待确认采购单"
 *
 * 桥接层在 chat-completions.ts 的 PreDispatch hook 中读取本常量；
 * 单测断言 markdown 顶部含本文本（任务卡 §10 测试场景 5）。
 */
export const PREEMPT_MARKDOWN_PREFIX = '（已为您取消上一次的待确认采购单）\n\n';

/* ============================================================================
 * 2) Pool / Tx 抽象（支持事务，与 draft-manager 形状一致）
 * ========================================================================== */

/**
 * 单连接事务接口（PostgreSQL/MySQL pattern）。
 *
 * - 在 transaction(fn) 回调内使用，自动 BEGIN/COMMIT/ROLLBACK 由 pool 实现负责。
 * - query / execute 形态与 ConfirmManagerPool 一致；不允许嵌套事务。
 */
export interface ConfirmTx {
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
 * ConfirmManager 依赖的最小 Pool 抽象。
 *
 * - {@link query} / {@link execute}：与 DraftPool 同形（mysql2/promise.Pool 子集）。
 * - {@link transaction}：BEGIN/COMMIT/ROLLBACK 包装，回调返回值即 transaction 返回值；
 *   回调抛错 → 自动 ROLLBACK，错误向上抛。
 *
 * 生产由 server bootstrap 用 mysql2 Pool 构造（见 setConfirmManagerPool javadoc）；
 * 测试用 in-memory fake 注入。
 */
export interface ConfirmManagerPool {
  query<T extends Record<string, unknown>>(
    sql: string,
    params: readonly unknown[],
  ): Promise<[T[], unknown]>;
  execute(
    sql: string,
    params: readonly unknown[],
  ): Promise<[{ affectedRows: number }, unknown]>;
  transaction<T>(fn: (tx: ConfirmTx) => Promise<T>): Promise<T>;
}

/* ============================================================================
 * 3) MastraResolver 抽象（getWorkflow(id).resume(...)）
 * ========================================================================== */

/**
 * Mastra workflow.resume 入参。
 *
 * 任务卡 §8.3 + 切片 17 的 Workflow.resume 形态：
 *   `mastra.getWorkflow(id).resume({ runId, step, resumeData, runtimeContext })`
 */
export interface WorkflowResumeArgs {
  runId: string;
  step: string;
  resumeData: unknown;
  runtimeContext: RuntimeContext<AgentRuntime>;
}

/**
 * Mastra workflow handle 的最小抽象 —— 仅承诺 resume 方法。
 *
 * @remarks Mastra 1.0 实际形态远超此最小集；本切片只调用 resume，故仅约束这一条。
 */
export interface WorkflowHandle {
  resume(args: WorkflowResumeArgs): Promise<unknown>;
}

/**
 * Mastra 解析器：按 workflowId 拿 WorkflowHandle。
 *
 * 生产由 server bootstrap 注入：
 *   ```ts
 *   setMastraResolver({ getWorkflow: (id) => mastra.getWorkflow(id) as unknown as WorkflowHandle });
 *   ```
 *
 * 测试注入 fake 验证 resume 调用形态、错误处理、幂等。
 */
export interface MastraResolver {
  getWorkflow(workflowId: string): WorkflowHandle;
}

export interface StartPurchaseOrderPreviewArgs {
  draftId: string;
  runtimeContext: RuntimeContext<AgentRuntime>;
}

export interface StartPurchaseOrderPreviewResult {
  runId: string;
  step: string;
  previewMarkdown: string;
  suspendPayload: unknown;
}

export interface PurchaseOrderStarter {
  startPreview(args: StartPurchaseOrderPreviewArgs): Promise<StartPurchaseOrderPreviewResult>;
}

/* ============================================================================
 * 4) DI 注册 / 解注册
 * ========================================================================== */

let registeredPool: ConfirmManagerPool | null = null;
let registeredMastraResolver: MastraResolver | null = null;
let registeredPurchaseOrderStarter: PurchaseOrderStarter | null = null;

/**
 * 注入 ConfirmManagerPool 单例。
 *
 * 生产路径：server bootstrap 创建 mysql2 Pool 后 wrap 为 ConfirmManagerPool 注入一次。
 * 测试路径：每个 beforeEach 注入 fake；afterEach 调 {@link resetConfirmManagerForTest} 清理。
 */
export function setConfirmManagerPool(pool: ConfirmManagerPool): void {
  registeredPool = pool;
}

/**
 * 注入 MastraResolver 单例。
 *
 * 生产由 server bootstrap 完成（拿 `createMastra()` 实例并 wrap）；
 * 测试用 fake resolver 验证 resume 调用 / 错误传播。
 */
export function setMastraResolver(resolver: MastraResolver): void {
  registeredMastraResolver = resolver;
}

export function setPurchaseOrderStarter(starter: PurchaseOrderStarter): void {
  registeredPurchaseOrderStarter = starter;
}

/**
 * 测试辅助：清空注册的 pool / resolver，避免用例间相互污染。
 */
export function resetConfirmManagerForTest(): void {
  registeredPool = null;
  registeredMastraResolver = null;
  registeredPurchaseOrderStarter = null;
}

/**
 * 公开取池（供同切片 jobs/expire-suspended-runs.ts 共享同一连接池）。
 *
 * 注意：仅 jobs/* 与本文件内部使用；外部业务必须通过本文件提供的 3 个公开 API
 * 访问 HITL 状态，不得直接拿池绕过 5 边界保护。
 */
export function getRegisteredConfirmManagerPool(): ConfirmManagerPool {
  if (!registeredPool) {
    throw new BizError(
      'INTERNAL_ERROR',
      'ConfirmManagerPool 未注入；请在 bootstrap 期调用 setConfirmManagerPool(pool)。',
    );
  }
  return registeredPool;
}

/**
 * 公开取 MastraResolver（供同切片 jobs/expire-suspended-runs.ts 共享）。
 */
export function getRegisteredMastraResolver(): MastraResolver {
  if (!registeredMastraResolver) {
    throw new BizError(
      'INTERNAL_ERROR',
      'MastraResolver 未注入；请在 bootstrap 期调用 setMastraResolver(resolver)。',
    );
  }
  return registeredMastraResolver;
}

export function getRegisteredPurchaseOrderStarter(): PurchaseOrderStarter {
  if (!registeredPurchaseOrderStarter) {
    throw new BizError(
      'INTERNAL_ERROR',
      'PurchaseOrderStarter 未注入；请在 bootstrap 期调用 setPurchaseOrderStarter(starter)。',
    );
  }
  return registeredPurchaseOrderStarter;
}

/**
 * 仅供单测：探针获取注册情况，不暴露给生产。
 *
 * @internal
 */
export const __confirmInternals = {
  getPool: (): ConfirmManagerPool | null => registeredPool,
  getMastraResolver: (): MastraResolver | null => registeredMastraResolver,
  getPurchaseOrderStarter: (): PurchaseOrderStarter | null => registeredPurchaseOrderStarter,
};

/* ============================================================================
 * 5) Session 视图（snake_case → camelCase）
 * ========================================================================== */

/**
 * `agent_session` 表的原始行形态（5 HITL 字段，由切片 03 落地）。
 */
export interface AgentSessionRow extends Record<string, unknown> {
  session_id: string;
  merchant_id: string;
  current_store_id: string;
  user_id: string;
  active_run_id: string | null;
  active_run_step: string | null;
  active_run_expires_at: Date | string | null;
  resume_locked_at: Date | string | null;
  active_draft_id: string | null;
}

/**
 * 业务层 SessionView（仅本切片需要；不与 shared-contracts 耦合）。
 */
export interface SessionView {
  sessionId: string;
  merchantId: string;
  storeId: string;
  userId: string;
  activeRunId: string | null;
  activeRunStep: string | null;
  activeRunExpiresAt: Date | null;
  resumeLockedAt: Date | null;
  activeDraftId: string | null;
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  return new Date(v);
}

function parseSessionRow(row: AgentSessionRow): SessionView {
  return {
    sessionId: row.session_id,
    merchantId: row.merchant_id,
    storeId: row.current_store_id,
    userId: row.user_id,
    activeRunId: row.active_run_id,
    activeRunStep: row.active_run_step,
    activeRunExpiresAt: toDate(row.active_run_expires_at),
    resumeLockedAt: toDate(row.resume_locked_at),
    activeDraftId: row.active_draft_id,
  };
}

/**
 * 读取 agent_session 单行（不带 FOR UPDATE，用于 tick / cancel 路径的轻量读）。
 *
 * 不存在 → 返回 null（视为 NONE；tick 直接退出）。
 */
async function loadSession(sessionId: string): Promise<SessionView | null> {
  const pool = getRegisteredConfirmManagerPool();
  const [rows] = await pool.query<AgentSessionRow>(
    `SELECT session_id, merchant_id, current_store_id, user_id,
            active_run_id, active_run_step, active_run_expires_at,
            resume_locked_at, active_draft_id
       FROM agent_session
      WHERE session_id = ?
      LIMIT 1`,
    [sessionId],
  );
  const row = rows[0];
  if (!row) return null;
  return parseSessionRow(row);
}

/* ============================================================================
 * 6) Intent 抢占判定
 * ========================================================================== */

/**
 * 判断 intent 是否属于 CONFIRM/CANCEL 家族（不触发抢占）。
 *
 * 对应任务卡 §8.2 / §7 MUST DO §1：
 *   - CONFIRM_CREATE_PURCHASE_ORDER：用户回"确认"，由 confirmDraft 处理
 *   - CANCEL_REPLENISHMENT_DRAFT：用户回"取消"，由 confirmDraft / cancelInflight 处理
 *
 * 其它任意 intent（包括 UNKNOWN / GENERAL_QA / 其它业务意图）→ 视为抢占（边界 1）。
 */
export function isHitlConfirmFamily(intent: IntentCode): boolean {
  return (
    intent === Intent.CONFIRM_CREATE_PURCHASE_ORDER ||
    intent === Intent.CANCEL_REPLENISHMENT_DRAFT
  );
}

/* ============================================================================
 * 7) tickAtUserMessage —— 桥接层 dispatch 之前调用
 * ========================================================================== */

/**
 * tickAtUserMessage 入参（任务卡 §7 表）。
 */
export interface TickAtUserMessageArgs {
  sessionId: string;
  userIntent: IntentCode;
  runtimeContext: RuntimeContext<AgentRuntime>;
}

/**
 * 处理用户每条消息，决定是否需要对挂起的 HITL run 做 EXPIRED / PREEMPT 取消。
 *
 * 流程（任务卡 §8.2）：
 *   1. 加载 agent_session（不带 FOR UPDATE，因为只读决策；cancelInflight 内部也只
 *      需要 active_run_id，不需要 SELECT FOR UPDATE）。
 *   2. 没有 active_run_id → NONE。
 *   3. active_run_expires_at < NOW → cancelInflight EXPIRED → EXPIRED（边界 2）。
 *   4. intent ∉ CONFIRM/CANCEL → cancelInflight PREEMPT → CANCELLED（边界 1）。
 *   5. 其它 → NONE（resume 由 confirmDraft 处理；本切片 tick 不做 resume）。
 *
 * 错误处理：
 *   - DB 抖动 / cancel 失败：捕获并 logger.warn；返回 NONE（避免 tick 抛错把
 *     整个聊天链路挂掉；任务卡 §7 MUST DO §1：tick 必须在 dispatch 前调用，
 *     不得阻断业务）。
 */
export async function tickAtUserMessage(
  args: TickAtUserMessageArgs,
): Promise<TickResult> {
  try {
    const session = await loadSession(args.sessionId);
    if (!session?.activeRunId) {
      return { kind: 'NONE' };
    }

    // 边界 2：30 分钟过期
    if (session.activeRunExpiresAt && session.activeRunExpiresAt.getTime() < Date.now()) {
      try {
        await cancelInflight({ sessionId: args.sessionId, reason: 'EXPIRED' });
      } catch (e) {
        logger.warn(
          { err: e instanceof Error ? e.message : String(e), sessionId: args.sessionId },
          '[confirm-manager] cancelInflight(EXPIRED) failed in tick (non-blocking)',
        );
      }
      return { kind: 'EXPIRED' };
    }

    // 边界 1：抢占（intent 不属于 CONFIRM/CANCEL 家族）
    if (!isHitlConfirmFamily(args.userIntent)) {
      try {
        await cancelInflight({ sessionId: args.sessionId, reason: 'PREEMPT' });
      } catch (e) {
        logger.warn(
          { err: e instanceof Error ? e.message : String(e), sessionId: args.sessionId },
          '[confirm-manager] cancelInflight(PREEMPT) failed in tick (non-blocking)',
        );
      }
      return { kind: 'CANCELLED' };
    }

    // CONFIRM/CANCEL：本切片 tick 不在此处 resume；让 confirmDraft 处理
    return { kind: 'NONE' };
  } catch (e) {
    // 任务卡 §7 MUST DO §1：tick 必须在 dispatch 前调用；DB 异常不得阻断业务
    logger.warn(
      { err: e instanceof Error ? e.message : String(e), sessionId: args.sessionId },
      '[confirm-manager] tickAtUserMessage failed; degrading to NONE',
    );
    return { kind: 'NONE' };
  }
}

/* ============================================================================
 * 8) confirmDraft —— resume 锁 + 不在事务内 await Mastra
 * ========================================================================== */

/**
 * confirmDraft 入参（任务卡 §7 表）。
 */
export interface ConfirmDraftArgs {
  draftId: string;
  runtimeContext: RuntimeContext<AgentRuntime>;
}

/**
 * 用户说"确认创建采购单"时调用：
 *
 *   1. 边界 5：sessionId 漂移兜底
 *      - 先 DraftManager.getByIdStrict（按当前 ctx merchant/store）
 *      - 找不到 → DraftManager.findRecentDraft(ctx, 5) 取最近 5 分钟未提交草稿
 *      - 仍找不到 → BizError(SUSPEND_NOT_FOUND)
 *
 *   2. 没有 active suspend → 返回 PREVIEW_FIRST（让 Skill 进入 preview 流程，
 *      由切片 17 的 purchase_order_create workflow 完成 preview/askConfirm/createPo 三步）
 *
 *   3. 边界 3 / 4：resume 排他锁（FOR UPDATE + resume_locked_at 10s 自动释放）
 *      - 事务体内：SELECT FOR UPDATE → 检查锁租约 → UPDATE resume_locked_at = NOW(3) → COMMIT
 *      - 事务体**结束后**才 await mastra.resume（任务卡 §7 MUST NOT §2）
 *      - try { resume } finally { UPDATE resume_locked_at = NULL }（任务卡 §7 MUST DO §4）
 *
 * 强约束：
 *   - 不得跳过 DraftManager 直读 draft 表（任务卡 §7 MUST NOT §1）
 *   - 不得在事务内 await mastra.resume（任务卡 §7 MUST NOT §2）
 *   - 重复确认：第二条命中 RESUME_RACE，幂等返回；不创建第二张采购单
 */
export async function confirmDraft(args: ConfirmDraftArgs): Promise<ConfirmResult> {
  const sessionId = args.runtimeContext.get('sessionId');

  // ----- 边界 5：sessionId 漂移兜底（任务卡 §8.3 / §7 MUST DO §8） -----
  let draft: DraftView | null = null;
  try {
    draft = await getByIdStrict(args.draftId, args.runtimeContext);
  } catch (e) {
    if (!(e instanceof BizError) || e.code !== 'DRAFT_NOT_FOUND') {
      throw e; // 非 DRAFT_NOT_FOUND（如 INTERNAL_ERROR / DB 错误）直接外抛
    }
    const recent = await findRecentDraft(args.runtimeContext, 5);
    if (recent.length === 0) {
      throw new BizError('SUSPEND_NOT_FOUND', '未找到待确认草稿', {
        meta: { draftId: args.draftId, sessionId },
      });
    }
    // 任务卡 §8.3：取最近一条（findRecentDraft 已按 created_at DESC 排序）
    draft = recent[0] ?? null;
    if (!draft) {
      throw new BizError('SUSPEND_NOT_FOUND', '未找到待确认草稿', {
        meta: { draftId: args.draftId, sessionId },
      });
    }
  }

  // ----- 检查是否有 active suspend；没有 → PREVIEW_FIRST -----
  const session = await loadSession(sessionId);
  if (!session?.activeRunId || !session.activeRunStep) {
    return await startPurchaseOrderPreviewFirst({
      draftId: draft.draftId,
      runtimeContext: args.runtimeContext,
    });
  }

  // 兜底：active_run_expires_at 已过期 → 返回 SUSPEND_EXPIRED（与 cron / tick 对称）
  if (session.activeRunExpiresAt && session.activeRunExpiresAt.getTime() < Date.now()) {
    try {
      await cancelInflight({ sessionId, reason: 'EXPIRED' });
    } catch {
      /* swallow + audit */
    }
    throw new BizError('SUSPEND_EXPIRED', '上次确认请求已过期', {
      meta: { sessionId, runId: session.activeRunId },
    });
  }

  // ----- 边界 3 / 4：resume 排他锁（FOR UPDATE + 10s 租约） -----
  const pool = getRegisteredConfirmManagerPool();
  const resolver = getRegisteredMastraResolver();
  // draft 可被边界 5 兜底取代为最新一条
  void draft;

  const lockedSession = await pool.transaction<SessionView>(async (tx) => {
    const [rows] = await tx.query<AgentSessionRow>(
      `SELECT session_id, merchant_id, current_store_id, user_id,
              active_run_id, active_run_step, active_run_expires_at,
              resume_locked_at, active_draft_id
         FROM agent_session
        WHERE session_id = ?
        FOR UPDATE`,
      [sessionId],
    );
    const row = rows[0];
    if (!row) {
      throw new BizError('SUSPEND_NOT_FOUND', '会话已被清理', { meta: { sessionId } });
    }
    const view = parseSessionRow(row);
    if (!view.activeRunId || !view.activeRunStep) {
      // 提前看到没挂起 → 仍按 PREVIEW_FIRST 协议处理（事务内不抛错；外面拿到后判断）
      return view;
    }
    // 锁租约：第二条并发请求看到 lockedAt 在 10s 内 → 抛 RESUME_RACE 幂等返回
    if (
      view.resumeLockedAt &&
      view.resumeLockedAt.getTime() > Date.now() - RESUME_LOCK_LEASE_MS
    ) {
      throw new BizError('RESUME_RACE', '已有 resume 在执行', {
        meta: { sessionId, runId: view.activeRunId },
      });
    }
    // 抢占锁：UPDATE resume_locked_at = NOW(3)
    await tx.execute(
      `UPDATE agent_session
          SET resume_locked_at = NOW(3)
        WHERE session_id = ?`,
      [sessionId],
    );
    return view;
  });

  // 兜底：事务内看到没挂起 → PREVIEW_FIRST（与 loadSession 路径对称）
  if (!lockedSession.activeRunId || !lockedSession.activeRunStep) {
    return await startPurchaseOrderPreviewFirst({
      draftId: draft.draftId,
      runtimeContext: args.runtimeContext,
    });
  }

  const runId = lockedSession.activeRunId;
  const step = lockedSession.activeRunStep;

  // ----- 任务卡 §7 MUST DO §4：try { resume } finally { UPDATE NULL } -----
  // **关键不变量**：mastra.resume 必须在事务体外（已 COMMIT），任务卡 §7 MUST NOT §2
  try {
    const workflow = resolver.getWorkflow(HITL_WORKFLOW_ID);
    const result = await workflow.resume({
      runId,
      step,
      resumeData: { decision: 'CONFIRM' },
      runtimeContext: args.runtimeContext,
    });
    await clearCompletedRun({ pool, runId, sessionId });
    return { kind: 'CONFIRMED', result };
  } finally {
    // 锁释放保护：失败也要 UPDATE NULL，否则 10s 内后续 confirm 都被 RESUME_RACE 阻塞
    try {
      await pool.execute(
        `UPDATE agent_session
            SET resume_locked_at = NULL
          WHERE session_id = ?`,
        [sessionId],
      );
    } catch (e) {
      logger.warn(
        { err: e instanceof Error ? e.message : String(e), sessionId },
        '[confirm-manager] release resume_locked_at NULL failed (10s lease will tide over)',
      );
    }
  }
}

async function startPurchaseOrderPreviewFirst(args: {
  draftId: string;
  runtimeContext: RuntimeContext<AgentRuntime>;
}): Promise<ConfirmResult> {
  const starter = getRegisteredPurchaseOrderStarter();
  const started = await starter.startPreview({
    draftId: args.draftId,
    runtimeContext: args.runtimeContext,
  });
  const pool = getRegisteredConfirmManagerPool();
  const sessionId = args.runtimeContext.get('sessionId');
  const payloadJson = JSON.stringify(stripUndefinedDeep(started.suspendPayload));

  await pool.execute(
    `INSERT INTO mastra_workflow_suspend
       (run_id, step_id, payload_json, expires_at, created_at)
     VALUES (?, ?, CAST(? AS JSON), NOW(3) + INTERVAL 30 MINUTE, NOW(3))
     ON DUPLICATE KEY UPDATE
       payload_json = VALUES(payload_json),
       expires_at   = VALUES(expires_at)`,
    [started.runId, started.step, payloadJson],
  );

  await pool.execute(
    `INSERT INTO agent_session
       (session_id, api_key_prefix, merchant_id, current_store_id, user_id,
        state, active_draft_id, active_run_id, active_run_step, active_run_expires_at,
        last_message_at)
     VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, NOW(3) + INTERVAL 30 MINUTE, NOW(3))
     ON DUPLICATE KEY UPDATE
       state = 'ACTIVE',
       active_draft_id = VALUES(active_draft_id),
       active_run_id = VALUES(active_run_id),
       active_run_step = VALUES(active_run_step),
       active_run_expires_at = VALUES(active_run_expires_at),
       resume_locked_at = NULL,
       last_message_at = NOW(3)`,
    [
      sessionId,
      args.runtimeContext.get('apiKeyPrefix'),
      args.runtimeContext.get('merchantId'),
      args.runtimeContext.get('storeId'),
      args.runtimeContext.get('userId'),
      args.draftId,
      started.runId,
      started.step,
    ],
  );

  return {
    kind: 'PREVIEW_FIRST',
    preview: started.previewMarkdown,
  };
}

async function clearCompletedRun(args: {
  pool: ConfirmManagerPool;
  runId: string;
  sessionId: string;
}): Promise<void> {
  try {
    await args.pool.execute(`DELETE FROM mastra_workflow_suspend WHERE run_id = ?`, [
      args.runId,
    ]);
  } catch (e) {
    logger.warn(
      {
        err: e instanceof Error ? e.message : String(e),
        runId: args.runId,
        sessionId: args.sessionId,
      },
      '[confirm-manager] DELETE suspend after CONFIRM failed',
    );
  }

  try {
    await args.pool.execute(
      `UPDATE agent_session
          SET active_run_id = NULL,
              active_run_step = NULL,
              active_run_expires_at = NULL,
              resume_locked_at = NULL
        WHERE active_run_id = ?`,
      [args.runId],
    );
  } catch (e) {
    logger.warn(
      {
        err: e instanceof Error ? e.message : String(e),
        runId: args.runId,
        sessionId: args.sessionId,
      },
      '[confirm-manager] UPDATE agent_session clear active_run_* after CONFIRM failed',
    );
  }
}

/* ============================================================================
 * 9) cancelInflight —— USER_CANCEL / PREEMPT / ABORT / EXPIRED 统一收口
 * ========================================================================== */

/**
 * cancelInflight 入参（任务卡 §7 表）。
 */
export interface CancelInflightArgs {
  sessionId: string;
  reason: CancelReason;
}

/**
 * 取消挂起的 HITL run（任务卡 §7 表 + §8.2）：
 *
 *   1. 读 agent_session.active_run_id；若已为空 → NOOP（幂等）
 *   2. 尽力 mastra.resume({ decision: 'CANCEL', reason })（错误 swallow + audit log）
 *      - tombstone runtimeContext：用 active_run_id 关联到的 session 上下文构造
 *      - 不阻断后续清理；resume 失败也必须清 suspend + active_run_*
 *   3. DELETE FROM mastra_workflow_suspend WHERE run_id = ?
 *   4. UPDATE agent_session SET active_run_id=NULL, active_run_step=NULL,
 *        active_run_expires_at=NULL WHERE active_run_id=?（幂等）
 *
 * 该函数被 tickAtUserMessage 内部调用（PREEMPT/EXPIRED）+ 桥接层 onAbort（ABORT）+
 * 用户主动取消（USER_CANCEL）+ cron expire-suspended-runs（EXPIRED）四条路径共用。
 */
export async function cancelInflight(args: CancelInflightArgs): Promise<void> {
  const pool = getRegisteredConfirmManagerPool();

  const session = await loadSession(args.sessionId);
  if (!session?.activeRunId) {
    return; // 幂等：已无挂起 → NOOP
  }

  const runId = session.activeRunId;
  const step = session.activeRunStep;
  const tombstone = buildRuntimeContext({
    traceId: `tombstone_${runId}`,
    sessionId: args.sessionId,
    merchantId: session.merchantId,
    storeId: session.storeId,
    userId: session.userId,
    apiKeyPrefix: 'tombstone',
    requestStartedAt: Date.now(),
  });

  // 尽力 mastra.resume({ decision: 'CANCEL', reason })
  if (step) {
    try {
      const resolver = getRegisteredMastraResolver();
      const workflow = resolver.getWorkflow(HITL_WORKFLOW_ID);
      await workflow.resume({
        runId,
        step,
        resumeData: { decision: 'CANCEL', reason: args.reason },
        runtimeContext: tombstone,
      });
    } catch (e) {
      // swallow + audit；不阻断后续 suspend / session 清理
      logger.warn(
        {
          err: e instanceof Error ? e.message : String(e),
          sessionId: args.sessionId,
          runId,
          reason: args.reason,
        },
        '[confirm-manager] mastra.resume(CANCEL) failed (swallowed; cleanup continues)',
      );
    }
  }

  await cancelActiveDraftIfPossible({
    session,
    runtimeContext: tombstone,
    reason: args.reason,
  });

  // 清 suspend payload（同 runId 的所有 step）+ 清 active_run_*（按 active_run_id 兜底）
  try {
    await pool.execute(`DELETE FROM mastra_workflow_suspend WHERE run_id = ?`, [runId]);
  } catch (e) {
    logger.warn(
      {
        err: e instanceof Error ? e.message : String(e),
        runId,
        reason: args.reason,
      },
      '[confirm-manager] DELETE suspend failed (non-blocking; cron will retry)',
    );
  }

  try {
    await pool.execute(
      `UPDATE agent_session
          SET active_run_id = NULL,
              active_run_step = NULL,
              active_run_expires_at = NULL,
              resume_locked_at = NULL
        WHERE active_run_id = ?`,
      [runId],
    );
  } catch (e) {
    logger.warn(
      {
        err: e instanceof Error ? e.message : String(e),
        runId,
        reason: args.reason,
      },
      '[confirm-manager] UPDATE agent_session clear active_run_* failed',
    );
  }
}

async function cancelActiveDraftIfPossible(args: {
  session: SessionView;
  runtimeContext: RuntimeContext<AgentRuntime>;
  reason: CancelReason;
}): Promise<void> {
  if (!args.session.activeDraftId) return;

  try {
    const draft = await getByIdStrict(args.session.activeDraftId, args.runtimeContext);
    if (!['DRAFT', 'WAIT_CONFIRM', 'CONFIRMED'].includes(draft.status)) {
      return;
    }
    await transitDraft({
      draftId: draft.draftId,
      from: draft.status,
      to: 'CANCELLED',
      runtimeContext: args.runtimeContext,
    });
  } catch (e) {
    logger.warn(
      {
        err: e instanceof Error ? e.message : String(e),
        draftId: args.session.activeDraftId,
        reason: args.reason,
      },
      '[confirm-manager] cancel active draft failed (non-blocking)',
    );
  }
}
