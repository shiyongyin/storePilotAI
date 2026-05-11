import { describe, expect, it } from 'vitest';

import { ToolContracts, TOOL_NAMES } from './index.js';
import { MARKETING_GROWTH_TOOLS, MarketingToolContracts } from './marketing.js';

describe('TOOL_NAMES(SSOT,字典序)', () => {
  it('TOOL_NAMES.length === 16(V1 7 + V2 marketing 9)', () => {
    expect(TOOL_NAMES).toHaveLength(16);
  });

  it('TOOL_NAMES 与 ToolContracts keys 一致', () => {
    expect(new Set(TOOL_NAMES)).toEqual(new Set(Object.keys(ToolContracts)));
  });

  it('TOOL_NAMES 严格字典序', () => {
    const sorted = [...TOOL_NAMES].sort();
    expect(TOOL_NAMES).toEqual(sorted);
  });

  it('TOOL_NAMES 完整 16 项符合 SSOT', () => {
    expect(TOOL_NAMES).toEqual([
      'createPurchaseOrder',
      'getStoreReportConfig',
      'queryCategorySalesRatio',
      'queryInventoryOverview',
      'queryProductSalesRank',
      'queryReplenishmentBaseData',
      'queryStoreSalesSummary',
      'query_campaign_history',
      'query_coupon_inventory',
      'query_inventory_status',
      'query_member_consumption_history',
      'query_member_profile',
      'query_member_segments',
      'query_pos_summary_by_time',
      'query_product_performance',
      'query_repurchase_cycle',
    ]);
  });

  it.each([...TOOL_NAMES])('ToolContracts[%s] 含 input + output schema', (name) => {
    const c = ToolContracts[name];
    expect(c).toBeDefined();
    expect(typeof c.input.parse).toBe('function');
    expect(typeof c.output.parse).toBe('function');
  });
});

describe('MARKETING_GROWTH_TOOLS(V2 Phase1 SSOT)', () => {
  it('包含 9 个只读营销工具且严格字典序', () => {
    expect(MARKETING_GROWTH_TOOLS).toEqual([
      'query_campaign_history',
      'query_coupon_inventory',
      'query_inventory_status',
      'query_member_consumption_history',
      'query_member_profile',
      'query_member_segments',
      'query_pos_summary_by_time',
      'query_product_performance',
      'query_repurchase_cycle',
    ]);
  });

  it('MarketingToolContracts 与 MARKETING_GROWTH_TOOLS 完全一致', () => {
    expect(new Set(Object.keys(MarketingToolContracts))).toEqual(new Set(MARKETING_GROWTH_TOOLS));
  });

  it.each([...MARKETING_GROWTH_TOOLS])('MarketingToolContracts[%s] 含 input + output schema', (name) => {
    const c = MarketingToolContracts[name];
    expect(c).toBeDefined();
    expect(typeof c.input.parse).toBe('function');
    expect(typeof c.output.parse).toBe('function');
  });
});
