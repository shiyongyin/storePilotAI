/**
 * 切片 05 — queryInventoryOverview(SSOT,库存概览)
 * 主调用方:切片 12(business-reports)+ 切片 14(replenishment-forecast)
 */
import { z } from 'zod';

import { TenantScope } from './_common.js';

export const InventoryOverview = TenantScope.extend({
  totalSkus: z.number().int().nonnegative(),
  /** 低库存 SKU 数(< lowStockThresholdDays * 日均销量) */
  lowStockSkus: z.number().int().nonnegative(),
  /** 缺货 SKU 数(onHandQty=0) */
  outOfStockSkus: z.number().int().nonnegative(),
  /** 在库总价值(以 storeReportConfig.currency 计) */
  totalOnHandValue: z.number().nonnegative(),
  /** 截止日期(查询时刻 ISO datetime + offset)*/
  asOf: z.string().datetime({ offset: true }),
});

export type InventoryOverview = z.infer<typeof InventoryOverview>;

export const queryInventoryOverview = {
  input: TenantScope.extend({
    /** 计算 lowStockSkus 时的安全天数阈值 */
    lowStockThresholdDays: z.number().int().min(1).max(30).default(3),
  }),
  output: InventoryOverview,
} as const;
