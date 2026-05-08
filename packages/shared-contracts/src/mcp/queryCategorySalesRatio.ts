/**
 * 切片 05 — queryCategorySalesRatio(SSOT,品类销售占比)
 * 主调用方:切片 12(business-reports)
 */
import { z } from 'zod';

import { DateRange, TenantScope } from './_common.js';

export const CategorySalesRatioItem = z.object({
  categoryCode: z.string().min(1),
  categoryName: z.string().min(1),
  salesAmount: z.number().nonnegative(),
  /** 占比 0..1 */
  ratio: z.number().min(0).max(1),
});

export type CategorySalesRatioItem = z.infer<typeof CategorySalesRatioItem>;

export const CategorySalesRatio = TenantScope.extend({
  dateRange: DateRange,
  totalSalesAmount: z.number().nonnegative(),
  categories: z.array(CategorySalesRatioItem).max(200),
});

export type CategorySalesRatio = z.infer<typeof CategorySalesRatio>;

export const queryCategorySalesRatio = {
  input: TenantScope.extend({
    dateRange: DateRange,
  }),
  output: CategorySalesRatio,
} as const;
