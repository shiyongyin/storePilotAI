/**
 * 切片 19 — T-11 采购单 HITL：同 draftId 重复确认幂等（链路 4/4）
 *
 * 严格按 docs/tanks/19-test-e2e-20-cases.md §8.1 §T-11 + §8.5 落地：
 *   - fixture：create-po-idempotent 概念（同 idempotencyKey 仅生成 1 个 PO）
 *   - 期望：2 次重复确认 → createPurchaseOrder 仅 1 次调用 + 同 PO 号
 *   - 真 ConfirmManager.confirmDraft（FOR UPDATE 锁租约 + RESUME_RACE 守门）
 *   - 真 DraftManager.markSubmitted（同 PO 幂等）
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
  buildE2eRuntimeContext,
  createWaitConfirmDraft,
  insertWorkflowSuspend,
  upsertAgentSession,
} from './_helpers/session.js';

ensureBaseEnv();

const MERCHANT_ID = 'M_E2E_HITL_T11';
const STORE_ID = 'S_E2E_HITL_T11';
const USER_ID = 'boss-e2e-hitl-t11';
const RUN_ID = 'run_e2e_t11_idempotent_001';
const FAKE_PO_NO = 'PO_E2E_T11_001';

let pool: Pool;
let handle: AgentTestHandle;
let apiKey: string;
let apiKeyPrefix: string;
let sessionId: string;
let draftId: string;
let createPoCallCount = 0;

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
      { role: 'system', content: 'system-prompt-T11' },
      { role: 'user', content: '确认' },
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

  // FakeMastraResolver 计数：模拟"同 idempotencyKey/同 draftId 仅生成 1 PO"
  // create-po-idempotent fixture 在 mock-mock-server 端兑现幂等；这里在 fake resolver 端
  // 用 markSubmitted 的"已 SUBMITTED 同 poNo 直接 NOOP"语义达到等价行为。
  const fakeResolver = {
    getWorkflow: () => ({
      resume: async (rArgs: { runtimeContext: { get: (k: string) => unknown } }): Promise<unknown> => {
        createPoCallCount += 1;
        const ctx = rArgs.runtimeContext as unknown as Parameters<typeof draftMgr.markSubmitted>[2];
        await draftMgr.transit({
          draftId,
          from: 'WAIT_CONFIRM',
          to: 'CONFIRMED',
          runtimeContext: ctx,
        }).catch(() => undefined); // 幂等：第二次调用 from 已 ≠ WAIT_CONFIRM 时不抛
        await draftMgr.markSubmitted(draftId, FAKE_PO_NO, ctx);
        return {
          status: 'COMPLETED' as const,
          poNo: FAKE_PO_NO,
          summaryMarkdown: `# 采购单已提交\n\n采购单号：${FAKE_PO_NO}`,
        };
      },
    }),
  };

  handle = startAgentForTest({
    authPool: asAuthPool(pool),
    draftPool: asDraftPool(pool),
    confirmManagerPool: asConfirmManagerPool(pool),
    mastraResolver: fakeResolver,
    dispatcher: async (args) => {
      const cm = await import('../../src/safety/confirm-manager.js');
      const ctx = buildE2eRuntimeContext({
        sessionId: args.sessionId,
        merchantId: args.auth.merchantId,
        storeId: args.auth.storeId,
        userId: args.auth.userId,
        apiKeyPrefix: args.auth.apiKeyPrefix,
        traceId: args.traceId,
      });
      try {
        const r = await cm.confirmDraft({ draftId, runtimeContext: ctx });
        if (r.kind === 'CONFIRMED') {
          const result = r.result as { poNo?: string };
          return { finalText: `采购单已提交（PO=${result.poNo}）` };
        }
        return { finalText: r.kind === 'PREVIEW_FIRST' ? r.preview : '已为您处理' };
      } catch (e) {
        // RESUME_RACE / DRAFT_ALREADY_SUBMITTED 都是幂等态；不外抛
        const msg = e instanceof Error ? e.message : String(e);
        return { finalText: `[幂等态] ${msg}` };
      }
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

describe.skipIf(!isMysqlReady()).sequential('T-11 采购单 HITL：同 draftId 重复确认幂等（链路 4/4）', () => {
  it('两次"确认"并发 → 只生成 1 个 PO + 状态 SUBMITTED', async () => {
    logCommand(
      'T-11',
      "curl -N -H 'Authorization: Bearer ***' -d '{messages:[{role:user,content:确认}]}' /v1/chat/completions × 2 (并发)",
      'createPoCallCount<=1, draft.status=SUBMITTED, submitted_po_no=PO_E2E_T11_001',
    );

    const body = {
      messages: [
        { role: 'system' as const, content: 'system-prompt-T11' },
        { role: 'user' as const, content: '确认' },
      ],
    };

    const [r1, r2] = await Promise.all([
      streamChat({ app: handle.app, apiKey, body }),
      streamChat({ app: handle.app, apiKey, body }),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    // 至少一条命中 PO 号；另一条要么命中 PO 号（fast follower），要么是幂等态文本
    const successCount = [r1, r2].filter((r) => r.finalText.includes(FAKE_PO_NO)).length;
    expect(successCount).toBeGreaterThanOrEqual(1);

    // 全程 mastra.resume 调用数 ≤ 1（同 idempotencyKey / 锁租约守护）
    expect(createPoCallCount).toBeLessThanOrEqual(1);

    // DB 校验：仅 1 行 SUBMITTED + 1 个 PO 号
    const [drafts] = await pool.query<{ status: string; submitted_po_no: string | null }[]>(
      `SELECT status, submitted_po_no FROM replenishment_draft WHERE draft_id = ?`,
      [draftId],
    );
    expect(drafts.length).toBe(1);
    expect(drafts[0]?.status).toBe('SUBMITTED');
    expect(drafts[0]?.submitted_po_no).toBe(FAKE_PO_NO);
  });
});
