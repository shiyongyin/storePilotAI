/**
 * 切片 04 — DraftStatus 7 状态 + DraftItem + ReplenishmentDraft + AdjustmentInstruction(SSOT)
 * 严格按 docs/任务卡/B-契约.md §T-SCHEMA-01.5.2-5.3 落地。
 * DraftStatus 必须与切片 03(replenishment_draft.status 表注释)一致。
 */
import { z } from 'zod';

export const DraftStatus = z.enum([
  'DRAFT',
  'WAIT_CONFIRM',
  'CONFIRMED',
  'SUBMITTED',
  'EXPIRED',
  'CANCELLED',
  'FAILED',
]);

export type DraftStatus = z.infer<typeof DraftStatus>;

export const DraftItem = z.object({
  skuId: z.string(),
  skuName: z.string(),
  unit: z.string(),
  baseSuggestQty: z.number().int().nonnegative(),
  finalSuggestQty: z.number().int().nonnegative(),
  reason: z.string().max(200),
  adjustmentTrace: z.array(z.string()).default([]),
});

export type DraftItem = z.infer<typeof DraftItem>;

export const ReplenishmentDraft = z.object({
  draftId: z.string().regex(/^drf_[a-z0-9]{16,32}$/),
  sessionId: z.string(),
  merchantId: z.string(),
  storeId: z.string(),
  userId: z.string(),
  traceId: z.string(),
  forecastDays: z.number().int().min(1).max(30),
  status: DraftStatus,
  items: z.array(DraftItem).max(2000),
  strategyVersion: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  submittedPoNo: z.string().nullable().default(null),
});

export type ReplenishmentDraft = z.infer<typeof ReplenishmentDraft>;

export const AdjustmentTargetType = z.enum(['SKU_ID', 'SKU_KEYWORD', 'CATEGORY_CODE', 'ALL']);
export type AdjustmentTargetType = z.infer<typeof AdjustmentTargetType>;

export const AdjustmentOpType = z.enum([
  'INCREASE_RATE',
  'DECREASE_RATE',
  'INCREASE_QTY',
  'DECREASE_QTY',
  'SET_QTY',
  'EXCLUDE',
]);
export type AdjustmentOpType = z.infer<typeof AdjustmentOpType>;

export const AdjustmentInstruction = z.object({
  adjustmentId: z.string(),
  draftId: z.string(),
  userMessage: z.string().max(500),
  targetType: AdjustmentTargetType,
  targetValue: z.string(),
  adjustmentType: AdjustmentOpType,
  adjustmentRate: z.number().min(-1).max(5).optional(),
  adjustmentQty: z.number().int().optional(),
  reason: z.string(),
  createdAt: z.string().datetime({ offset: true }),
});

export type AdjustmentInstruction = z.infer<typeof AdjustmentInstruction>;
