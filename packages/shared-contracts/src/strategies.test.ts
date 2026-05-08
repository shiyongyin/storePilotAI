/**
 * 切片 04 — StrategySchema 单测
 * 关键断言:V1 红线 — allowAutoPurchaseOrder=false / requireUserConfirmForWrite=true
 */
import { describe, expect, it } from 'vitest';

import { StrategySchema } from './strategies.js';

describe('StrategySchema V1 红线', () => {
  const happy = {
    enabledSkills: ['business_daily_report'],
    replenishmentPolicy: {
      forecastDays: 7,
      safetyStockDays: 2,
      requireConfirmBeforePurchaseOrder: true,
      allowAutoPurchaseOrder: false,
      forecastMethod: 'weighted_moving_average',
    },
    reportPolicy: {
      maxSummaryChars: 8000,
      maxCards: 12,
    },
    safetyPolicy: {
      requireUserConfirmForWrite: true,
      maxAdjustmentsPerDraft: 10,
      majorAdjustmentRatio: 0.5,
      draftAutoExpireMinutes: 30,
    },
  };

  it('happy', () => {
    const s = StrategySchema.parse(happy);
    expect(s.replenishmentPolicy.allowAutoPurchaseOrder).toBe(false);
    expect(s.safetyPolicy.requireUserConfirmForWrite).toBe(true);
  });

  it('allowAutoPurchaseOrder 必须 literal(false)', () => {
    expect(() =>
      StrategySchema.parse({
        ...happy,
        replenishmentPolicy: { ...happy.replenishmentPolicy, allowAutoPurchaseOrder: true },
      }),
    ).toThrow();
  });

  it('requireUserConfirmForWrite 必须 literal(true)', () => {
    expect(() =>
      StrategySchema.parse({
        ...happy,
        safetyPolicy: { ...happy.safetyPolicy, requireUserConfirmForWrite: false },
      }),
    ).toThrow();
  });

  it('全部 default 应用(空 source 仅 literal 字段必填)', () => {
    const s = StrategySchema.parse({
      replenishmentPolicy: {
        allowAutoPurchaseOrder: false,
      },
      reportPolicy: {},
      safetyPolicy: {
        requireUserConfirmForWrite: true,
      },
    });
    expect(s.replenishmentPolicy.forecastDays).toBe(7);
    expect(s.replenishmentPolicy.safetyStockDays).toBe(2);
    expect(s.reportPolicy.maxSummaryChars).toBe(8000);
    expect(s.safetyPolicy.draftAutoExpireMinutes).toBe(30);
  });

  it('forecastMethod 仅允许 weighted_moving_average', () => {
    expect(() =>
      StrategySchema.parse({
        ...happy,
        replenishmentPolicy: { ...happy.replenishmentPolicy, forecastMethod: 'arima' },
      }),
    ).toThrow();
  });
});
