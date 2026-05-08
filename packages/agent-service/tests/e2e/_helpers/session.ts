/**
 * 切片 19 — agent_session / mastra_workflow_suspend / replenishment_draft
 *           E2E 端的轻量 helper。
 *
 * 严格按 docs/tanks/19-test-e2e-20-cases.md §6 / §8.2-§8.4 落地。
 *
 * 与生产代码的关系：
 *   - 不旁路 DraftManager（任务卡 §6 MUST DO §1）；本文件仅提供"测试场景下伪造已挂起 run"
 *     与"读 agent_session / mastra_workflow_suspend 行用于断言"的最小 helper。
 *   - createWaitConfirmDraft 走的是 DraftManager.create + transit('DRAFT'→'WAIT_CONFIRM')，
 *     与切片 14 replenishment_forecast 行为对齐（避免 E2E 自己拼 INSERT 绕过状态机）。
 *
 * @since 切片 19
 */
import { randomBytes } from 'node:crypto';

import type { DraftItem } from '@storepilot/shared-contracts';
import type { Pool } from 'mysql2/promise';

import * as DraftManager from '../../../src/safety/draft-manager.js';
import {
  buildRuntimeContext,
  type AgentRuntime,
  type RuntimeContext,
} from '../../../src/mastra/runtime-context.js';

/* ============================================================================
 * draftId helpers
 * ========================================================================== */

/** 简单的 sessionId 生成器（与生产 inferSessionId 风格无关；E2E 只要求唯一） */
export function newSessionId(prefix = 'sess_e2e'): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

/** 轻量 RuntimeContext 构造（buildRuntimeContext 包装） */
export function buildE2eRuntimeContext(args: {
  sessionId: string;
  merchantId: string;
  storeId: string;
  userId: string;
  apiKeyPrefix: string;
  traceId?: string;
}): RuntimeContext<AgentRuntime> {
  return buildRuntimeContext({
    traceId: args.traceId ?? `trace_e2e_${Date.now().toString(36)}`,
    sessionId: args.sessionId,
    merchantId: args.merchantId,
    storeId: args.storeId,
    userId: args.userId,
    apiKeyPrefix: args.apiKeyPrefix,
    requestStartedAt: Date.now(),
  });
}

/* ============================================================================
 * agent_session 行 helpers
 * ========================================================================== */

/**
 * 直接插入 agent_session 行（含 5 个 HITL 字段）。
 *
 * 任务卡 §6 MUST NOT §1：业务路径不得旁路 DraftManager；本 helper 只为 E2E
 * 模拟 LobeChat 已经写过 session 行的现状（生产路径在 inferSessionId 命中时插入）。
 */
export async function upsertAgentSession(
  pool: Pool,
  args: {
    sessionId: string;
    apiKeyPrefix: string;
    merchantId: string;
    storeId: string;
    userId: string;
    activeRunId?: string | null;
    activeRunStep?: string | null;
    activeDraftId?: string | null;
    /** suspend 过期时刻；默认 30 分钟后 */
    activeRunExpiresAtSec?: number | null;
  },
): Promise<void> {
  // 用 NOW(3) + INTERVAL N SECOND（N 为整数字面量）而非占位符 —— 占位符 + INTERVAL 在
  // 部分 mysql2 版本下行为不稳；秒数直接拼字面量 + Number 兜底防 SQL 注入（typeof 断言）。
  const sec = typeof args.activeRunExpiresAtSec === 'number' ? Math.floor(args.activeRunExpiresAtSec) : null;
  const expiresAtSql =
    sec !== null && Number.isFinite(sec) ? `NOW(3) + INTERVAL ${sec} SECOND` : 'NULL';
  await pool.execute(
    `INSERT INTO agent_session
       (session_id, api_key_prefix, merchant_id, current_store_id, user_id,
        state, active_run_id, active_run_step, active_run_expires_at, active_draft_id)
     VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ${expiresAtSql}, ?)
     ON DUPLICATE KEY UPDATE
       active_run_id = VALUES(active_run_id),
       active_run_step = VALUES(active_run_step),
       active_run_expires_at = VALUES(active_run_expires_at),
       active_draft_id = VALUES(active_draft_id),
       last_message_at = NOW(3)`,
    [
      args.sessionId,
      args.apiKeyPrefix,
      args.merchantId,
      args.storeId,
      args.userId,
      args.activeRunId ?? null,
      args.activeRunStep ?? null,
      args.activeDraftId ?? null,
    ],
  );
}

