/**
 * 切片 05 — cross-tenant-denied profile
 * 模拟 ERP 严格的多租户隔离:请求 storeId 不在白名单 → 抛错(契约级:tools/call 返回 isError:true)。
 *
 * 白名单(M001 / S001)— 模拟"商家 A 商家 B"场景:
 *   - 任意 merchantId !== 'M001' 或 storeId !== 'S001' → 抛错(模拟 ERP 拒绝跨租户)
 *
 * 切片 18 / 19 用此 profile 跑跨租户隔离 E2E。
 */
import type { ProfileFixtures } from '../../support/fixture-loader.js';
import { happyPathFixtures } from '../happy-path/index.js';

const ALLOWED_MERCHANT = 'M001';
const ALLOWED_STORE = 'S001';

function assertAllowed(input: unknown): void {
  const { merchantId, storeId } = input as { merchantId: string; storeId: string };
  if (merchantId !== ALLOWED_MERCHANT || storeId !== ALLOWED_STORE) {
    // 在 Mock 工具内抛(切片 04 BizError 契约不直接 import,
    // 因为 Mock 通过 MCP 协议返 tool error 而非 throw 跨进程实例)
    throw new Error(
      `UNAUTHORIZED: cross-tenant access denied — merchantId=${merchantId} storeId=${storeId} (allow only M001/S001)`,
    );
  }
}

function wrap<I = unknown, O = unknown>(name: string): (input: I) => O | Promise<O> {
  const fn = happyPathFixtures[name];
  if (!fn) throw new Error(`[mcp-mock] happy-path ${name} missing`);
  return ((input: I) => {
    assertAllowed(input);
    return fn(input);
  }) as (input: I) => O | Promise<O>;
}

export const crossTenantDeniedFixtures: ProfileFixtures = {
  getStoreReportConfig: wrap('getStoreReportConfig'),
  queryStoreSalesSummary: wrap('queryStoreSalesSummary'),
  queryCategorySalesRatio: wrap('queryCategorySalesRatio'),
  queryProductSalesRank: wrap('queryProductSalesRank'),
  queryInventoryOverview: wrap('queryInventoryOverview'),
  queryReplenishmentBaseData: wrap('queryReplenishmentBaseData'),
};
