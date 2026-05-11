import { Intent } from '@storepilot/shared-contracts';
import { describe, expect, it } from 'vitest';

import { EXPLICIT_V1_COMMAND_PATTERNS, resolveExplicitV1Intent } from './v1-explicit-command-router.js';

describe('v1-explicit-command-router', () => {
  it('routes only the 6 explicit V1 workflow command families', () => {
    expect(EXPLICIT_V1_COMMAND_PATTERNS).toHaveLength(6);
    expect(resolveExplicitV1Intent('生成今天经营日报')).toBe(Intent.BUSINESS_DAILY_REPORT);
    expect(resolveExplicitV1Intent('生成本月经营月报')).toBe(Intent.BUSINESS_MONTHLY_REPORT);
    expect(resolveExplicitV1Intent('补货预测明天的')).toBe(Intent.REPLENISHMENT_PLAN);
    expect(resolveExplicitV1Intent('把矿泉水加 20%')).toBe(Intent.ADJUST_REPLENISHMENT_DRAFT);
    expect(resolveExplicitV1Intent('确认提单')).toBe(Intent.CONFIRM_CREATE_PURCHASE_ORDER);
    expect(resolveExplicitV1Intent('取消草稿')).toBe(Intent.CANCEL_REPLENISHMENT_DRAFT);
  });

  it('does not steal V2 free-form marketing messages', () => {
    expect(resolveExplicitV1Intent('沉睡会员')).toBeNull();
    expect(resolveExplicitV1Intent('谁该来补货了')).toBeNull();
    expect(resolveExplicitV1Intent('什么货要清')).toBeNull();
  });

  it('补货预测 routes to the explicit V1 replenishment workflow before V2 scope classification', () => {
    expect(resolveExplicitV1Intent('补货预测明天的')).toBe(Intent.REPLENISHMENT_PLAN);
  });
});
