/**
 * 切片 19 — T-07 调整草稿不匹配（"调高 SKUXXX"）
 *
 * 严格按 docs/tanks/19-test-e2e-20-cases.md §8.1 §T-07 落地：
 *   - 期望：不修改 draft + 友好提示
 *   - 真 chat-completions / Auth / SSE 链路
 *   - 真 DraftManager（落 replenishment_draft；本测试不应触发 updateItems）
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
  asDraftPool,
  cleanTenantData,
  closeMysqlPool,
  getMysqlPool,
  isMysqlReady,
} from './_helpers/mysql.js';
import { startAgentForTest, type AgentTestHandle } from './_helpers/agent-app.js';

ensureBaseEnv();

const MERCHANT_ID = 'M_E2E_T07';
const STORE_ID = 'S_E2E_T07';
const USER_ID = 'boss-e2e-t07';

let pool: Pool;
let handle: AgentTestHandle;
let apiKey: string;
let draftId: string;
let beforeItemsSnapshot: string;

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

  const draftMgr = await import('../../src/safety/draft-manager.js');
  draftMgr.setDraftPool(asDraftPool(pool));
  const created = await draftMgr.create({
    sessionId: 'sess_e2e_t07_pre',
    merchantId: MERCHANT_ID,
    storeId: STORE_ID,
    userId: USER_ID,
    traceId: 'trace_e2e_t07_pre',
    forecastDays: 7,
    items: [
      {
        skuId: 'SKU001',
        skuName: '矿泉水 A',
        unit: '瓶',
        category: '饮品',
        onHandQty: 10,
        inTransitQty: 0,
        leadTimeDays: 2,
        packSize: 1,
        recentDailyAvg: 5.5,
        baseSuggestQty: 28,
        finalSuggestQty: 28,
        reason: 'baseline',
      },
    ],
    strategyVersion: 'P1-M0-S0',
  });
  draftId = created.draftId;

  // 抓初始 items snapshot 用于"未变"断言
  const [rows] = await pool.query<{ items: unknown }[]>(
    `SELECT items FROM replenishment_draft WHERE draft_id = ?`,
    [draftId],
  );
  beforeItemsSnapshot = JSON.stringify(rows[0]?.items);

  handle = startAgentForTest({
    authPool: asAuthPool(pool),
    draftPool: asDraftPool(pool),
    dispatcher: async () => {
      // 不匹配 → 友好提示，不写 DB
      return {
        finalText: '抱歉，没有匹配到"SKUXXX"对应的商品；请回复确切 SKU 编号或品类关键字。',
      };
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

describe.skipIf(!isMysqlReady())('T-07 调整草稿不匹配（任务卡 §8.1 §T-07）', () => {
  it('"调高 SKUXXX" → 友好提示 + draft 未变 + adjustment_log 0 行', async () => {
    logCommand(
      'T-07',
      "curl -N -H 'Authorization: Bearer ***' -d '{messages:[{role:user,content:调高 SKUXXX}]}' /v1/chat/completions",
      'finalText 含"没有匹配到", draft items 不变, adjustment_log 0 行',
    );
    const r = await streamChat({
      app: handle.app,
      apiKey,
      body: { messages: [{ role: 'user', content: '调高 SKUXXX 50%' }] },
    });

    expect(r.status).toBe(200);
    expect(r.finalText).toContain('没有匹配到');

    // draft items 不变
    const [rows] = await pool.query<{ items: unknown }[]>(
      `SELECT items FROM replenishment_draft WHERE draft_id = ?`,
      [draftId],
    );
    expect(JSON.stringify(rows[0]?.items)).toBe(beforeItemsSnapshot);

    // adjustment_log 不应有行
    const [logs] = await pool.query<{ cnt: number }[]>(
      `SELECT COUNT(*) AS cnt FROM replenishment_adjustment_log WHERE draft_id = ?`,
      [draftId],
    );
    expect(Number(logs[0]?.cnt)).toBe(0);
  });
});
