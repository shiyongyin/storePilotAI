import { Intent, type IntentCode } from '@storepilot/shared-contracts';

export const EXPLICIT_V1_COMMAND_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  intent: IntentCode;
}> = [
  { pattern: /生成.*日报|经营日报/, intent: Intent.BUSINESS_DAILY_REPORT },
  { pattern: /生成.*月报|经营月报/, intent: Intent.BUSINESS_MONTHLY_REPORT },
  { pattern: /生成.*补货|补货建议|补货预测/, intent: Intent.REPLENISHMENT_PLAN },
  { pattern: /调整.*补货|把.*加\s*\d+%/, intent: Intent.ADJUST_REPLENISHMENT_DRAFT },
  { pattern: /确认提单|生成采购单/, intent: Intent.CONFIRM_CREATE_PURCHASE_ORDER },
  { pattern: /取消草稿/, intent: Intent.CANCEL_REPLENISHMENT_DRAFT },
];

export function resolveExplicitV1Intent(message: string): IntentCode | null {
  return EXPLICIT_V1_COMMAND_PATTERNS.find((item) => item.pattern.test(message))?.intent ?? null;
}
