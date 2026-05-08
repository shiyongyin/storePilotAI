/**
 * 切片 11 §9 第 1/2/4/5 步 — Strategy Engine 三层合并 / LRU 命中 / 降级 / version 单测
 *
 * 覆盖:
 *   - 三层合并优先级:STORE 覆盖 MERCHANT 覆盖 PLATFORM
 *   - LRU 命中:第二次相同 (M, S) 不查 DB(loader 调用次数 = 1)
 *   - 降级:strategy_json 损坏 → 返回 platform default + degraded=true
 *   - version 格式:M{m}-S{s}-P{p}
 *   - deepMerge 行为(对象递归 / 数组替换 / undefined 跳过 / null 覆盖)
 *
 * 注:本切片为业务安全层 helper,不依赖真实 mysql2 pool;
 * 所有 DB 行为由 mock loader 注入(切片 20 完整化 DB pool 后会有集成测试覆盖端到端)。
 */
import { LRUCache } from 'lru-cache';
import { BizError } from '@storepilot/shared-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type CachedStrategyEntry,
  STRATEGY_CACHE_MAX,
  STRATEGY_CACHE_TTL_MS,
  applyInvalidation,
} from './strategy-cache.js';
import {
  deepMerge,
  mergeStrategy,
  resetStrategyEngineForTest,
  type StrategyLoader,
} from './strategy-engine.js';

