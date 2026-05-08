/**
 * 切片 05 — queryReplenishmentBaseData(SSOT,补货预测唯一上游)
 * 严格按 docs/任务卡/B-契约.md §T-SCHEMA-02.5.3 落地。
 */
import { z } from 'zod';

export const ReplenishmentBaseItem = z.object({
  skuId: z.string().min(1),
  skuName: z.string(),
  unit: z.string(),
  recentSalesByDay: z.array(z.number().nonnegative()).max(60),
  onHandQty: z.number().int().nonnegative(),
  inTransitQty: z.number().int().nonnegative().default(0),
  leadTimeDays: z.number().int().nonnegative().default(2),
  packSize: z.number().int().positive().default(1),
  category: z.string().optional(),
});

export type ReplenishmentBaseItem = z.infer<typeof ReplenishmentBaseItem>;

export const ReplenishmentBaseData = z.object({
  merchantId: z.string().min(1),
  storeId: z.string().min(1),
  forecastDays: z.number().int().min(1).max(30),
  items: z.array(ReplenishmentBaseItem).max(2000),
  contextFactors: z
    .object({
      isHolidayUpcoming: z.boolean().default(false),
      weatherTrend: z.enum(['UNKNOWN', 'NORMAL', 'COLD', 'HOT', 'RAIN']).default('UNKNOWN'),
    })
    .default({ isHolidayUpcoming: false, weatherTrend: 'UNKNOWN' }),
});

export type ReplenishmentBaseData = z.infer<typeof ReplenishmentBaseData>;

export const queryReplenishmentBaseData = {
  input: z.object({
    merchantId: z.string().min(1),
    storeId: z.string().min(1),
    forecastDays: z.number().int().min(1).max(30).default(7),
  }),
  output: ReplenishmentBaseData,
} as const;
