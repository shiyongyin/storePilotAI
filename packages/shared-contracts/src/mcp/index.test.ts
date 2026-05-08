/**
 * 切片 05 — ToolContracts barrel + TOOL_NAMES 单测
 * 关键断言:7 项 + 字典序 + 与切片 08 启动期白名单 JSON.stringify 严格相等比对依据
 */
import { describe, expect, it } from 'vitest';

import { ToolContracts, TOOL_NAMES } from './index.js';

describe('TOOL_NAMES(切片 05 SSOT,字典序)', () => {
  it('TOOL_NAMES.length === 7', () => {
    expect(TOOL_NAMES).toHaveLength(7);
  });

  it('TOOL_NAMES 与 ToolContracts keys 一致', () => {
    expect(new Set(TOOL_NAMES)).toEqual(new Set(Object.keys(ToolContracts)));
  });

  it('TOOL_NAMES 严格字典序', () => {
    const sorted = [...TOOL_NAMES].sort();
    expect(TOOL_NAMES).toEqual(sorted);
  });

  it('TOOL_NAMES 完整 7 项符合 SSOT', () => {
    expect(TOOL_NAMES).toEqual([
      'createPurchaseOrder',
      'getStoreReportConfig',
      'queryCategorySalesRatio',
      'queryInventoryOverview',
      'queryProductSalesRank',
      'queryReplenishmentBaseData',
      'queryStoreSalesSummary',
    ]);
  });

  it.each([...TOOL_NAMES])('ToolContracts[%s] 含 input + output schema', (name) => {
    const c = ToolContracts[name];
    expect(c).toBeDefined();
    expect(typeof c.input.parse).toBe('function');
    expect(typeof c.output.parse).toBe('function');
  });
});
