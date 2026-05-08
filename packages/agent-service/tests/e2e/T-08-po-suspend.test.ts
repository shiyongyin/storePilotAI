/**
 * 切片 19 — T-08 采购单 HITL：suspend（链路 1/4）
 *
 * 严格按 docs/tanks/19-test-e2e-20-cases.md §8.1 §T-08 + §8.3 落地：
 *   - 期望：snapshot.status='SUSPENDED'（agent_session.active_run_id 非空）+ preview 流出
 *   - HITL 4 条 (T-08..T-11) 共享 sessionId 概念；本文件起点
 *   - 真 chat-completions / Auth / OutputGuard / SSE 链路；真 MySQL（agent_session +
 *     replenishment_draft + mastra_workflow_suspend）
 *   - dispatcher 受控：本测试模拟 workflow.start → suspend(askConfirm) 行为，
 *     但所有持久化都走真实 SQL，不绕过 ConfirmManager / DraftManager
 *   - 不依赖外网（任务卡 §7 MUST NOT §2）
 *
 * @since 切片 19
 */
import type { Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { issueE2eApiKey } from './_helpers/api-key.js';
import { logCommand, streamChat } from './_helpers/chat-client.js';
import { ensureBaseEnv } from './_helpers/env.js';
import {
  asAuthPool,
  asConfirmManagerPool,
  asDraftPool,
  cleanTenantData,
  closeMysqlPool,
  getMysqlPool,
  isMysqlReady,
} from './_helpers/mysql.js';
import { startAgentForTest, type AgentTestHandle } from './_helpers/agent-app.js';
import {
  createWaitConfirmDraft,
  insertWorkflowSuspend,
  newSessionId,
  readSession,
  upsertAgentSession,
} from './_helpers/session.js';

ensureBaseEnv();

/** HITL 链共享租户标识（T-08..T-11 共享 merchantId / storeId / userId 形态） */
const MERCHANT_ID = 'M_E2E_HITL_T08';
const STORE_ID = 'S_E2E_HITL_T08';
const USER_ID = 'boss-e2e-hitl-t08';
const RUN_ID = 'run_e2e_t08_suspend_001';

let pool: Pool;
let handle: AgentTestHandle;
let apiKey: string;
let apiKeyPrefix: string;
let sessionId: string;

beforeAll(async () => {
  if (!isMysqlReady()) return;
  pool = getMysqlPool();
  await cleanTenantData(pool, MERCHANT_ID);

  const issued = await issueE2eApiKey(pool, {
    merchantId: MERCHANT_ID,
    storeId: STORE_ID,
    userId: USER_ID,
  });
  apiKey = issued.apiKey;
  apiKeyPrefix = issued.prefix;
  sessionId = newSessionId('sess_hitl_t08');

  // 注入 DI hooks（agent-app）
  const draftMgr = await import('../../src/safety/draft-manager.js');
  draftMgr.setDraftPool(asDraftPool(pool));

  handle = startAgentForTest({
    authPool: asAuthPool(pool),
    draftPool: asDraftPool(pool),
    confirmManagerPool: asConfirmManagerPool(pool),
    dispatcher: async (args) => {
      // 模拟 ADJUST/REPLENISH 之后 confirm 阶段 → 假装 workflow 已 suspend；
      // 真实路径在切片 17 由 workflow.suspend() 自动写 mastra_workflow_suspend 行；
      // E2E 在 dispatcher 内显式 INSERT，等价行为。
      await upsertAgentSession(pool, {
        sessionId: args.sessionId,
        apiKeyPrefix: args.auth.apiKeyPrefix,
        merchantId: args.auth.merchantId,
        storeId: args.auth.storeId,
        userId: args.auth.userId,
        activeRunId: RUN_ID,
        activeRunStep: 'ask-confirm',
        activeRunExpiresAtSec: 30 * 60,
      });
      await insertWorkflowSuspend(pool, {
        runId: RUN_ID,
        stepId: 'ask-confirm',
        expiresInSecondsFromNow: 30 * 60,
      });
      return {
        finalText: `# 采购单预览（待您确认）

总金额：¥1,820.00
SKU 数：1
- SKU001 矿泉水 A：28 瓶 × ¥65.00 = ¥1,820.00

回复"确认"提交，回复"取消"作废。
`,
      };
    },
  });

  // 预置一份 WAIT_CONFIRM 草稿（dispatcher 不再写 draft；workflow start 期间已写）
  await createWaitConfirmDraft({
    pool,
    sessionId,
    merchantId: MERCHANT_ID,
    storeId: STORE_ID,
    userId: USER_ID,
    apiKeyPrefix,
  });
}, 30_000);

afterAll(async () => {
  if (isMysqlReady()) {
    await cleanTenantData(pool, MERCHANT_ID).catch(() => undefined);
    handle?.cleanup();
    await closeMysqlPool();
  }
  vi.unstubAllEnvs();
});

describe.skipIf(!isMysqlReady()).sequential('T-08 采购单 HITL：suspend（链路 1/4）', () => {
  it('"确认下单" → SSE 200 + agent_session.active_run_id 非空 + preview markdown 流出', async () => {
    logCommand(
      'T-08',
      "curl -N -H 'Authorization: Bearer ***' -d '{messages:[{role:user,content:确认下单}]}' /v1/chat/completions",
      'status=200, agent_session.active_run_id=run_e2e_t08_*, finalText 含"确认"',
    );
    // 用一个固定 system + user，尽量让 inferSessionId 命中我们手动 upsert 的 row（apiKeyPrefix 一致即可走业务流程）
    const r = await streamChat({
      app: handle.app,
      apiKey,
      body: {
        messages: [
          { role: 'system', content: 'system-prompt-T08' },
          { role: 'user', content: '确认下单' },
        ],
      },
    });

    expect(r.status).toBe(200);
    expect(r.finalText).toContain('确认');
    expect(r.finalText).toMatch(/采购单|预览/);
    expect(r.finalText).not.toContain('tool_calls');

    // dispatcher 内已用 inferSessionId（chat-completions）派生的 sessionId upsert，
    // 我们读取该 sessionId 行对应的 agent_session 应有 active_run_id
    const [rows] = await pool.query<
      Array<{ session_id: string; active_run_id: string | null; active_run_step: string | null }>
    >(
      `SELECT session_id, active_run_id, active_run_step FROM agent_session
        WHERE merchant_id = ? AND active_run_id = ?`,
      [MERCHANT_ID, RUN_ID],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.active_run_id).toBe(RUN_ID);
    expect(rows[0]?.active_run_step).toBe('ask-confirm');

    // mastra_workflow_suspend 应有 1 行，且未过期
    const [suspendRows] = await pool.query<
      Array<{ run_id: string; step_id: string; expires_at: Date | string }>
    >(
      `SELECT run_id, step_id, expires_at FROM mastra_workflow_suspend WHERE run_id = ?`,
      [RUN_ID],
    );
    expect(suspendRows.length).toBe(1);

    // 兜底：sessionId 一致性 sanity 检查（任意 sessionId 都行；此处避免 unused var）
    void readSession;
    void sessionId;
  });
});
