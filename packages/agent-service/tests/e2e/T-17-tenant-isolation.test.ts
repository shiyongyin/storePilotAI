/**
 * 切片 19 — T-17 跨租户隔离（A 看不到 B 的 draft）
 *
 * 严格按 docs/tanks/19-test-e2e-20-cases.md §8.1 §T-17 落地：
 *   - 商户 A（M_A）创建 draft；商户 B（M_B）用自己的 ctx 调 getByIdStrict
 *   - 期望：B 调用抛 BizError(DRAFT_NOT_FOUND)；A 自己仍能拿到自己的 draft
 *   - 真 DraftManager（任务卡 §7 MUST NOT §3 — 不 mock DB）
 *
 * @since 切片 19
 */
import type { Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { logCommand } from './_helpers/chat-client.js';
import { ensureBaseEnv } from './_helpers/env.js';
import {
  asDraftPool,
  cleanTenantData,
  closeMysqlPool,
  getMysqlPool,
  isMysqlReady,
} from './_helpers/mysql.js';
import { buildE2eRuntimeContext, createWaitConfirmDraft } from './_helpers/session.js';

ensureBaseEnv();

const M_A = 'M_E2E_T17_A';
const S_A = 'S_E2E_T17_A';
const U_A = 'boss-T17-A';
const M_B = 'M_E2E_T17_B';
const S_B = 'S_E2E_T17_B';
const U_B = 'boss-T17-B';

let pool: Pool;
let draftIdA: string;

beforeAll(async () => {
  if (!isMysqlReady()) return;
  pool = getMysqlPool();
  await cleanTenantData(pool, M_A);
  await cleanTenantData(pool, M_B);

  const draftMgr = await import('../../src/safety/draft-manager.js');
  draftMgr.setDraftPool(asDraftPool(pool));

  const created = await createWaitConfirmDraft({
    pool,
    sessionId: 'sess_e2e_t17_a',
    merchantId: M_A,
    storeId: S_A,
    userId: U_A,
    apiKeyPrefix: 'sk-agent-prefixA',
  });
  draftIdA = created.draftId;
}, 30_000);

afterAll(async () => {
  if (isMysqlReady()) {
    await cleanTenantData(pool, M_A).catch(() => undefined);
    await cleanTenantData(pool, M_B).catch(() => undefined);
    await closeMysqlPool();
  }
  vi.unstubAllEnvs();
});

describe.skipIf(!isMysqlReady())('T-17 跨租户隔离（任务卡 §8.1 §T-17）', () => {
  it('B 用自己的 ctx 读 A 的 draftId → DRAFT_NOT_FOUND', async () => {
    logCommand(
      'T-17',
      'DraftManager.getByIdStrict(draftA, ctxB)',
      'throws BizError(DRAFT_NOT_FOUND)',
    );
    const draftMgr = await import('../../src/safety/draft-manager.js');
    const sharedContractsMod = await import('@storepilot/shared-contracts');

    const ctxB = buildE2eRuntimeContext({
      sessionId: 'sess_e2e_t17_b',
      merchantId: M_B,
      storeId: S_B,
      userId: U_B,
      apiKeyPrefix: 'sk-agent-prefixB',
    });

    let caught: unknown = null;
    try {
      await draftMgr.getByIdStrict(draftIdA, ctxB);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(sharedContractsMod.BizError);
    expect((caught as InstanceType<typeof sharedContractsMod.BizError>).code).toBe('DRAFT_NOT_FOUND');
  });

  it('A 自己仍能读到自己的 draft（无 false negative）', async () => {
    const draftMgr = await import('../../src/safety/draft-manager.js');
    const ctxA = buildE2eRuntimeContext({
      sessionId: 'sess_e2e_t17_a',
      merchantId: M_A,
      storeId: S_A,
      userId: U_A,
      apiKeyPrefix: 'sk-agent-prefixA',
    });
    const draft = await draftMgr.getByIdStrict(draftIdA, ctxA);
    expect(draft.draftId).toBe(draftIdA);
    expect(draft.merchantId).toBe(M_A);
    expect(draft.storeId).toBe(S_A);
  });
});
