/**
 * 切片 19 — T-10 采购单 HITL：resume CANCEL（链路 3/4）
 *
 * 严格按 docs/tanks/19-test-e2e-20-cases.md §8.1 §T-10 + §8.3 落地：
 *   - 期望：draft.status='CANCELLED'（用户主动取消）
 *   - 真 chat-completions / Auth / OutputGuard / SSE 链路
 *   - 真 ConfirmManager.cancelInflight（USER_CANCEL）
 *   - 真 DraftManager（落 replenishment_draft）
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
  upsertAgentSession,
} from './_helpers/session.js';

ensureBaseEnv();

const MERCHANT_ID = 'M_E2E_HITL_T10';
const STORE_ID = 'S_E2E_HITL_T10';
const USER_ID = 'boss-e2e-hitl-t10';
const RUN_ID = 'run_e2e_t10_resume_cancel_001';

let pool: Pool;
let handle: AgentTestHandle;
let apiKey: string;
let apiKeyPrefix: string;
let sessionId: string;
let draftId: string;

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
  const sessionMod = await import('../../src/bridge/session.js');
  sessionId = sessionMod.inferSessionId({
    apiKeyPrefix,
    messages: [
      { role: 'system', content: 'system-prompt-T10' },
      { role: 'user', content: '取消' },
    ],
  });

  const draftMgr = await import('../../src/safety/draft-manager.js');
  draftMgr.setDraftPool(asDraftPool(pool));
  const created = await createWaitConfirmDraft({
    pool,
    sessionId,
    merchantId: MERCHANT_ID,
    storeId: STORE_ID,
    userId: USER_ID,
    apiKeyPrefix,
  });
  draftId = created.draftId;

  // 预置 active_run_id + suspend
  await upsertAgentSession(pool, {
    sessionId,
    apiKeyPrefix,
    merchantId: MERCHANT_ID,
    storeId: STORE_ID,
    userId: USER_ID,
    activeRunId: RUN_ID,
    activeRunStep: 'ask-confirm',
    activeDraftId: draftId,
    activeRunExpiresAtSec: 30 * 60,
  });
  await insertWorkflowSuspend(pool, { runId: RUN_ID });

  // FakeMastraResolver：cancelInflight 内会 mastra.resume({ decision: 'CANCEL' })；
  // 这里返回 cancellation 结果即可，DraftManager 状态由 cancelInflight 内部直接转。
  const fakeResolver = {
    getWorkflow: () => ({
      resume: async (): Promise<unknown> => ({ status: 'CANCELLED' as const }),
    }),
  };

  handle = startAgentForTest({
    authPool: asAuthPool(pool),
    draftPool: asDraftPool(pool),
    confirmManagerPool: asConfirmManagerPool(pool),
    mastraResolver: fakeResolver,
    dispatcher: async (args) => {
      // 真实 ConfirmManager.cancelInflight（任务卡 §6 MUST DO §2 — 不旁路）；
      // cancelInflight 内部会按 session.activeDraftId 自动 transit 草稿 → CANCELLED。
      const cm = await import('../../src/safety/confirm-manager.js');
      await cm.cancelInflight({ sessionId: args.sessionId, reason: 'USER_CANCEL' });
      return { finalText: '已为您取消。如需重新生成补货建议请告诉我。' };
    },
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

describe.skipIf(!isMysqlReady()).sequential('T-10 采购单 HITL：resume CANCEL（链路 3/4）', () => {
  it('"取消" → SSE 200 + draft.status=CANCELLED + agent_session.active_run_id=NULL', async () => {
    logCommand(
      'T-10',
      "curl -N -H 'Authorization: Bearer ***' -d '{messages:[{role:user,content:取消}]}' /v1/chat/completions",
      'status=200, draft.status=CANCELLED, agent_session.active_run_id=NULL',
    );
    const r = await streamChat({
      app: handle.app,
      apiKey,
      body: {
        messages: [
          { role: 'system', content: 'system-prompt-T10' },
          { role: 'user', content: '取消' },
        ],
      },
    });
    expect(r.status).toBe(200);
    expect(r.finalText).toContain('已为您取消');

    // DB 校验：draft.status=CANCELLED
    const [drafts] = await pool.query<{ status: string }[]>(
      `SELECT status FROM replenishment_draft WHERE draft_id = ?`,
      [draftId],
    );
    expect(drafts.length).toBe(1);
    expect(drafts[0]?.status).toBe('CANCELLED');

    // agent_session.active_run_id 应被清空
    const [sessions] = await pool.query<{ active_run_id: string | null }[]>(
      `SELECT active_run_id FROM agent_session WHERE session_id = ?`,
      [sessionId],
    );
    expect(sessions[0]?.active_run_id).toBe(null);
  });
});
