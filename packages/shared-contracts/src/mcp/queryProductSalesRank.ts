/**
 * 切片 05 — queryProductSalesRank(SSOT,商品销售排行)
 * 主调用方:切片 12(business-reports)
 */
import { z } from 'zod';

import { DateRange, TenantScope } from './_common.js';

export const ProductRankItem = z.object({
  skuId: z.string().min(1),
  skuName: z.string().min(1),
  salesAmount: z.number().nonnegative(),
  salesQty: z.number().int().nonnegative(),
  rank: z.number().int().positive(),
});

export type ProductRankItem = z.infer<typeof ProductRankItem>;

export const ProductSalesRank = TenantScope.extend({
  dateRange: DateRange,
  topN: z.number().int().positive(),
  products: z.array(ProductRankItem).max(500),
});

export type ProductSalesRank = z.infer<typeof ProductSalesRank>;

export const queryProductSalesRank = {
  input: TenantScope.extend({
    dateRange: DateRange,
    topN: z.number().int().min(1).max(500).default(10),
  }),
  output: ProductSalesRank,
} as const;
