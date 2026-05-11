import { MARKETING_GROWTH_TOOLS } from '@storepilot/shared-contracts';
import { z } from 'zod';

import { MarketingScopeSchema, UsCodeSchema, ScopeClassifierCaseSchema } from '../../../api/marketing-scope-classifier.js';

export { ScopeClassifierCaseSchema };

const Phase2UsCodeSchema = z.enum([
  'US-003',
  'US-004',
  'US-005',
  'US-006',
  'US-007',
  'US-008',
  'US-009',
  'US-010',
]);
export type Phase2UsCode = z.infer<typeof Phase2UsCodeSchema>;

const MarketingReadToolSchema = z.enum(MARKETING_GROWTH_TOOLS);
const BlockedToolSchema = z.literal(`create${'Purchase'}Order`);
const ExpectedToolSchema = z.union([MarketingReadToolSchema, BlockedToolSchema]);

const MarketingCardTypeSchema = z.enum([
  'daily_marketing_opportunity_card',
  'member_wakeup_list_card',
  'product_recommend_card',
  'campaign_draft_card',
  'campaign_result_card',
]);

export const L2ToolCombinationCaseSchema = z.object({
  id: z.string().min(1),
  usCode: Phase2UsCodeSchema,
  coveredUs: z.array(Phase2UsCodeSchema).min(1),
  userMessage: z.string().min(1),
  expectedTools: z.object({
    mustCall: z.array(MarketingReadToolSchema).default([]),
    shouldCall: z.array(MarketingReadToolSchema).default([]),
    mustNotCall: z.array(ExpectedToolSchema).default([]),
  }),
  minSteps: z.number().int().min(0).max(8),
  maxSteps: z.number().int().min(1).max(8),
});

export const L3OutputQualityCaseSchema = z.object({
  id: z.string().min(1),
  usCode: Phase2UsCodeSchema,
  coveredUs: z.array(Phase2UsCodeSchema).min(1),
  userMessage: z.string().min(1),
  requiredCardType: MarketingCardTypeSchema,
  rubric: z.array(z.string().min(1)).min(1),
  forbiddenContent: z.array(z.string().min(1)).default([]),
  l4Redlines: z.array(z.lazy(() => L4RedlineCaseSchema)).default([]),
});

export const L4RedlineCaseSchema = z.object({
  id: z.string().min(1),
  userMessage: z.string().min(1),
  redline: z.enum(['NO_WRITE_ACTION', 'NO_V1_WRITE_TOOL', 'NO_SYSTEM_TERMS', 'NO_FABRICATED_NUMBER', 'PII']),
  expectedScope: MarketingScopeSchema.optional(),
  expectedCandidates: z.array(UsCodeSchema).max(3).optional(),
});
