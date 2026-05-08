/**
 * 切片 11 §9 第 3 步 — invalidation 30s 轮询单测
 *
 * 用 vitest fake timers 模拟 setInterval(避免真等 30s)。
 * 验证:
 *   1) 启动后每 intervalMs 触发一次 loader.loadSince()
 *   2) lastSeen 推进到当批最大 invalidatedAt(下次只捞增量)
 *   3) loader 抛错 → 走 onError,不抛出打断后续轮询
 *   4) stop 函数返回后 setInterval 清除
 *   5) pollOnce(辅助函数)单步触发等价于 setInterval 一次 tick
 */
import { LRUCache } from 'lru-cache';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type CachedStrategyEntry,
  type InvalidationLoader,
  type InvalidationRow,
  type StrategyInvalidationPool,
  applyInvalidation,
  createMysqlStrategyInvalidationLoader,
  pollOnce,
  startStrategyInvalidationPolling,
  strategyCache,
} from './strategy-cache.js';

function buildLoader(rows: InvalidationRow[]) {
  const calls: Date[] = [];
  const loader: InvalidationLoader = {
    loadSince: (since) => {
      calls.push(since);
      return Promise.resolve(rows.filter((r) => r.invalidatedAt > since));
    },
  };
  return { loader, calls };
}

describe('safety/strategy-cache — startStrategyInvalidationPolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('每 intervalMs 触发一次 tick', async () => {
    const cache = new LRUCache<string, CachedStrategyEntry>({ max: 8, ttl: 60_000 });
    cache.set('M001:S001', { merged: {}, version: 'v', degraded: false });
    const { loader, calls } = buildLoader([
      {
        scope: 'STORE',
        merchantId: 'M001',
        storeId: 'S001',
        invalidatedAt: new Date(Date.now() + 1000),
      },
    ]);

    const stop = startStrategyInvalidationPolling({
      loader,
      intervalMs: 30_000,
      cache,
    });

    // 模拟 30s + microtask flush
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(cache.has('M001:S001')).toBe(false);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.length).toBeGreaterThanOrEqual(2);

    stop();
  });

  it('lastSeen 推进:第二次轮询 since > 第一次 invalidatedAt', async () => {
    const cache = new LRUCache<string, CachedStrategyEntry>({ max: 8, ttl: 60_000 });
    const t1 = new Date(Date.now() + 1_000);
    const t2 = new Date(Date.now() + 2_000);
    const rows: InvalidationRow[] = [
      { scope: 'PLATFORM', merchantId: null, storeId: null, invalidatedAt: t1 },
      { scope: 'PLATFORM', merchantId: null, storeId: null, invalidatedAt: t2 },
    ];
    const { loader, calls } = buildLoader(rows);

    const stop = startStrategyInvalidationPolling({
      loader,
      intervalMs: 30_000,
      cache,
      startSince: new Date(0),
    });

    await vi.advanceTimersByTimeAsync(30_000);
    // 第一次 since 是 epoch 0,捞到 t1 / t2
    expect(calls[0]?.getTime()).toBe(0);

    await vi.advanceTimersByTimeAsync(30_000);
    // 第二次 since 应该是 t2(已推进)
    expect(calls[1]?.getTime()).toBe(t2.getTime());

    stop();
  });

  it('loader 抛错 → onError 被调用,不打断后续轮询', async () => {
    let callCount = 0;
    const errs: unknown[] = [];
    const loader: InvalidationLoader = {
      loadSince: () => {
        callCount += 1;
        if (callCount === 1) return Promise.reject(new Error('DB down'));
        return Promise.resolve([]);
      },
    };

    const stop = startStrategyInvalidationPolling({
      loader,
      intervalMs: 30_000,
      onError: (e) => errs.push(e),
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(callCount).toBe(2);
    expect(errs).toHaveLength(1);
    expect((errs[0] as Error).message).toBe('DB down');

    stop();
  });

  it('stop 后不再触发 tick', async () => {
    const { loader, calls } = buildLoader([]);
    const stop = startStrategyInvalidationPolling({
      loader,
      intervalMs: 30_000,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    const before = calls.length;

    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.length).toBe(before);
  });

  it('上一次 tick 未完成时,新 tick 立即跳过(防叠加)', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const loader: InvalidationLoader = {
      async loadSince() {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 100_000)); // 远超 interval
        inflight -= 1;
        return [];
      },
    };

    const stop = startStrategyInvalidationPolling({
      loader,
      intervalMs: 30_000,
    });

    // 触发多次 setInterval,但只有第一次会真正进入 loader
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(maxInflight).toBe(1);

    stop();
  });

  it('未传 intervalMs 时使用默认 30s 轮询', async () => {
    const { loader, calls } = buildLoader([]);

    const stop = startStrategyInvalidationPolling({ loader });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);

    stop();
  });
});

