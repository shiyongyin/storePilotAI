/**
 * 切片 05 — missing-category-ratio profile
 * 仅覆写 queryCategorySalesRatio 返回空数组(类目接口缺数据)。
 * 其它工具 fall back 到 happy-path。
 */
import type { ProfileFixtures } from '../../support/fixture-loader.js';

export const missingCategoryRatioFixtures: ProfileFixtures = {
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
      totalSalesAmount: 0,
      categories: [],
    };
  },
};