const PLATFORM_DEFAULT_JSON = {
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

function buildLoader(over: {
  platformVersion?: string;
  merchant?: { strategyJson: Record<string, unknown>; version: string } | null;
  store?: { strategyJson: Record<string, unknown>; version: string } | null;
} = {}): StrategyLoader & { _calls: { platform: number; merchant: number; store: number } } {
  const _calls = { platform: 0, merchant: 0, store: 0 };
  return {
    _calls,
    loadPlatformDefault: () => {
      _calls.platform += 1;
      return Promise.resolve({
        strategyJson: structuredClone(PLATFORM_DEFAULT_JSON),
        version: over.platformVersion ?? 'platform-default-v1.0.0',
      });
    },
    loadMerchantStrategy: () => {
      _calls.merchant += 1;
      return Promise.resolve(over.merchant ?? null);
    },
    loadStoreStrategy: () => {
      _calls.store += 1;
      return Promise.resolve(over.store ?? null);
    },
  };
}

describe('safety/strategy-engine — deepMerge', () => {
  it('对象层递归 + 右覆盖左', () => {
    const a = { a: 1, b: { c: 2, d: 3 } };
    const b = { b: { c: 99 } };
    expect(deepMerge<Record<string, unknown>>(a, b)).toEqual({ a: 1, b: { c: 99, d: 3 } });
  });

  it('数组按整体替换(不合并)', () => {
    const a = { arr: [1, 2, 3] };
    const b = { arr: [9] };
    expect(deepMerge<Record<string, unknown>>(a, b)).toEqual({ arr: [9] });
  });

  it('undefined 跳过(等同未声明)', () => {
    const a = { x: 1 };
    const b = { x: undefined as unknown };
    expect(deepMerge<Record<string, unknown>>(a, b)).toEqual({ x: 1 });
  });

  it('null 覆盖(等同显式置空)', () => {
    const a = { x: 1 };
    const b = { x: null };
    expect(deepMerge<Record<string, unknown>>(a, b)).toEqual({ x: null });
  });

  it('三层合并:store > merchant > platform', () => {
    const platform = { policy: { a: 1, b: 2, c: 3 } };
    const merchant = { policy: { b: 20 } };
    const store = { policy: { c: 300 } };
    expect(deepMerge<Record<string, unknown>>(platform, merchant, store)).toEqual({
      policy: { a: 1, b: 20, c: 300 },
    });
  });
});

describe('safety/strategy-engine — mergeStrategy 三层合并优先级', () => {
  let testCache: LRUCache<string, CachedStrategyEntry>;
  beforeEach(() => {
    testCache = new LRUCache<string, CachedStrategyEntry>({
      max: STRATEGY_CACHE_MAX,
      ttl: STRATEGY_CACHE_TTL_MS,
    });
    resetStrategyEngineForTest(testCache);
  });
  afterEach(() => testCache.clear());

  it('STORE 覆盖 MERCHANT 覆盖 PLATFORM(safetyStockDays platform=2 / store=5)', async () => {
    const loader = buildLoader({
      store: {
        strategyJson: { replenishmentPolicy: { safetyStockDays: 5 } },
        version: 'store-v1',
      },
    });
    const { merged } = await mergeStrategy({
      merchantId: 'M001',
      storeId: 'S001',
      loader,
      cache: testCache,
    });
    expect((merged as { replenishmentPolicy: { safetyStockDays: number } })
      .replenishmentPolicy.safetyStockDays).toBe(5);
  });

  it('MERCHANT 覆盖 PLATFORM(无 STORE 行)', async () => {
    const loader = buildLoader({
      merchant: {
        strategyJson: { replenishmentPolicy: { forecastDays: 14 } },
        version: 'merchant-v1',
      },
    });
    const { merged } = await mergeStrategy({
      merchantId: 'M001',
      storeId: 'S001',
      loader,
      cache: testCache,
    });
    expect((merged as { replenishmentPolicy: { forecastDays: number } })
      .replenishmentPolicy.forecastDays).toBe(14);
  });

  it('STORE 覆盖 MERCHANT(同字段)', async () => {
    const loader = buildLoader({
      merchant: {
        strategyJson: { replenishmentPolicy: { forecastDays: 14 } },
        version: 'merchant-v1',
      },
      store: {
        strategyJson: { replenishmentPolicy: { forecastDays: 21 } },
        version: 'store-v1',
      },
    });
    const { merged } = await mergeStrategy({
      merchantId: 'M001',
      storeId: 'S001',
      loader,
      cache: testCache,
    });
    expect((merged as { replenishmentPolicy: { forecastDays: number } })
      .replenishmentPolicy.forecastDays).toBe(21);
  });

  it('无 MERCHANT / STORE → 用 PLATFORM 默认', async () => {
    const loader = buildLoader();
    const { merged } = await mergeStrategy({
      merchantId: 'M001',
      storeId: 'S001',
      loader,
      cache: testCache,
    });
    expect((merged as { replenishmentPolicy: { forecastDays: number } })
      .replenishmentPolicy.forecastDays).toBe(7);
  });
});

describe('safety/strategy-engine — version 格式', () => {
  let testCache: LRUCache<string, CachedStrategyEntry>;
  beforeEach(() => {
    testCache = new LRUCache<string, CachedStrategyEntry>({
      max: STRATEGY_CACHE_MAX,
      ttl: STRATEGY_CACHE_TTL_MS,
    });
    resetStrategyEngineForTest(testCache);
  });

  it('M0-S0-P{platform.version} 当无 merchant / store', async () => {
    const loader = buildLoader({ platformVersion: 'platform-default-v1.0.0' });
    const { version } = await mergeStrategy({
      merchantId: 'M001',
      storeId: 'S001',
      loader,
      cache: testCache,
    });
    expect(version).toBe('M0-S0-Pplatform-default-v1.0.0');
  });

  it('M{m.version}-S{s.version}-P{p.version} 当 3 层都有', async () => {
    const loader = buildLoader({
      platformVersion: 'p-1',
      merchant: { strategyJson: {}, version: 'm-2' },
      store: { strategyJson: {}, version: 's-3' },
    });
    const { version } = await mergeStrategy({
      merchantId: 'M001',
      storeId: 'S001',
      loader,
      cache: testCache,
    });
    expect(version).toBe('Mm-2-Ss-3-Pp-1');
  });
});

describe('safety/strategy-engine — LRU 命中', () => {
  let testCache: LRUCache<string, CachedStrategyEntry>;
  beforeEach(() => {
    testCache = new LRUCache<string, CachedStrategyEntry>({
      max: STRATEGY_CACHE_MAX,
      ttl: STRATEGY_CACHE_TTL_MS,
    });
    resetStrategyEngineForTest(testCache);
  });

  it('100 次读同 (M, S) → loader 仅调 1 次', async () => {
    const loader = buildLoader();
    for (let i = 0; i < 100; i += 1) {
      await mergeStrategy({
        merchantId: 'M001',
        storeId: 'S001',
        loader,
        cache: testCache,
      });
    }
    expect(loader._calls.platform).toBe(1);
    expect(loader._calls.merchant).toBe(1);
    expect(loader._calls.store).toBe(1);
  });

  it('不同 (M, S) 各自缓存,不互相干扰', async () => {
    const loader = buildLoader();
    await mergeStrategy({ merchantId: 'M001', storeId: 'S001', loader, cache: testCache });
    await mergeStrategy({ merchantId: 'M001', storeId: 'S002', loader, cache: testCache });
    await mergeStrategy({ merchantId: 'M002', storeId: 'S001', loader, cache: testCache });
    expect(loader._calls.platform).toBe(3);
  });

  it('clear 后再读 → loader 再次调用', async () => {
    const loader = buildLoader();
    await mergeStrategy({ merchantId: 'M001', storeId: 'S001', loader, cache: testCache });
    testCache.clear();
    await mergeStrategy({ merchantId: 'M001', storeId: 'S001', loader, cache: testCache });
    expect(loader._calls.platform).toBe(2);
  });
});

describe('safety/strategy-engine — 降级(strategy_json 损坏)', () => {
  let testCache: LRUCache<string, CachedStrategyEntry>;
  beforeEach(() => {
    testCache = new LRUCache<string, CachedStrategyEntry>({
      max: STRATEGY_CACHE_MAX,
      ttl: STRATEGY_CACHE_TTL_MS,
    });
    resetStrategyEngineForTest(testCache);
  });

  it('store 字段类型错误 → fallback platform default + degraded=true', async () => {
    const loader = buildLoader({
      // forecastDays 必须是 positive int,这里给字符串触发 schema fail
      store: {
        strategyJson: { replenishmentPolicy: { forecastDays: 'not-a-number' } },
        version: 'bad-store',
      },
    });
    const entry = await mergeStrategy({
      merchantId: 'M001',
      storeId: 'S001',
      loader,
      cache: testCache,
    });
    expect(entry.degraded).toBe(true);
    expect(entry.version).toContain('#degraded');
    // 降级后等价于 platform 默认
    expect((entry.merged as { replenishmentPolicy: { forecastDays: number } })
      .replenishmentPolicy.forecastDays).toBe(7);
  });

  it('降级也会写入 LRU(下次同 key 仍命中降级版本,避免反复打 DB)', async () => {
    const loader = buildLoader({
      store: {
        strategyJson: { replenishmentPolicy: { forecastDays: 'bad' } },
        version: 'bad-store',
      },
    });
    await mergeStrategy({ merchantId: 'M001', storeId: 'S001', loader, cache: testCache });
    await mergeStrategy({ merchantId: 'M001', storeId: 'S001', loader, cache: testCache });
    expect(loader._calls.store).toBe(1);
  });
});

describe('safety/strategy-engine — 错误 / 边界', () => {
  it('未注入 loader 抛错(防止生产忘记 bootstrap)', async () => {
    const cache = new LRUCache<string, CachedStrategyEntry>({
      max: 8,
      ttl: 60_000,
    });
    resetStrategyEngineForTest(cache);
    const caught: unknown = await mergeStrategy({ merchantId: 'M', storeId: 'S', cache }).catch(
      (err: unknown) => err,
    );
    expect(caught).toBeInstanceOf(BizError);
    if (!(caught instanceof BizError)) throw new Error('expected BizError');
    expect(caught.code).toBe('INTERNAL_ERROR');
    expect(caught.message).toMatch(/StrategyLoader 未注入/);
  });

  it('platform loader 抛错 → 错误向上抛(无 platform 无法降级)', async () => {
    const cache = new LRUCache<string, CachedStrategyEntry>({ max: 8, ttl: 60_000 });
    const loader: StrategyLoader = {
      loadPlatformDefault: () => Promise.reject(new Error('DB down')),
      loadMerchantStrategy: () => Promise.resolve(null),
      loadStoreStrategy: () => Promise.resolve(null),
    };
    await expect(
      mergeStrategy({ merchantId: 'M', storeId: 'S', loader, cache }),
    ).rejects.toThrow(/DB down/);
  });

  it('merchant loader 抛错(store 同时挂)→ 等价于只用 platform 默认', async () => {
    const cache = new LRUCache<string, CachedStrategyEntry>({ max: 8, ttl: 60_000 });
    const merchantSpy = vi.fn().mockRejectedValue(new Error('DB partial'));
    const storeSpy = vi.fn().mockRejectedValue(new Error('DB partial'));
    const loader: StrategyLoader = {
      loadPlatformDefault: () =>
        Promise.resolve({
          strategyJson: structuredClone(PLATFORM_DEFAULT_JSON),
          version: 'p-1',
        }),
      loadMerchantStrategy: merchantSpy,
      loadStoreStrategy: storeSpy,
    };
    const entry = await mergeStrategy({
      merchantId: 'M',
      storeId: 'S',
      loader,
      cache,
    });
    expect(entry.degraded).toBe(false);
    // version 中 m / s 都是 0
    expect(entry.version).toBe('M0-S0-Pp-1');
  });
});

describe('safety/strategy-cache — applyInvalidation 边界', () => {
  it('PLATFORM scope → 全清', () => {
    const cache = new LRUCache<string, CachedStrategyEntry>({ max: 8, ttl: 60_000 });
    cache.set('M001:S001', { merged: {}, version: 'v', degraded: false });
    cache.set('M002:S001', { merged: {}, version: 'v', degraded: false });
    applyInvalidation(
      { scope: 'PLATFORM', merchantId: null, storeId: null, invalidatedAt: new Date() },
      cache,
    );
    expect(cache.size).toBe(0);
  });

  it('MERCHANT scope → 删该商家所有门店', () => {
    const cache = new LRUCache<string, CachedStrategyEntry>({ max: 8, ttl: 60_000 });
    cache.set('M001:S001', { merged: {}, version: 'v', degraded: false });
    cache.set('M001:S002', { merged: {}, version: 'v', degraded: false });
    cache.set('M002:S001', { merged: {}, version: 'v', degraded: false });
    applyInvalidation(
      { scope: 'MERCHANT', merchantId: 'M001', storeId: null, invalidatedAt: new Date() },
      cache,
    );
    expect(cache.has('M001:S001')).toBe(false);
    expect(cache.has('M001:S002')).toBe(false);
    expect(cache.has('M002:S001')).toBe(true);
  });

  it('STORE scope → 仅删单 key', () => {
    const cache = new LRUCache<string, CachedStrategyEntry>({ max: 8, ttl: 60_000 });
    cache.set('M001:S001', { merged: {}, version: 'v', degraded: false });
    cache.set('M001:S002', { merged: {}, version: 'v', degraded: false });
    applyInvalidation(
      {
        scope: 'STORE',
        merchantId: 'M001',
        storeId: 'S001',
        invalidatedAt: new Date(),
      },
      cache,
    );
    expect(cache.has('M001:S001')).toBe(false);
    expect(cache.has('M001:S002')).toBe(true);
  });

  it('MERCHANT scope 缺 merchantId → no-op(防 prefix 误删)', () => {
    const cache = new LRUCache<string, CachedStrategyEntry>({ max: 8, ttl: 60_000 });
    cache.set('M001:S001', { merged: {}, version: 'v', degraded: false });
    applyInvalidation(
      { scope: 'MERCHANT', merchantId: null, storeId: null, invalidatedAt: new Date() },
      cache,
    );
    expect(cache.has('M001:S001')).toBe(true);
  });
});
