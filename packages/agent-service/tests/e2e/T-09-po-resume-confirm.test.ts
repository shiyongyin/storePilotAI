/**
 * 切片 19 — T-09 采购单 HITL：resume CONFIRM（链路 2/4）
 *
 * 严格按 docs/tanks/19-test-e2e-20-cases.md §8.1 §T-09 + §8.3 落地：
 *   - 期望：snapshot.status='COMPLETED' + PO 号返回
 *   - 真 chat-completions / Auth / OutputGuard / SSE 链路
 *   - 真 ConfirmManager.confirmDraft（含 FOR UPDATE 锁租约）+ FakeMastraResolver
 *   - 真 DraftManager（落 replenishment_draft，markSubmitted 写 submitted_po_no）
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

const MERCHANT_ID = 'M_E2E_HITL_T09';
const STORE_ID = 'S_E2E_HITL_T09';
const USER_ID = 'boss-e2e-hitl-t09';
const RUN_ID = 'run_e2e_t09_resume_confirm_001';
const FAKE_PO_NO = 'PO_E2E_T09_001';

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
  // 复用 inferSessionId 计算预期 sessionId；E2E body 里要复用相同 first-system/first-user
  const sessionMod = await import('../../src/bridge/session.js');
  sessionId = sessionMod.inferSessionId({
    apiKeyPrefix,
    messages: [
      { role: 'system', content: 'system-prompt-T09' },
      { role: 'user', content: '确认' },
    ],
  });

  const draftMgr = await import('../../src/safety/draft-manager.js');
  draftMgr.setDraftPool(asDraftPool(pool));

  // 预置 WAIT_CONFIRM 草稿
  const created = await createWaitConfirmDraft({
    pool,
    sessionId,
    merchantId: MERCHANT_ID,
    storeId: STORE_ID,
    userId: USER_ID,
    apiKeyPrefix,
  });
  draftId = created.draftId;

  // 预置 agent_session.active_run_id（模拟 T-08 已完成）+ mastra_workflow_suspend 行
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

  // FakeMastraResolver：workflow.resume(decision='CONFIRM') → 模拟 createPurchaseOrder + markSubmitted
  type ResumeArgs = Parameters<
    Awaited<ReturnType<typeof import('../../src/safety/confirm-manager.js').getRegisteredMastraResolver>>['getWorkflow'] extends never
      ? never
      : Awaited<ReturnType<typeof import('../../src/safety/confirm-manager.js').getRegisteredMastraResolver>>['getWorkflow']
  > extends never
    ? never
    : never;
  void (null as unknown as ResumeArgs);
  const fakeResolver = {
    getWorkflow: () => ({
      // runtimeContext 是 Mastra RequestContext（含 .get(key) 方法）
      resume: async (rArgs: {
        runId: string;
        runtimeContext: { get: (k: string) => unknown };
      }): Promise<unknown> => {
        // 复用 confirmDraft 内部已构造好的 RuntimeContext —— DraftManager 也用 .get('merchantId') 等。
        const ctx = rArgs.runtimeContext as unknown as Parameters<typeof draftMgr.markSubmitted>[2];
        // WAIT_CONFIRM → CONFIRMED → SUBMITTED
        await draftMgr.transit({
          draftId,
          from: 'WAIT_CONFIRM',
          to: 'CONFIRMED',
          runtimeContext: ctx,
        });
        await draftMgr.markSubmitted(draftId, FAKE_PO_NO, ctx);
        return {
          status: 'COMPLETED' as const,
          poNo: FAKE_PO_NO,
          summaryMarkdown: `# 采购单已提交\n\n采购单号：${FAKE_PO_NO}\n总金额：¥1,820.00`,
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
      // 真实 ConfirmManager.confirmDraft 路径（任务卡 §6 MUST DO §2 — 不旁路 ConfirmManager）
      const cm = await import('../../src/safety/confirm-manager.js');
      const ctx = buildE2eRuntimeContext({
        sessionId: args.sessionId,
        merchantId: args.auth.merchantId,
        storeId: args.auth.storeId,
        userId: args.auth.userId,
        apiKeyPrefix: args.auth.apiKeyPrefix,
        traceId: args.traceId,
      });
      // 注意：args.sessionId 来自 inferSessionId，这里我们直接用预置的 sessionId 以保证命中预置行
      const r = await cm.confirmDraft({ draftId, runtimeContext: ctx });
      if (r.kind === 'CONFIRMED') {
        const result = r.result as { poNo?: string; summaryMarkdown?: string };
        return { finalText: result.summaryMarkdown ?? `采购单已提交（PO=${result.poNo}）` };
      }
      return { finalText: r.kind === 'PREVIEW_FIRST' ? r.preview : '已为您处理' };
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

describe.skipIf(!isMysqlReady()).sequential('T-09 采购单 HITL：resume CONFIRM（链路 2/4）', () => {
  it('"确认" → SSE 200 + draft.status=SUBMITTED + submitted_po_no 落库', async () => {
    logCommand(
      'T-09',
      "curl -N -H 'Authorization: Bearer ***' -d '{messages:[{role:user,content:确认}]}' /v1/chat/completions",
      'status=200, draft.status=SUBMITTED, submitted_po_no=PO_E2E_T09_001',
    );
    const r = await streamChat({
      app: handle.app,
      apiKey,
      body: {
        messages: [
          { role: 'system', content: 'system-prompt-T09' },
          { role: 'user', content: '确认' },
        ],
      },
    });

    expect(r.status).toBe(200);
    expect(r.finalText).toContain(FAKE_PO_NO);
    expect(r.finalText).not.toContain('tool_calls');

    // DB 校验：draft.status=SUBMITTED + submitted_po_no=PO_E2E_T09_001
    const [rows] = await pool.query<{ status: string; submitted_po_no: string | null }[]>(
      `SELECT status, submitted_po_no FROM replenishment_draft WHERE draft_id = ?`,
      [draftId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe('SUBMITTED');
    expect(rows[0]?.submitted_po_no).toBe(FAKE_PO_NO);
  });
});
