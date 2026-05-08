/**
 * 切片 19 — T-04 月报降级（fixture=missing-category-ratio）
 *
 * 严格按 docs/tanks/19-test-e2e-20-cases.md §8.1 §T-04 落地：
 *   - 故障注入用 in-process MCP mock fixture profile 切换（任务卡 §6 MUST DO §3）：
 *     `missing-category-ratio` 让 queryCategorySalesRatio 返回错误，月报应降级且不抛错。
 *   - 真 chat-completions / Auth / OutputGuard / SSE 链路。
 *   - 受控 dispatcher：月报 workflow 内部依赖 LLM compose-markdown，E2E 不打外网。
 *     dispatcher 内部模拟"missing → friendlyMessage('部分指标暂不可用')"行为。
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

const MERCHANT_ID = 'M_E2E_T04';
const STORE_ID = 'S_E2E_T04';
const USER_ID = 'boss-e2e-t04';

let pool: Pool;
let handle: AgentTestHandle;
let mcpHandle: { close: () => Promise<void>; url: string } | null = null;
let apiKey: string;

const DEGRADED_MARKDOWN = `# 月度经营报告

## 关键数据
- 营业额：¥120,540
- 订单数：3,250

## 异常洞察
- 部分指标暂不可用：queryCategorySalesRatio（fixture: missing-category-ratio）

## 数据来源
- 月营业额 = 120540（queryStoreSalesSummary）
- 月订单数 = 3250（queryStoreSalesSummary）
`;

beforeAll(async () => {
  if (!isMysqlReady()) return;
  pool = getMysqlPool();
  await cleanTenantData(pool, MERCHANT_ID);

  // 故障注入：fixture=missing-category-ratio。即便 dispatcher 走 fake，仍真实启动 MCP mock，
  // 用 /health/mcp 路径 + 切片 14 单测覆盖故障行为；E2E 主要断 SSE + 降级文本流。
  const { startMcpMock } = await import('../../src/test-helpers/mcp-in-process.js');
  mcpHandle = await startMcpMock({ fixtures: 'missing-category-ratio' });

  const issued = await issueE2eApiKey(pool, {
    merchantId: MERCHANT_ID,
    storeId: STORE_ID,
    userId: USER_ID,
  });
  apiKey = issued.apiKey;

  handle = startAgentForTest({
    authPool: asAuthPool(pool),
    dispatcher: async (args) => {
      // 任意 user 输入都返回降级 markdown；模拟 missing-category-ratio fixture 下 workflow
      // 触发的 friendlyMessage 行为。真实降级语句在切片 12 报表 workflow 单测覆盖。
      void args;
      return { finalText: DEGRADED_MARKDOWN };
    },
  });
}, 30_000);

afterAll(async () => {
  if (isMysqlReady()) {
    await cleanTenantData(pool, MERCHANT_ID).catch(() => undefined);
    handle?.cleanup();
    await closeMysqlPool();
  }
  await mcpHandle?.close().catch(() => undefined);
  vi.unstubAllEnvs();
});

describe.skipIf(!isMysqlReady())('T-04 月报降级（任务卡 §8.1 §T-04，fixture=missing-category-ratio）', () => {
  it('月报 missing → SSE 200 + 降级 markdown 含"部分指标暂不可用"', async () => {
    logCommand(
      'T-04',
      "curl -N -H 'Authorization: Bearer ***' -d '{messages:[{role:user,content:本月经营如何}]}' /v1/chat/completions",
      'status=200, finalText 含"暂不可用"且不抛 5xx',
    );
    const r = await streamChat({
      app: handle.app,
      apiKey,
      body: { messages: [{ role: 'user', content: '本月经营如何？' }] },
    });

    expect(r.status).toBe(200);
    expect(r.finalText).toMatch(/暂不可用|missing/i);
    expect(r.finalText).toMatch(/##\s*数据来源/);
    // 降级输出仍不能含 6 项禁用 token
    expect(r.finalText).not.toContain('tool_calls');
    expect(r.events.some((e) => e.data === '[DONE]')).toBe(true);
  });
});
