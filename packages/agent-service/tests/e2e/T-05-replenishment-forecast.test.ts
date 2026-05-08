/**
 * 切片 19 — T-05 补货预测落库（intent=REPLENISHMENT_PLAN）
 *
 * 严格按 docs/tanks/19-test-e2e-20-cases.md §8.1 §T-05 落地：
 *   - 期望：DRAFT 表新行 + items 与 markdown 数字一致
 *   - 真 chat-completions / Auth / OutputGuard / SSE 链路
 *   - dispatcher 受控注入：内部走 DraftManager.create 落 replenishment_draft，再返回 markdown
 *   - 不依赖外网（任务卡 §7 MUST NOT §2）：LLM compose 由 fake markdown 替代，
 *     但落库路径完全真实（DraftManager → 真 MySQL）
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

const MERCHANT_ID = 'M_E2E_T05';
const STORE_ID = 'S_E2E_T05';
const USER_ID = 'boss-e2e-t05';

let pool: Pool;
let handle: AgentTestHandle;
let apiKey: string;
let draftIdCreated: string | undefined;

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

  handle = startAgentForTest({
    authPool: asAuthPool(pool),
    draftPool: asDraftPool(pool),
    dispatcher: async (args) => {
      // 真实落 replenishment_draft —— DRAFT 状态由 DraftManager.create 写入。
      const created = await draftMgr.create({
        sessionId: args.sessionId,
        merchantId: args.auth.merchantId,
        storeId: args.auth.storeId,
        userId: args.auth.userId,
        traceId: args.traceId,
        forecastDays: 7,
        items: [
          {
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
          },
        ],
        strategyVersion: 'P1-M0-S0',
      });
      draftIdCreated = created.draftId;
      return {
        finalText: `# 补货建议（草稿）

## 待确认 SKU
- SKU001 测试商品 A：建议 28 瓶（基础 28，最终 28）

## 数据来源
- 在手 SKU001 = 10（queryReplenishmentBaseData）
- 日均 SKU001 = 5.5（queryReplenishmentBaseData）
- 建议最终量 SKU001 = 28（calculator.computeSku）

如需提交采购单，请回复"确认下单"。
`,
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

describe.skipIf(!isMysqlReady())('T-05 补货预测落库（任务卡 §8.1 §T-05）', () => {
  it('补货请求 → 200 + replenishment_draft 新行 + markdown 数字一致', async () => {
    logCommand(
      'T-05',
      "curl -N -H 'Authorization: Bearer ***' -d '{messages:[{role:user,content:算一份 7 天补货}]}' /v1/chat/completions",
      'status=200, draft 表新增 1 行 status=DRAFT, markdown 数字与 items 一致',
    );
    const r = await streamChat({
      app: handle.app,
      apiKey,
      body: { messages: [{ role: 'user', content: '算一份 7 天补货' }] },
    });

    expect(r.status).toBe(200);
    expect(draftIdCreated).toBeDefined();

    // markdown 与 items 数字一致（28 / 10 / 5.5 都在 markdown 里）
    expect(r.finalText).toContain('SKU001');
    expect(r.finalText).toMatch(/\b28\b/);
    expect(r.finalText).toMatch(/\b10\b/);
    expect(r.finalText).toMatch(/\b5\.5\b/);
    expect(r.finalText).toMatch(/##\s*数据来源/);

    // DB 端校验：replenishment_draft 中应有 1 行 status=DRAFT
    const [rows] = await pool.query<{ status: string; merchant_id: string; store_id: string }[]>(
      `SELECT status, merchant_id, store_id FROM replenishment_draft WHERE draft_id = ?`,
      [draftIdCreated],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe('DRAFT');
    expect(rows[0]?.merchant_id).toBe(MERCHANT_ID);
    expect(rows[0]?.store_id).toBe(STORE_ID);
  });
});
