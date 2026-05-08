/**
 * 切片 19 — T-12 OutputGuard：tool_calls 泄漏拦截（安全网 1/3）
 *
 * 严格按 docs/tanks/19-test-e2e-20-cases.md §8.1 §T-12 落地：
 *   - dispatcher 受控注入：故意返回含 'tool_calls' 字面值的 finalText
 *   - 期望：OutputGuard 命中 → BizError(TOOL_CALLS_LEAK, httpStatus=502) → friendlyMessage
 *   - SSE 链路应继续返回 200（错误转 friendly text；不抛 5xx）
 *   - 真 chat-completions / Auth / SSE 链路；P0 metric 由 logToolCallsLeak 触发（本测试不直接断 metric）
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
  cleanTenantData,
  closeMysqlPool,
  getMysqlPool,
  isMysqlReady,
} from './_helpers/mysql.js';
import { startAgentForTest, type AgentTestHandle } from './_helpers/agent-app.js';

ensureBaseEnv();

const MERCHANT_ID = 'M_E2E_T12';
const STORE_ID = 'S_E2E_T12';
const USER_ID = 'boss-e2e-t12';

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

  handle = startAgentForTest({
    authPool: asAuthPool(pool),
    // 注入"故意泄漏"dispatcher：返回含 6 项禁用 token 之一（任务卡 §8.1 §T-12）
    dispatcher: async () => ({
      finalText: '正在为您准备日报...{"tool_calls":[{"id":"x","name":"queryStoreSalesSummary"}]}',
    }),
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

describe.skipIf(!isMysqlReady())('T-12 OutputGuard：tool_calls 泄漏拦截（任务卡 §8.1 §T-12）', () => {
  it('dispatcher 输出含 tool_calls → SSE 200 + friendlyMessage（不含 6 项禁用 token）', async () => {
    logCommand(
      'T-12',
      "curl -N -H 'Authorization: Bearer ***' /v1/chat/completions （dispatcher 故意返回 tool_calls 字面值）",
      'status=200, finalText 不含任何 6 项禁用 token, 含 friendly 提示',
    );
    const r = await streamChat({
      app: handle.app,
      apiKey,
      body: { messages: [{ role: 'user', content: '今天经营如何？' }] },
    });

    expect(r.status).toBe(200);
    // OutputGuard 必须把 6 项禁用 token 都拦掉
    for (const t of [
      'tool_calls',
      'tool_call_id',
      'function_call',
      '<tool>',
      '</tool>',
      '"function":{"name"',
    ]) {
      expect(r.finalText).not.toContain(t);
    }
    // friendlyMessage 兜底文案
    expect(r.finalText).toMatch(/出现了一点小问题|系统忙|稍后再试|⚠️/);
    expect(r.events.some((e) => e.data === '[DONE]')).toBe(true);
  });
});
