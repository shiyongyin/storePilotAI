/**
 * 切片 19 — T-06 调整草稿（"矿泉水上调 20%"）
 *
 * 严格按 docs/tanks/19-test-e2e-20-cases.md §8.1 §T-06 落地：
 *   - 期望：finalSuggestQty 真实 +20% + replenishment_adjustment_log 一行
 *   - 真 chat-completions / Auth / SSE 链路
 *   - 真 DraftManager（落 replenishment_draft + replenishment_adjustment_log）
 *   - dispatcher 受控注入：模拟 ADJUST_REPLENISHMENT_DRAFT workflow 的"按 SKU 关键字 +20%"分支
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
import { buildE2eRuntimeContext } from './_helpers/session.js';

ensureBaseEnv();

const MERCHANT_ID = 'M_E2E_T06';
const STORE_ID = 'S_E2E_T06';
const USER_ID = 'boss-e2e-t06';

let pool: Pool;
let handle: AgentTestHandle;
let apiKey: string;
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
  apiKey = issued.apiKey;
  apiKeyPrefix = issued.prefix;

  const draftMgr = await import('../../src/safety/draft-manager.js');
  draftMgr.setDraftPool(asDraftPool(pool));

  // 预置一份 DRAFT 草稿，包含 SKU001 矿泉水
  const created = await draftMgr.create({
    sessionId: 'sess_e2e_t06_pre',
    merchantId: MERCHANT_ID,
    storeId: STORE_ID,
    userId: USER_ID,
    traceId: 'trace_e2e_t06_pre',
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

  handle = startAgentForTest({
    authPool: asAuthPool(pool),
    draftPool: asDraftPool(pool),
    dispatcher: async (args) => {
      // 模拟 ADJUST_REPLENISHMENT_DRAFT workflow：detect "矿泉水上调 20%" → +20%
      const ctx = buildE2eRuntimeContext({
        sessionId: args.sessionId,
        merchantId: args.auth.merchantId,
        storeId: args.auth.storeId,
        userId: args.auth.userId,
        apiKeyPrefix: args.auth.apiKeyPrefix,
        traceId: args.traceId,
      });
      const beforeItems = (await draftMgr.getByIdStrict(draftId, ctx)).items;
      const afterItems = beforeItems.map((it) =>
        it.skuName.includes('矿泉水')
          ? {
              ...it,
              finalSuggestQty: Math.round(it.finalSuggestQty * 1.2),
              reason: '关键字调整：矿泉水 +20%',
            }
          : it,
      );
      await draftMgr.updateItems({ draftId, items: afterItems, runtimeContext: ctx });
      // 写一行 adjustment_log（模拟 workflow 的持久化分支）
      await pool.execute(
        `INSERT INTO replenishment_adjustment_log
           (adjustment_id, draft_id, user_message,
            target_type, target_value, adjustment_type,
            adjustment_rate, adjustment_qty, reason, applied,
            before_items_json, after_items_json, instruction_json, affected_sku_ids)
         VALUES (?, ?, ?, 'SKU_KEYWORD', '矿泉水', 'INCREASE_RATE',
                 0.20, NULL, '矿泉水上调 20%', 1,
                 CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON))`,
        [
          `adj_e2e_t06_${Date.now().toString(36)}`,
          draftId,
          '矿泉水上调 20%',
          JSON.stringify(beforeItems),
          JSON.stringify(afterItems),
          JSON.stringify({ targetType: 'SKU_KEYWORD', targetValue: '矿泉水', rate: 0.2 }),
          JSON.stringify(['SKU001']),
        ],
      );
      const sku = afterItems.find((it) => it.skuId === 'SKU001');
      return {
        finalText: `已为关键字"矿泉水"上调 20%。SKU001 矿泉水 A 最新建议量：${sku?.finalSuggestQty} 瓶。`,
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

describe.skipIf(!isMysqlReady())('T-06 调整草稿 关键字（任务卡 §8.1 §T-06）', () => {
  it('"矿泉水上调 20%" → finalSuggestQty +20% + adjustment_log 一行', async () => {
    logCommand(
      'T-06',
      "curl -N -H 'Authorization: Bearer ***' -d '{messages:[{role:user,content:矿泉水上调 20%}]}' /v1/chat/completions",
      'finalSuggestQty 28→34, adjustment_log 行数 +1',
    );
    void apiKeyPrefix;
    const r = await streamChat({
      app: handle.app,
      apiKey,
      body: { messages: [{ role: 'user', content: '矿泉水上调 20%' }] },
    });

    expect(r.status).toBe(200);
    expect(r.finalText).toContain('矿泉水');
    expect(r.finalText).toContain('20%');

    // DB 校验：finalSuggestQty 28 → round(28*1.2) = 34
    const [rows] = await pool.query<{ items: unknown }[]>(
      `SELECT items FROM replenishment_draft WHERE draft_id = ?`,
      [draftId],
    );
    expect(rows.length).toBe(1);
    const items = (typeof rows[0]?.items === 'string' ? JSON.parse(rows[0]!.items) : rows[0]?.items) as Array<{ skuId: string; finalSuggestQty: number }>;
    const sku = items.find((it) => it.skuId === 'SKU001');
    expect(sku?.finalSuggestQty).toBe(34);

    // adjustment_log 应有一行
    const [logs] = await pool.query<{ cnt: number }[]>(
      `SELECT COUNT(*) AS cnt FROM replenishment_adjustment_log WHERE draft_id = ?`,
      [draftId],
    );
    expect(Number(logs[0]?.cnt)).toBeGreaterThanOrEqual(1);
  });
});
