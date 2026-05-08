/**
 * 切片 18 §8.6 — strategy-engine 防御分支补充覆盖率
 *
 * 目标：覆盖 deepMerge / mergeStrategy 的几条防御分支：
 *   - deepMerge: 跳过非对象（null / 字符串 / 数字）source（line 96 分支）
 *   - mergeStrategy: 默认 cache 分支（args.cache 未传 → defaultCache）
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  deepMerge,
  mergeStrategy,
  resetStrategyEngineForTest,
  setStrategyLoader,
  type StrategyLoader,
} from './strategy-engine.js';

describe('deepMerge — 防御分支：非对象 source 跳过', () => {
  it('mix null / string / number / 正常对象 → 仅合并对象 source', () => {
    const a = { x: 1, n: { p: 1 } };
    const b = { x: 2, n: { q: 2 } };
    // null / 字符串 / 数字 → continue（line 96 分支）
    /* eslint-disable @typescript-eslint/no-unsafe-argument */
    const merged = deepMerge<Record<string, unknown>>(
      a,
      null as unknown as Record<string, unknown>,
      'not-object' as unknown as Record<string, unknown>,
      42 as unknown as Record<string, unknown>,
      b,
    );
    /* eslint-enable @typescript-eslint/no-unsafe-argument */
    expect(merged).toEqual({ x: 2, n: { p: 1, q: 2 } });
  });

  it('单一空对象 → 返回空对象（result 初始化分支）', () => {
    expect(deepMerge<Record<string, unknown>>({})).toEqual({});
  });
});

describe('mergeStrategy — 默认 cache 分支', () => {
  const platformStrategy = {
    enabledSkills: [
      'business_daily_report',
      'business_monthly_report',
      'replenishment_forecast',
      'replenishment_adjustment',
      'purchase_order_create',
    ],
    replenishmentPolicy: {
      forecastDays: 7,
      safetyStockDays: 2,
      requireConfirmBeforePurchaseOrder: true,
      allowAutoPurchaseOrder: false,
      forecastMethod: 'weighted_moving_average' as const,
    },
    reportPolicy: { maxSummaryChars: 8000, maxCards: 12 },
    safetyPolicy: {
      requireUserConfirmForWrite: true,
      maxAdjustmentsPerDraft: 10,
      majorAdjustmentRatio: 0.5,
      draftAutoExpireMinutes: 30,
    },
  };

  const loader: StrategyLoader = {
    loadPlatformDefault: () =>
      Promise.resolve({ strategyJson: structuredClone(platformStrategy), version: 'p1' }),
    loadMerchantStrategy: () => Promise.resolve(null),
    loadStoreStrategy: () => Promise.resolve(null),
  };

  afterEach(() => {
    resetStrategyEngineForTest();
  });

  it('未传 cache 参数 → 走 defaultCache 默认分支（lines 137 default）', async () => {
    setStrategyLoader(loader);
    const out = await mergeStrategy({ merchantId: 'M001', storeId: 'S001' });
    expect(out.degraded).toBe(false);
    const merged = out.merged as { replenishmentPolicy: { forecastDays: number } };
    expect(merged.replenishmentPolicy.forecastDays).toBe(7);
  });
});