describe('safety/strategy-cache — pollOnce(单步辅助)', () => {
  it('返回 nextSince + consumed 数量;命中行清 LRU', async () => {
    const cache = new LRUCache<string, CachedStrategyEntry>({ max: 8, ttl: 60_000 });
    cache.set('M001:S001', { merged: {}, version: 'v', degraded: false });
    const t1 = new Date(Date.now() + 1000);
    const { loader } = buildLoader([
      { scope: 'STORE', merchantId: 'M001', storeId: 'S001', invalidatedAt: t1 },
    ]);

    const result = await pollOnce({ loader, since: new Date(0), cache });
    expect(result.consumed).toBe(1);
    expect(result.nextSince.getTime()).toBe(t1.getTime());
    expect(cache.has('M001:S001')).toBe(false);
  });

  it('无新增 → consumed=0,since 不变', async () => {
    const cache = new LRUCache<string, CachedStrategyEntry>({ max: 8, ttl: 60_000 });
    const { loader } = buildLoader([]);
    const since = new Date(123);
    const result = await pollOnce({ loader, since, cache });
    expect(result.consumed).toBe(0);
    expect(result.nextSince.getTime()).toBe(since.getTime());
  });

  it('未传 cache 时使用全局 strategyCache', async () => {
    strategyCache.clear();
    strategyCache.set('M001:S001', { merged: {}, version: 'v', degraded: false });

    const t1 = new Date(Date.now() + 1000);
    const { loader } = buildLoader([
      { scope: 'STORE', merchantId: 'M001', storeId: 'S001', invalidatedAt: t1 },
    ]);

    const result = await pollOnce({ loader, since: new Date(0) });

    expect(result.consumed).toBe(1);
    expect(strategyCache.has('M001:S001')).toBe(false);
    strategyCache.clear();
  });
});

describe('safety/strategy-cache — MySQL invalidation loader', () => {
  it('invalidatedAt 为 Date 时直接映射为 Date', async () => {
    const invalidatedAt = new Date('2026-05-08T00:00:00.000Z');
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool: StrategyInvalidationPool = {
      query: <T extends Record<string, unknown>[]>(sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return Promise.resolve([
          [
            {
              scope: 'STORE',
              merchantId: 'M001',
              storeId: 'S001',
              invalidatedAt,
            },
          ] as unknown as T,
          undefined,
        ]);
      },
    };

    const loader = createMysqlStrategyInvalidationLoader(pool);
    const rows = await loader.loadSince(new Date(0));

    expect(rows).toEqual([
      { scope: 'STORE', merchantId: 'M001', storeId: 'S001', invalidatedAt },
    ]);
    expect(calls[0]?.params).toEqual([new Date(0)]);
  });
});

describe('safety/strategy-cache — 30s 轮询端到端(任务卡 §9 第 3 步行为断言)', () => {
  it('插入 invalidation 行 → 30s 内 LRU 对应 key 被清', async () => {
    vi.useFakeTimers();
    try {
      const cache = new LRUCache<string, CachedStrategyEntry>({ max: 8, ttl: 60_000 });
      cache.set('M001:S001', { merged: {}, version: 'v', degraded: false });
      const inserted: InvalidationRow[] = [];
      const loader: InvalidationLoader = {
        loadSince: (since) => Promise.resolve(inserted.filter((r) => r.invalidatedAt > since)),
      };

      const stop = startStrategyInvalidationPolling({
        loader,
        intervalMs: 30_000,
        cache,
      });

      // 模拟外部往 invalidation 表插一条
      inserted.push({
        scope: 'STORE',
        merchantId: 'M001',
        storeId: 'S001',
        invalidatedAt: new Date(Date.now() + 100),
      });
      // 30s 内一次轮询命中
      await vi.advanceTimersByTimeAsync(30_000);
      expect(cache.has('M001:S001')).toBe(false);

      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('safety/strategy-cache — applyInvalidation 复合场景', () => {
  it('多商家 / 多门店 keys 共存时,MERCHANT scope 仅清 prefix 命中', () => {
    const cache = new LRUCache<string, CachedStrategyEntry>({ max: 8, ttl: 60_000 });
    cache.set('M001:S001', { merged: {}, version: 'v', degraded: false });
    cache.set('M001:S002', { merged: {}, version: 'v', degraded: false });
    cache.set('M001:S003', { merged: {}, version: 'v', degraded: false });
    cache.set('M002:S001', { merged: {}, version: 'v', degraded: false });
    cache.set('M010:S001', { merged: {}, version: 'v', degraded: false }); // prefix M001 子串校验

    applyInvalidation(
      { scope: 'MERCHANT', merchantId: 'M001', storeId: null, invalidatedAt: new Date() },
      cache,
    );

    expect(cache.has('M001:S001')).toBe(false);
    expect(cache.has('M001:S002')).toBe(false);
    expect(cache.has('M001:S003')).toBe(false);
    expect(cache.has('M002:S001')).toBe(true);
    expect(cache.has('M010:S001')).toBe(true);
  });
});