/** 读 agent_session（用于断言 active_run_*） */
export async function readSession(
  pool: Pool,
  sessionId: string,
): Promise<{
  active_run_id: string | null;
  active_run_step: string | null;
  active_run_expires_at: Date | string | null;
  resume_locked_at: Date | string | null;
} | null> {
  const [rows] = await pool.query<
    Array<{
      active_run_id: string | null;
      active_run_step: string | null;
      active_run_expires_at: Date | string | null;
      resume_locked_at: Date | string | null;
    }>
  >(
    `SELECT active_run_id, active_run_step, active_run_expires_at, resume_locked_at
       FROM agent_session WHERE session_id = ? LIMIT 1`,
    [sessionId],
  );
  return rows[0] ?? null;
}

/* ============================================================================
 * mastra_workflow_suspend 行 helpers
 * ========================================================================== */

/**
 * 直接插入一行 mastra_workflow_suspend（仅 E2E 用，模拟 workflow.suspend() 已发生）。
 *
 * 与 migration 010 一致：(run_id, step_id, payload_json, expires_at)；
 * workflow_id 不在 V1 schema 内，仅放在 payload 里供 expire-suspended-runs cron 兜底用。
 */
export async function insertWorkflowSuspend(
  pool: Pool,
  args: {
    runId: string;
    workflowId?: string;
    stepId?: string;
    expiresAtSec?: number;
    /** 已过期场景：传负数（如 -60 表示 60 秒前已过期） */
    expiresInSecondsFromNow?: number;
  },
): Promise<void> {
  const workflowId = args.workflowId ?? 'purchase_order_create';
  const stepId = args.stepId ?? 'ask-confirm';
  const offsetRaw = args.expiresInSecondsFromNow ?? args.expiresAtSec ?? 30 * 60;
  const offset = Math.floor(offsetRaw);
  if (!Number.isFinite(offset)) {
    throw new Error('[insertWorkflowSuspend] offset 必须是有限数');
  }
  await pool.execute(
    `INSERT INTO mastra_workflow_suspend
       (run_id, step_id, payload_json, expires_at)
     VALUES (?, ?, CAST(? AS JSON), NOW(3) + INTERVAL ${offset} SECOND)
     ON DUPLICATE KEY UPDATE
       expires_at = VALUES(expires_at),
       payload_json = VALUES(payload_json)`,
    [args.runId, stepId, JSON.stringify({ workflowId, stub: true })],
  );
}

/* ============================================================================
 * Draft helpers —— 走 DraftManager 公开 API（不旁路状态机）
 * ========================================================================== */

const DEFAULT_DRAFT_ITEM: DraftItem = {
  skuId: 'SKU001',
  skuName: '测试商品 A',
  unit: '瓶',
  category: '饮品',
  onHandQty: 10,
  inTransitQty: 0,
  leadTimeDays: 2,
  packSize: 1,
  recentDailyAvg: 5.5,
  baseSuggestQty: 28,
  finalSuggestQty: 28,
  reason: 'E2E happy path',
};

/**
 * 创建一份 WAIT_CONFIRM 状态的 draft（走 DraftManager.create + transit）。
 *
 * @returns draftView（含真实 draftId）
 */
export async function createWaitConfirmDraft(args: {
  pool: Pool;
  sessionId: string;
  merchantId: string;
  storeId: string;
  userId: string;
  apiKeyPrefix: string;
  items?: DraftItem[];
}): Promise<{
  draftId: string;
  runtimeContext: RuntimeContext<AgentRuntime>;
}> {
  const ctx = buildE2eRuntimeContext(args);
  const items = args.items ?? [DEFAULT_DRAFT_ITEM];

  const created = await DraftManager.create({
    sessionId: args.sessionId,
    merchantId: args.merchantId,
    storeId: args.storeId,
    userId: args.userId,
    traceId: ctx.get('traceId'),
    forecastDays: 7,
    items,
    strategyVersion: 'P1-M0-S0',
  });
  await DraftManager.transit({
    draftId: created.draftId,
    from: 'DRAFT',
    to: 'WAIT_CONFIRM',
    runtimeContext: ctx,
  });

  return { draftId: created.draftId, runtimeContext: ctx };
}

/** 直接读 replenishment_draft 一行（断言用） */
export async function readDraftRow(
  pool: Pool,
  draftId: string,
): Promise<{
  draft_id: string;
  status: string;
  submitted_po_no: string | null;
  merchant_id: string;
  store_id: string;
} | null> {
  const [rows] = await pool.query<
    Array<{
      draft_id: string;
      status: string;
      submitted_po_no: string | null;
      merchant_id: string;
      store_id: string;
    }>
  >(
    `SELECT draft_id, status, submitted_po_no, merchant_id, store_id
       FROM replenishment_draft WHERE draft_id = ? LIMIT 1`,
    [draftId],
  );
  return rows[0] ?? null;
}
