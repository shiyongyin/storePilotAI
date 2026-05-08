/**
 * 切片 05 — happy-path fixture(完整 6 个 QUERY 工具)
 * 5 SKU × 1 门店主路径,代表"业务正常"基线。
 * createPurchaseOrder 不通过 fixture(由 mcp-server 直接调 idempotencyStore)。
 */
import type { ProfileFixtures } from '../../support/fixture-loader.js';

const SKUS = [
  { skuId: 'SKU001', skuName: '可乐 330ml', unit: '瓶', category: '饮料' },
  { skuId: 'SKU002', skuName: '雪碧 330ml', unit: '瓶', category: '饮料' },
  { skuId: 'SKU003', skuName: '矿泉水 500ml', unit: '瓶', category: '饮料' },
  { skuId: 'SKU004', skuName: '薯片', unit: '袋', category: '零食' },
  { skuId: 'SKU005', skuName: '巧克力', unit: '盒', category: '零食' },
];

function nowIso(): string {
  return new Date().toISOString();
}

export const happyPathFixtures: ProfileFixtures = {
  getStoreReportConfig: (input: unknown) => {
    const { merchantId, storeId } = input as { merchantId: string; storeId: string };
    return {
      merchantId,
      storeId,
      currency: 'CNY',
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
      dailyCards: [
        { cardCode: 'sales_summary', enabled: true },
        { cardCode: 'category_ratio', enabled: true },
        { cardCode: 'product_rank', enabled: true, threshold: 10 },
        { cardCode: 'inventory_overview', enabled: true, threshold: 3 },
      ],
      monthlyCards: [
        { cardCode: 'sales_summary', enabled: true },
        { cardCode: 'category_ratio', enabled: true },
        { cardCode: 'product_rank', enabled: true, threshold: 20 },
      ],
    };
  },

  queryStoreSalesSummary: (input: unknown) => {
    const { merchantId, storeId, dateRange } = input as {
      merchantId: string;
      storeId: string;
      dateRange: { startDate: string; endDate: string };
    };
    const days = 7;
    const dailyTrend = Array.from({ length: days }, (_, i) => ({
      date: dateRange.startDate.replace(/-\d{2}$/, `-${String(i + 1).padStart(2, '0')}`),
      salesAmount: 8000 + i * 500,
      orderCount: 45 + i * 3,
    }));
    const totalSalesAmount = dailyTrend.reduce((s, d) => s + d.salesAmount, 0);
    const totalOrderCount = dailyTrend.reduce((s, d) => s + d.orderCount, 0);
    return {
      merchantId,
      storeId,
      dateRange,
      totalSalesAmount,
      totalOrderCount,
      customerCount: Math.round(totalOrderCount * 0.7),
      avgOrderValue: Math.round((totalSalesAmount / totalOrderCount) * 100) / 100,
      dailyTrend,
    };
  },

  queryCategorySalesRatio: (input: unknown) => {
    const { merchantId, storeId, dateRange } = input as {
      merchantId: string;
      storeId: string;
      dateRange: { startDate: string; endDate: string };
    };
    return {
      merchantId,
      storeId,
      dateRange,
      totalSalesAmount: 60000,
      categories: [
        { categoryCode: 'beverage', categoryName: '饮料', salesAmount: 36000, ratio: 0.6 },
        { categoryCode: 'snack', categoryName: '零食', salesAmount: 18000, ratio: 0.3 },
        { categoryCode: 'other', categoryName: '其它', salesAmount: 6000, ratio: 0.1 },
      ],
    };
  },

  queryProductSalesRank: (input: unknown) => {
    const { merchantId, storeId, dateRange, topN } = input as {
      merchantId: string;
      storeId: string;
      dateRange: { startDate: string; endDate: string };
      topN: number;
    };
    const products = SKUS.slice(0, Math.min(topN, SKUS.length)).map((s, i) => ({
      skuId: s.skuId,
      skuName: s.skuName,
      salesAmount: 12000 - i * 1500,
      salesQty: 200 - i * 25,
      rank: i + 1,
    }));
    return { merchantId, storeId, dateRange, topN, products };
  },

  queryInventoryOverview: (input: unknown) => {
    const { merchantId, storeId } = input as { merchantId: string; storeId: string };
    return {
      merchantId,
      storeId,
      totalSkus: SKUS.length,
      lowStockSkus: 1,
      outOfStockSkus: 0,
      totalOnHandValue: 12500.5,
      asOf: nowIso(),
    };
  },

  queryReplenishmentBaseData: (input: unknown) => {
    const { merchantId, storeId, forecastDays } = input as {
      merchantId: string;
      storeId: string;
      forecastDays: number;
    };
    const items = SKUS.map((s, i) => ({
      skuId: s.skuId,
      skuName: s.skuName,
      unit: s.unit,
      category: s.category,
      recentSalesByDay: Array.from({ length: 14 }, () => 10 + Math.floor(Math.random() * 10)),
      onHandQty: 50 - i * 5,
      inTransitQty: i % 2 === 0 ? 20 : 0,
      leadTimeDays: 2,
      packSize: 12,
    }));
    return {
      merchantId,
      storeId,
      forecastDays,
      items,
      contextFactors: { isHolidayUpcoming: false, weatherTrend: 'NORMAL' as const },
    };
  },
};
