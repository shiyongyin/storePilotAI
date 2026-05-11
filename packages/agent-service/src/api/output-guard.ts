const CARD_DATA_START = '<!-- card_data:start -->';
const FORGED_BRIDGE_TAG = /<\s*(ASK|FALLBACK)\s*>/i;

export type MarketingOutputGuardResult =
  | { ok: true }
  | { ok: false; fallbackReason: 'AGENT_OUTPUT_INVALID' | 'AGENT_OUTPUT_FORGED_TAG' };

export function validateMarketingAgentOutput(
  output: { text?: string },
  toolCallCount = 0,
): MarketingOutputGuardResult {
  const text = output.text ?? '';
  if (FORGED_BRIDGE_TAG.test(text)) {
    return { ok: false, fallbackReason: 'AGENT_OUTPUT_FORGED_TAG' };
  }
  if (!text.includes(CARD_DATA_START) && toolCallCount === 0) {
    return { ok: false, fallbackReason: 'AGENT_OUTPUT_INVALID' };
  }
  return { ok: true };
}
