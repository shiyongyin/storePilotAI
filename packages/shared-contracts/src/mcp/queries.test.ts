/**
 * 切片 05 — 5 个 QUERY 工具(getStoreReportConfig + 4 报表 + queryInventoryOverview)单测
 * 行为断言:happy + 关键边界(精度 / 枚举 / range)
 */
import { describe, expect, it } from 'vitest';

import {
  getStoreReportConfig,
  queryCategorySalesRatio,
  queryInventoryOverview,
  queryProductSalesRank,
  queryStoreSalesSummary,
} from './index.js';

describe('getStoreReportConfig', () => {
  it('happy', () => {
    expect(() => getStoreReportConfig.input.parse({ merchantId: 'M', storeId: 'S' })).not.toThrow();
    expect(() =>
      getStoreReportConfig.output.parse({
        merchantId: 'M',
        storeId: 'S',
        currency: 'CNY',
        locale: 'zh-CN',
        timezone: 'Asia/Shanghai',
        dailyCards: [{ cardCode: 'sales_summary', enabled: true }],
        monthlyCards: [],
      }),
    ).not.toThrow();
  });

  it('cardCode 必须 lower_snake_case', () => {
    expect(() =>
      getStoreReportConfig.output.parse({
        merchantId: 'M',
        storeId: 'S',
        currency: 'CNY',
        locale: 'zh-CN',
        timezone: 'Asia/Shanghai',
        dailyCards: [{ cardCode: 'SalesSummary', enabled: true }],
        monthlyCards: [],
      }),
    ).toThrow();
  });

  it('currency 必须 ISO 4217(三位大写)', () => {
    expect(() =>
      getStoreReportConfig.output.parse({
        merchantId: 'M',
        storeId: 'S',
        currency: 'cny',
        locale: 'zh-CN',
        timezone: 'Asia/Shanghai',
        dailyCards: [],
        monthlyCards: [],
      }),
    ).toThrow();
  });
});

describe('queryStoreSalesSummary', () => {
  const dr = { startDate: '2026-01-01', endDate: '2026-01-07' };
  it('happy', () => {
    expect(() =>
      queryStoreSalesSummary.input.parse({ merchantId: 'M', storeId: 'S', dateRange: dr }),
    ).not.toThrow();
    expect(() =>
      queryStoreSalesSummary.output.parse({
        merchantId: 'M',
        storeId: 'S',
        dateRange: dr,
        totalSalesAmount: 56000,
        totalOrderCount: 350,
        customerCount: 245,
        avgOrderValue: 160,
        dailyTrend: [{ date: '2026-01-01', salesAmount: 8000, orderCount: 50 }],
      }),
    ).not.toThrow();
  });

  it('totalSalesAmount 必须 nonnegative', () => {
    expect(() =>
      queryStoreSalesSummary.output.parse({
        merchantId: 'M',
        storeId: 'S',
        dateRange: dr,
        totalSalesAmount: -1,
        totalOrderCount: 0,
        customerCount: 0,
        avgOrderValue: 0,
        dailyTrend: [],
      }),
    ).toThrow();
  });

  it('startDate 格式 YYYY-MM-DD', () => {
    expect(() =>
      queryStoreSalesSummary.input.parse({
        merchantId: 'M',
        storeId: 'S',
        dateRange: { startDate: '2026/01/01', endDate: '2026-01-07' },
      }),
    ).toThrow();
  });
});

describe('queryCategorySalesRatio', () => {
  const dr = { startDate: '2026-01-01', endDate: '2026-01-07' };
  it('ratio 必须 0..1', () => {
    expect(() =>
      queryCategorySalesRatio.output.parse({
        merchantId: 'M',
        storeId: 'S',
        dateRange: dr,
        totalSalesAmount: 10000,
        categories: [{ categoryCode: 'b', categoryName: 'B', salesAmount: 6000, ratio: 1.5 }],
      }),
    ).toThrow();
  });

  it('happy 含空数组(missing-category-ratio profile 用)', () => {
    expect(() =>
      queryCategorySalesRatio.output.parse({
        merchantId: 'M',
        storeId: 'S',
        dateRange: dr,
        totalSalesAmount: 0,
        categories: [],
      }),
    ).not.toThrow();
  });
});

describe('queryProductSalesRank', () => {
  const dr = { startDate: '2026-01-01', endDate: '2026-01-07' };
  it('input.topN default=10', () => {
    const i = queryProductSalesRank.input.parse({ merchantId: 'M', storeId: 'S', dateRange: dr });
    expect(i.topN).toBe(10);
  });

  it('rank 必须正整数', () => {
    expect(() =>
      queryProductSalesRank.output.parse({
        merchantId: 'M',
        storeId: 'S',
        dateRange: dr,
        topN: 1,
        products: [{ skuId: 'X', skuName: 'x', salesAmount: 0, salesQty: 0, rank: 0 }],
      }),
    ).toThrow();
  });
});

describe('queryInventoryOverview', () => {
  it('input.lowStockThresholdDays default=3', () => {
    const i = queryInventoryOverview.input.parse({ merchantId: 'M', storeId: 'S' });
    expect(i.lowStockThresholdDays).toBe(3);
  });

  it('库存全零(empty-inventory profile 兼容)', () => {
    expect(() =>
      queryInventoryOverview.output.parse({
        merchantId: 'M',
        storeId: 'S',
        totalSkus: 5,
        lowStockSkus: 0,
        outOfStockSkus: 5,
        totalOnHandValue: 0,
        asOf: '2026-01-01T00:00:00+08:00',
      }),
    ).not.toThrow();
  });

  it('totalOnHandValue 必须 nonnegative', () => {
    expect(() =>
      queryInventoryOverview.output.parse({
        merchantId: 'M',
        storeId: 'S',
        totalSkus: 5,
        lowStockSkus: 0,
        outOfStockSkus: 0,
        totalOnHandValue: -100,
        asOf: '2026-01-01T00:00:00+08:00',
      }),
    ).toThrow();
  });
});
