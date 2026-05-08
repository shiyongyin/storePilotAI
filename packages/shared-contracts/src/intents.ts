/**
 * 切片 04 — Intent 11 枚举(SSOT)
 * 严格按 docs/任务卡/B-契约.md §T-SCHEMA-01.5.1 + 本体 §3.6.2 落地。
 * 任意下游切片新增/改名 IntentCode 必须先回填本文件。
 */
import { z } from 'zod';

export const Intent = {
  BUSINESS_DAILY_REPORT: 'BUSINESS_DAILY_REPORT',
  BUSINESS_MONTHLY_REPORT: 'BUSINESS_MONTHLY_REPORT',
  REPLENISHMENT_PLAN: 'REPLENISHMENT_PLAN',
  ADJUST_REPLENISHMENT_DRAFT: 'ADJUST_REPLENISHMENT_DRAFT',
  CONFIRM_CREATE_PURCHASE_ORDER: 'CONFIRM_CREATE_PURCHASE_ORDER',
  CANCEL_REPLENISHMENT_DRAFT: 'CANCEL_REPLENISHMENT_DRAFT',
  COLLECT_REQUIREMENT: 'COLLECT_REQUIREMENT',
  GENERAL_QA: 'GENERAL_QA',
  EXPLAIN_METRIC: 'EXPLAIN_METRIC',
  MULTI_INTENT: 'MULTI_INTENT',
  UNKNOWN: 'UNKNOWN',
} as const;

export type IntentCode = (typeof Intent)[keyof typeof Intent];

export const IntentEnum = z.enum(Object.values(Intent) as [IntentCode, ...IntentCode[]]);

export const IntentRouterOutput = z.object({
  intent: IntentEnum,
  confidence: z.number().min(0).max(1),
  reason: z.string().max(200),
});

export type IntentRouterOutput = z.infer<typeof IntentRouterOutput>;
