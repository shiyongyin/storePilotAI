/**
 * 切片 19 — T-20 多实例 resume 锁（2 实例并发 → 1 RESUMED + 1 RESUME_RACE）
 *
 * 严格按 docs/tanks/19-test-e2e-20-cases.md §8.1 §T-20 + §8.5 + §7 MUST DO §9 落地：
 *   - 2 个独立 Hono app（共享同一个真实 MySQL pool）模拟 2 实例
 *   - 同一 draftId 并发 confirmDraft → 仅 1 实例返回 CONFIRMED；另一实例 RESUME_RACE
 *   - createPurchaseOrder 调用次数 ≤ 1（任务卡 §8.5 验收）
 *   - 真 ConfirmManager（FOR UPDATE + resume_locked_at 10s 租约）
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

const MERCHANT_ID = 'M_E2E_T20';
const STORE_ID = 'S_E2E_T20';
const USER_ID = 'boss-e2e-t20';
const RUN_ID = 'run_e2e_t20_multi_001';
const FAKE_PO_NO = 'PO_E2E_T20_001';

let pool: Pool;
let instance1: AgentTestHandle;
let instance2: AgentTestHandle;
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
      { role: 'system', content: 'system-prompt-T20' },
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

  // 共享 fakeResolver（2 实例都使用同一个 resolver；模拟 mastra workflow 全局单例）
  const fakeResolver = {
    getWorkflow: () => ({
      resume: async (rArgs: { runtimeContext: { get: (k: string) => unknown } }): Promise<unknown> => {
        createPoCallCount += 1;
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        const ctx = rArgs.runtimeContext as unknown as Parameters<typeof draftMgr.markSubmitted>[2];
        await draftMgr
          .transit({ draftId, from: 'WAIT_CONFIRM', to: 'CONFIRMED', runtimeContext: ctx })
          .catch(() => undefined);
        await draftMgr.markSubmitted(draftId, FAKE_PO_NO, ctx);
        return { status: 'COMPLETED' as const, poNo: FAKE_PO_NO };
      },
    }),
  };

  // 构造 2 个独立的 Hono app handle，共享同一个 MySQL pool（任务卡 §8.5）
  const buildInstance = (label: string): AgentTestHandle =>
    startAgentForTest({
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
            return { finalText: `[${label}] CONFIRMED PO=${result.poNo}` };
          }
          return { finalText: `[${label}] PREVIEW_FIRST` };
        } catch (e) {
          const code = typeof e === 'object' && e !== null && 'code' in e ? String(e.code) : null;
          const msg = e instanceof Error ? e.message : String(e);
          // RESUME_RACE / DRAFT_ALREADY_SUBMITTED 都是幂等态
          return { finalText: `[${label}] ${code ? `${code}: ` : ''}${msg}` };
        }
      },
    });

  instance1 = buildInstance('inst-1');
  instance2 = buildInstance('inst-2');
}, 30_000);

afterAll(async () => {
  if (isMysqlReady()) {
    await cleanTenantData(pool, MERCHANT_ID).catch(() => undefined);
    instance1?.cleanup();
    instance2?.cleanup();
    await closeMysqlPool();
  }
  vi.unstubAllEnvs();
});

describe.skipIf(!isMysqlReady())('T-20 多实例 resume 锁（任务卡 §8.1 §T-20）', () => {
  it('2 实例并发 confirmDraft → 仅 1 个 PO（resume_locked_at 守门）', async () => {
    logCommand(
      'T-20',
      'instance1.confirmDraft || instance2.confirmDraft（共享 MySQL）',
      '1 个 CONFIRMED + 1 个 RESUME_RACE, createPoCallCount=1, draft.SUBMITTED',
    );

    const body = {
      messages: [
        { role: 'system' as const, content: 'system-prompt-T20' },
        { role: 'user' as const, content: '确认' },
      ],
    };
    const [r1, r2] = await Promise.all([
      streamChat({ app: instance1.app, apiKey, body }),
      streamChat({ app: instance2.app, apiKey, body }),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const finalTexts = [r1.finalText, r2.finalText];
    const successCount = finalTexts.filter((text) => text.includes('CONFIRMED PO=')).length;
    const raceCount = finalTexts.filter((text) => text.includes('RESUME_RACE')).length;
    expect(successCount).toBe(1);
    expect(raceCount).toBe(1);
    // mastra.resume 只调用 1 次（FOR UPDATE + resume_locked_at 锁守门）
    expect(createPoCallCount).toBe(1);

    // DB 校验：仅 1 行 SUBMITTED + 1 个 PO
    const [drafts] = await pool.query<{ status: string; submitted_po_no: string | null }[]>(
      `SELECT status, submitted_po_no FROM replenishment_draft WHERE draft_id = ?`,
      [draftId],
    );
    expect(drafts[0]?.status).toBe('SUBMITTED');
    expect(drafts[0]?.submitted_po_no).toBe(FAKE_PO_NO);

    expect(finalTexts.join('\n')).toContain(FAKE_PO_NO);
  });
});
