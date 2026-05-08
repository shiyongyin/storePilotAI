/**
 * 切片 04 — StrategySchema + 三层(Platform/Merchant/Store/EffectiveStrategy)(SSOT)
 * 严格按 docs/任务卡/B-契约.md §T-SCHEMA-01.5.4 落地。
 *
 * V1 红线(违反即拒收):
 * - replenishmentPolicy.allowAutoPurchaseOrder: z.literal(false) — V1 永不放开
 * - safetyPolicy.requireUserConfirmForWrite:    z.literal(true)  — 永不允许关闭
 *
 * 三层合并(优先级 Store > Merchant > Platform)由切片 11(safety-strategy-validator)实现,
 * 本切片仅定义形状。
 */
import { z } from 'zod';

export const StrategySchema = z.object({
  enabledSkills: z.array(z.string()).default([]),
  replenishmentPolicy: z.object({
    forecastDays: z.number().int().positive().default(7),
    safetyStockDays: z.number().nonnegative().default(2),
    requireConfirmBeforePurchaseOrder: z.boolean().default(true),
    allowAutoPurchaseOrder: z.literal(false),
    forecastMethod: z.enum(['weighted_moving_average']).default('weighted_moving_average'),
  }),
  reportPolicy: z.object({
    maxSummaryChars: z.number().int().positive().default(8000),
    maxCards: z.number().int().positive().default(12),
  }),
  safetyPolicy: z.object({
    requireUserConfirmForWrite: z.literal(true),
    maxAdjustmentsPerDraft: z.number().int().positive().default(10),
    majorAdjustmentRatio: z.number().nonnegative().default(0.5),
    draftAutoExpireMinutes: z.number().int().positive().default(30),
  }),
});

export type Strategy = z.infer<typeof StrategySchema>;

/**
 * 三层策略(Platform/Merchant/Store)与 Effective(合并后),形状均同 StrategySchema。
 * 切片 11 实现合并逻辑;本切片仅暴露类型别名,避免下游 workspace 重复定义。
 */
export const PlatformStrategy = StrategySchema;
export const MerchantStrategy = StrategySchema;
export const StoreStrategy = StrategySchema;
export const EffectiveStrategy = StrategySchema;

export type PlatformStrategy = Strategy;
export type MerchantStrategy = Strategy;
export type StoreStrategy = Strategy;
export type EffectiveStrategy = Strategy;
