import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

const MarketingGrowthInputSchema = z.object({
  merchantId: z.string(),
  storeId: z.string(),
  userMessage: z.string().min(1),
});

const MarketingGrowthOutputSchema = z.object({
  routedTo: z.literal('marketingGrowthCopilot'),
});

const marketingGrowthCopilotEntryStep = createStep({
  id: 'marketing-growth-copilot-entry',
  inputSchema: MarketingGrowthInputSchema,
  outputSchema: MarketingGrowthOutputSchema,
  execute: () => Promise.resolve({ routedTo: 'marketingGrowthCopilot' as const }),
});

export const marketingGrowthCopilotWorkflow = createWorkflow({
  id: 'marketing_growth_copilot',
  inputSchema: MarketingGrowthInputSchema,
  outputSchema: MarketingGrowthOutputSchema,
})
  .then(marketingGrowthCopilotEntryStep)
  .commit();
