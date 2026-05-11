import { MarketingToolContracts, type MarketingToolName } from '@storepilot/shared-contracts/mcp';

import { marketingShoeStoreFixtures } from '../fixtures/marketing-shoe-store/index.js';

type HandlerContext = {
  tenant: {
    merchantId: string;
    storeId: string;
  };
};

export function createMarketingHandler(toolName: MarketingToolName) {
  return (input: unknown, context: HandlerContext): unknown => {
    const contract = MarketingToolContracts[toolName];
    const parsedInput = contract.input.parse({
      ...(input as Record<string, unknown>),
      merchantId: context.tenant.merchantId,
      storeId: context.tenant.storeId,
    });
    const fixture = marketingShoeStoreFixtures[toolName];
    if (!fixture) throw new Error(`[mcp-mock] fixture not found: tool=${toolName}`);
    const output = fixture(parsedInput);
    return contract.output.parse(output);
  };
}
