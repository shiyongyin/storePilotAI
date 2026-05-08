/**
 * 切片 05 — slow-sales-summary profile
 * 仅覆写 queryStoreSalesSummary,故意 sleep > MCP_TOOL_TIMEOUT_MS。
 * 切片 08(mcpClient)+ 切片 18(测试)用此 profile 验证 runWithTimeoutAndRetry。
 */
import type { ProfileFixtures } from '../../support/fixture-loader.js';
import { happyPathFixtures } from '../happy-path/index.js';

const SLEEP_MS = 30_000; // 远超默认 MCP_TOOL_TIMEOUT_MS=15000

export const slowSalesSummaryFixtures: ProfileFixtures = {
  queryStoreSalesSummary: async (input: unknown) => {
    await new Promise((r) => setTimeout(r, SLEEP_MS));
    const fn = happyPathFixtures.queryStoreSalesSummary;
    if (!fn) throw new Error('[mcp-mock] happy-path queryStoreSalesSummary missing');
    return fn(input);
  },
};
