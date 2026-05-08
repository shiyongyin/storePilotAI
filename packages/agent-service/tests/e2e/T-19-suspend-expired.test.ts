/**
 * 切片 19 — T-19 suspend 30 分钟过期（fake timer + cron Job）
 *
 * 严格按 docs/tanks/19-test-e2e-20-cases.md §8.1 §T-19 + §8.4 + §7 MUST DO §8 落地：
 *   - 触发 suspend → 跳 31 分钟（用 fake timer + 直接插入"已过期"的 suspend 行）
 *   - 跑 expireSuspendedRunsJob → draft.status=CANCELLED + agent_session.active_run_id=NULL
 *   - 真实 mastra_workflow_suspend / agent_session / replenishment_draft（不 mock DB）
 *
 * 实现说明：MySQL NOW(3) 由 server 时钟决定，无法被 vi.useFakeTimers 影响；
 * 我们通过"insertWorkflowSuspend(expiresInSecondsFromNow=-60)"直接构造已过期行，
 * 等价于"31 分钟前 suspend → 现在过期"的语义。fake timer 仍开启，确保 cron 内部
 * setTimeout/setInterval 不会真等。
 *
 * @since 切片 19
 */
import type { Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { issueE2eApiKey } from './_helpers/api-key.js';
import { logCommand } from './_helpers/chat-client.js';
import { ensureBaseEnv } from './_helpers/env.js';
import {
  asConfirmManagerPool,
  asDraftPool,
  cleanTenantData,
  closeMysqlPool,
  getMysqlPool,
  isMysqlReady,
} from './_helpers/mysql.js';
import {
  createWaitConfirmDraft,
  insertWorkflowSuspend,
  newSessionId,
  upsertAgentSession,
} from './_helpers/session.js';

ensureBaseEnv();

const MERCHANT_ID = 'M_E2E_T19';
const STORE_ID = 'S_E2E_T19';
const USER_ID = 'boss-e2e-t19';
const RUN_ID = 'run_e2e_t19_expired_001';

let pool: Pool;
let sessionId: string;
let draftId: string;
let apiKeyPrefix: string;

beforeAll(async () => {
  if (!isMysqlReady()) return;
  pool = getMysqlPool();
  await cleanTenantData(pool, MERCHANT_ID);

  const issued = await issueE2eApiKey(pool, {
    merchantId: MERCHANT_ID,
    storeId: STORE_ID,
    userId: USER_ID,
  });
  apiKeyPrefix = issued.prefix;
  sessionId = newSessionId('sess_t19');

  const draftMgr = await import('../../src/safety/draft-manager.js');
  draftMgr.setDraftPool(asDraftPool(pool));

  const confirmMgr = await import('../../src/safety/confirm-manager.js');
  confirmMgr.setConfirmManagerPool(asConfirmManagerPool(pool));
  // 注入伪 MastraResolver（cron 内会尝试 resume(CANCEL)；任意 noop 实现都可，
  // job 已对错误 swallow）
  confirmMgr.setMastraResolver({
    getWorkflow: () => ({
      resume: async (): Promise<unknown> => ({ status: 'CANCELLED' as const }),
    }),
  });

  const created = await createWaitConfirmDraft({
    pool,
    sessionId,
    merchantId: MERCHANT_ID,
    storeId: STORE_ID,
    userId: USER_ID,
    apiKeyPrefix,
  });
  draftId = created.draftId;

  // active_run_id + 已过期的 suspend（expires_at = NOW - 60s）
  await upsertAgentSession(pool, {
    sessionId,
    apiKeyPrefix,
    merchantId: MERCHANT_ID,
    storeId: STORE_ID,
    userId: USER_ID,
    activeRunId: RUN_ID,
    activeRunStep: 'ask-confirm',
    activeDraftId: draftId,
    activeRunExpiresAtSec: -60, // 31 分钟前已过期等价
  });
  await insertWorkflowSuspend(pool, { runId: RUN_ID, expiresInSecondsFromNow: -60 });
}, 30_000);

afterAll(async () => {
  if (isMysqlReady()) {
    await cleanTenantData(pool, MERCHANT_ID).catch(() => undefined);
    await closeMysqlPool();
  }
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe.skipIf(!isMysqlReady())('T-19 suspend 30 分钟过期（任务卡 §8.1 §T-19）', () => {
  it('fake timer + expireSuspendedRunsJob → draft.CANCELLED + active_run_id=NULL', async () => {
    logCommand(
      'T-19',
      'vi.useFakeTimers + insert(expires=NOW-60s) + expireSuspendedRunsJob',
      'draft.status=CANCELLED, agent_session.active_run_id=NULL, suspend 行清空',
    );
    vi.useFakeTimers();
    // 模拟跳 31 分钟（任务卡 §8.4 写法）；本测试 expires_at 已为过去，advanceTimersByTime
    // 主要是为了验证 cron 路径不会因 setTimeout 真等而超 30s 上限。
    vi.advanceTimersByTime(31 * 60 * 1000);

    const job = await import('../../src/safety/jobs/expire-suspended-runs.js');
    const result = await job.expireSuspendedRunsJob();

    // job 至少处理了 1 行（我们这唯一的过期 suspend）
    expect(result.totalProcessed).toBeGreaterThanOrEqual(1);

    // mastra_workflow_suspend 应该被清空（DELETE）
    const [suspendRows] = await pool.query<{ cnt: number }[]>(
      `SELECT COUNT(*) AS cnt FROM mastra_workflow_suspend WHERE run_id = ?`,
      [RUN_ID],
    );
    expect(Number(suspendRows[0]?.cnt)).toBe(0);

    // agent_session.active_run_id 应被清空
    const [sessions] = await pool.query<{ active_run_id: string | null }[]>(
      `SELECT active_run_id FROM agent_session WHERE session_id = ?`,
      [sessionId],
    );
    expect(sessions[0]?.active_run_id).toBe(null);

    // draft 应被转为 CANCELLED
    const [drafts] = await pool.query<{ status: string }[]>(
      `SELECT status FROM replenishment_draft WHERE draft_id = ?`,
      [draftId],
    );
    expect(drafts[0]?.status).toBe('CANCELLED');

    vi.useRealTimers();
  }, 30_000);
});
