/**
 * 切片 05 — queryStoreSalesSummary(SSOT,门店销售汇总)
 * 主调用方:切片 12(business-reports)
 */
import { z } from 'zod';

import { DateRange, DateStr, TenantScope } from './_common.js';

export const DailySalesPoint = z.object({
  date: DateStr,
  salesAmount: z.number().nonnegative(),
  orderCount: z.number().int().nonnegative(),
});

export type DailySalesPoint = z.infer<typeof DailySalesPoint>;

export const StoreSalesSummary = TenantScope.extend({
  dateRange: DateRange,
  totalSalesAmount: z.number().nonnegative(),
  totalOrderCount: z.number().int().nonnegative(),
  customerCount: z.number().int().nonnegative(),
  avgOrderValue: z.number().nonnegative(),
  dailyTrend: z.array(DailySalesPoint).max(366),
});

export type StoreSalesSummary = z.infer<typeof StoreSalesSummary>;

export const queryStoreSalesSummary = {
  input: TenantScope.extend({
    dateRange: DateRange,
  }),
  output: StoreSalesSummary,
} as const;
