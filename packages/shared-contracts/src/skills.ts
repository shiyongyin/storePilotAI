/**
 * 切片 04 — AgentSkillDef + RiskLevel + 5 个 Skill IO 占位(SSOT)
 * 严格按 docs/任务卡/B-契约.md §T-SCHEMA-01.5.5 落地。
 *
 * 5 个 Skill IO 仅占位(z.object({}).strict()):
 *   - 切片 12(business-reports)落 BUSINESS_DAILY/MONTHLY_REPORT IO
 *   - 切片 14(replenishment-forecast)落 REPLENISHMENT_PLAN IO
 *   - 切片 15(replenishment-adjustment)落 ADJUST_REPLENISHMENT_DRAFT IO
 *   - 切片 17(purchase-order-create-hitl)落 CONFIRM_CREATE_PURCHASE_ORDER IO
 *
 * 占位用 z.object({}).strict() 而非 z.any()/z.unknown()(任务卡 §7 MUST NOT §3)。
 * 各下游切片完整化时通过 .extend(...) 在不破坏向前兼容的前提下补字段。
 */
import { z } from 'zod';

import { IntentEnum } from './intents.js';

export const RiskLevel = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const AgentSkillDef = z.object({
  skillCode: z.string().regex(/^[a-z][a-z0-9_]*$/, 'skillCode 必须 lower_snake_case'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version 必须 SemVer'),
  allowedIntents: z.array(IntentEnum).min(1),
  requiredTools: z.array(z.string()).default([]),
  riskLevel: RiskLevel,
  status: z.enum(['enabled', 'disabled', 'gray']),
});

export type AgentSkillDef = z.infer<typeof AgentSkillDef>;

// === 5 个 Skill IO 占位 ===
// 切片 12 完整化(business-daily-report / business-monthly-report)
export const BusinessDailyReportInput = z.object({}).strict();
export const BusinessDailyReportOutput = z.object({}).strict();
export const BusinessMonthlyReportInput = z.object({}).strict();
export const BusinessMonthlyReportOutput = z.object({}).strict();

// 切片 14 完整化(replenishment-forecast)
export const ReplenishmentForecastInput = z.object({}).strict();
export const ReplenishmentForecastOutput = z.object({}).strict();

// 切片 15 完整化(replenishment-adjustment)
export const ReplenishmentAdjustmentInput = z.object({}).strict();
export const ReplenishmentAdjustmentOutput = z.object({}).strict();

// 切片 17 完整化(purchase-order-create)
export const PurchaseOrderCreateInput = z.object({}).strict();
export const PurchaseOrderCreateOutput = z.object({}).strict();

export type BusinessDailyReportInput = z.infer<typeof BusinessDailyReportInput>;
export type BusinessDailyReportOutput = z.infer<typeof BusinessDailyReportOutput>;
export type BusinessMonthlyReportInput = z.infer<typeof BusinessMonthlyReportInput>;
export type BusinessMonthlyReportOutput = z.infer<typeof BusinessMonthlyReportOutput>;
export type ReplenishmentForecastInput = z.infer<typeof ReplenishmentForecastInput>;
export type ReplenishmentForecastOutput = z.infer<typeof ReplenishmentForecastOutput>;
export type ReplenishmentAdjustmentInput = z.infer<typeof ReplenishmentAdjustmentInput>;
export type ReplenishmentAdjustmentOutput = z.infer<typeof ReplenishmentAdjustmentOutput>;
export type PurchaseOrderCreateInput = z.infer<typeof PurchaseOrderCreateInput>;
export type PurchaseOrderCreateOutput = z.infer<typeof PurchaseOrderCreateOutput>;
