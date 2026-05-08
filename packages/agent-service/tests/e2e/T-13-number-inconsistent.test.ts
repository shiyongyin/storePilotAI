/**
 * 切片 19 — T-13 OutputValidator：数字伪造拦截（安全网 2/3）
 *
 * 严格按 docs/tanks/19-test-e2e-20-cases.md §8.1 §T-13 + 切片 11 落地：
 *   - dispatcher 在内部调 validateOutput（schema + 数字一致性）
 *   - 故意造一个含"12345"的 markdown，但工具白名单不含 12345 → NUMBER_INCONSISTENT
 *   - 期望：dispatcher catch BizError → friendlyMessage 兜底；SSE 仍 200
 *   - 真 chat-completions / Auth / SSE 链路
 *
 * @since 切片 19
 */
import type { Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { issueE2eApiKey } from './_helpers/api-key.js';
import { logCommand, streamChat } from './_helpers/chat-client.js';
import { ensureBaseEnv } from './_helpers/env.js';
import {
  asAuthPool,
  cleanTenantData,
  closeMysqlPool,
  getMysqlPool,
  isMysqlReady,
} from './_helpers/mysql.js';
import { startAgentForTest, type AgentTestHandle } from './_helpers/agent-app.js';

ensureBaseEnv();

const MERCHANT_ID = 'M_E2E_T13';
const STORE_ID = 'S_E2E_T13';
const USER_ID = 'boss-e2e-t13';

let pool: Pool;
let handle: AgentTestHandle;
let apiKey: string;

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

  const validatorMod = await import('../../src/safety/output-validator.js');
  const sharedContractsMod = await import('@storepilot/shared-contracts');

  // 故意造一个含"12345"的 markdown（不在 allowed 列表中）
  const FORGED_MARKDOWN = `# 经营日报

今日营业额 ¥12345 元（伪造数字，工具未返回）。

## 数据来源
- 营业额 = 100（queryStoreSalesSummary）
`;

  handle = startAgentForTest({
    authPool: asAuthPool(pool),
    dispatcher: async () => {
      try {
        validatorMod.validateOutput({
          schema: z.object({ summaryMarkdown: z.string() }),
          output: { summaryMarkdown: FORGED_MARKDOWN },
          allowedNumbers: new Set(['100']), // 仅 100 在白名单
          enforceNumberConsistency: true,
        });
        return { finalText: FORGED_MARKDOWN };
      } catch (e) {
        if (e instanceof sharedContractsMod.BizError) {
          return { finalText: sharedContractsMod.friendlyMessage(e) };
        }
        return { finalText: '校验失败' };
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

describe.skipIf(!isMysqlReady())('T-13 OutputValidator：数字伪造拦截（任务卡 §8.1 §T-13）', () => {
  it('注入 12345 → NUMBER_INCONSISTENT → friendlyMessage（不返回伪造 markdown）', async () => {
    logCommand(
      'T-13',
      "curl -N /v1/chat/completions （dispatcher 故意 markdown 含 12345，工具仅返回 100）",
      'status=200, finalText 不含 12345，含 friendly 提示',
    );
    const r = await streamChat({
      app: handle.app,
      apiKey,
      body: { messages: [{ role: 'user', content: '今天营业额多少？' }] },
    });
    expect(r.status).toBe(200);
    // 关键：finalText 不能含伪造数字 12345（被验证器拦截）
    expect(r.finalText).not.toContain('12345');
    // friendlyMessage 兜底（NUMBER_INCONSISTENT 的 friendly text 通常含"系统忙"或"出错"等）
    expect(r.finalText.length).toBeGreaterThan(0);
    expect(r.events.some((e) => e.data === '[DONE]')).toBe(true);
  });
});
