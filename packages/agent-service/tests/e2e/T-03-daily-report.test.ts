/**
 * 切片 19 — T-03 日报 happy path（intent=BUSINESS_DAILY_REPORT）
 *
 * 严格按 docs/tanks/19-test-e2e-20-cases.md §8.1 §T-03 落地：
 *   - 真 API Key（issueE2eApiKey 写真实 agent_api_key）
 *   - 真 chat-completions / Auth / OutputGuard / SSE 链路
 *   - 受控 dispatcher 注入（任务卡 §6 MUST DO §3 + §7 MUST NOT §2 — 不依赖外网 LLM）
 *   - 不写 process.env（§7 MUST NOT §6）
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

const MERCHANT_ID = 'M_E2E_T03';
const STORE_ID = 'S_E2E_T03';
const USER_ID = 'boss-e2e-t03';

let pool: Pool;
let handle: AgentTestHandle;
let apiKey: string;

const HAPPY_DAILY_MARKDOWN = `# 经营日报

今日营业 8 小时，共 156 笔订单，营业额 ¥4,520。

## 关键数据
- 客单价：¥28.97
- 客流量：156 人

## 数据来源
- 本日订单数 = 156（queryStoreSalesSummary）
- 本日营业额 = 4520（queryStoreSalesSummary）
`;

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
    // 受控 dispatcher：意图层由 chat-completions / OutputGuard 真实链路覆盖；
    // workflow 内部依赖外网 LLM（compose-markdown），E2E 不打外网（任务卡 §7 MUST NOT §2）。
    dispatcher: async () => ({ finalText: HAPPY_DAILY_MARKDOWN }),
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

describe.skipIf(!isMysqlReady())('T-03 日报 happy path（任务卡 §8.1 §T-03）', () => {
  it('POST /v1/chat/completions stream → 200 + 含日报 markdown', async () => {
    logCommand(
      'T-03',
      "curl -N -H 'Authorization: Bearer ***' -d '{messages:[{role:user,content:今天经营如何}]}' /v1/chat/completions",
      'status=200, finalText 含 ## 数据来源 段; 不含 6 项禁用 token',
    );
    const r = await streamChat({
      app: handle.app,
      apiKey,
      body: { messages: [{ role: 'user', content: '今天经营如何？' }] },
    });

    expect(r.status).toBe(200);
    expect(r.finalText).toContain('经营日报');
    expect(r.finalText).toMatch(/##\s*数据来源/);

    // 6 项禁用 token 一项不能漏（OutputGuard 守门）
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

    // SSE 终结符
    expect(r.events.some((e) => e.data === '[DONE]')).toBe(true);
  });
});
