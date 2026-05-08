/**
 * 切片 13 §9 第 5 / 8 / 10 步 — 过期 Job 单测（分批 + sleep + cron 注册 + 边界）
 *
 * 覆盖（任务卡 §10 测试场景 5 / 6 / 7 / 12）:
 *   - 1500 条过期草稿 → 3 批 × 500（中间 sleep 100ms）
 *   - 31 分钟未动作的 DRAFT / WAIT_CONFIRM → EXPIRED
 *   - CONFIRMED / 终态行不被改（防误改 SUBMITTED 路径）
 *   - 跨租户：Job 不带 merchant/store WHERE，但只命中 DRAFT/WAIT_CONFIRM 状态
 *   - cron 注册 / stop / 防重叠 / onError swallow
 *   - 防御上限：超过 maxBatches → BizError(INTERNAL_ERROR)
 *
 * 依赖：与 draft-manager.test.ts 共用 FakeDraftPool 形态（这里就地最小化重写以避免环依赖）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resetDraftManagerForTest,
  setDraftPool,
  type DraftPool,
} from '../draft-manager.js';

import {
  EXPIRE_DRAFTS_BATCH_LIMIT,
  EXPIRE_DRAFTS_BATCH_SLEEP_MS,
  EXPIRE_DRAFTS_DEFAULT_INTERVAL_MS,
  EXPIRE_DRAFTS_MAX_BATCHES_PER_TICK,
  expireDraftsJob,
  sleep,
  startExpireDraftsCron,
} from './expire-drafts.js';

/* ============================================================================
 * Fake DraftPool —— 仅识别 expire-drafts UPDATE SQL（跨租户语义不参与本 Job）
 * ========================================================================== */

interface SimpleRow {
  draft_id: string;
  status: 'DRAFT' | 'WAIT_CONFIRM' | 'CONFIRMED' | 'SUBMITTED' | 'EXPIRED' | 'CANCELLED' | 'FAILED';
  updated_at: Date;
}

class FakeExpirePool implements DraftPool {
  public rows: SimpleRow[] = [];
  public clock = new Date('2026-05-07T01:00:00.000Z');
  public executeCalls: Array<{ sql: string; params: unknown[]; ts: number }> = [];

  /** 简化 query：本 Job 不调 query；保留 throw 以便误调可见 */
  query<T extends Record<string, unknown>>(): Promise<[T[], unknown]> {
    throw new Error('FakeExpirePool: query 不应被 expire-drafts 调用');
  }

  execute(
    sql: string,
    params: readonly unknown[],
  ): Promise<[{ affectedRows: number }, unknown]> {
    const ts = Date.now();
    this.executeCalls.push({ sql, params: [...params], ts });
    const norm = sql.replace(/\s+/g, ' ').trim();
    if (
      norm.startsWith('UPDATE replenishment_draft') &&
      norm.includes(`SET status = 'EXPIRED'`) &&
      norm.includes(`status IN ('DRAFT', 'WAIT_CONFIRM')`) &&
      norm.includes('updated_at < NOW(3) - INTERVAL 30 MINUTE') &&
      norm.includes('LIMIT ?')
    ) {
      const [limit] = params as [number];
      const cutoff = new Date(this.clock.getTime() - 30 * 60_000);
      let count = 0;
      for (const r of this.rows) {
        if (count >= limit) break;
        if ((r.status === 'DRAFT' || r.status === 'WAIT_CONFIRM') && r.updated_at < cutoff) {
          r.status = 'EXPIRED';
          r.updated_at = this.clock;
          count += 1;
        }
      }
      return Promise.resolve([{ affectedRows: count }, undefined]);
    }
    throw new Error(`FakeExpirePool: 未识别 SQL: ${norm}`);
  }
}

/* ============================================================================
 * helpers
 * ========================================================================== */

function seedExpiredRows(pool: FakeExpirePool, count: number): void {
  // 32 分钟前的 DRAFT / WAIT_CONFIRM 各占一半
  const old = new Date(pool.clock.getTime() - 32 * 60_000);
  for (let i = 0; i < count; i += 1) {
    pool.rows.push({
      draft_id: `drf_${'a'.repeat(20)}${i}`,
      status: i % 2 === 0 ? 'DRAFT' : 'WAIT_CONFIRM',
      updated_at: old,
    });
  }
}

let pool: FakeExpirePool;

beforeEach(() => {
  pool = new FakeExpirePool();
  setDraftPool(pool);
});

afterEach(() => {
  resetDraftManagerForTest();
  vi.useRealTimers();
});

/* ============================================================================
 * §10.12 — 1500 条过期草稿 → 3 批 × 500（中间 sleep 100ms）
 * ========================================================================== */

describe('safety/jobs/expire-drafts — 分批 + sleep', () => {
  it('1500 条过期 → 4 批（500/500/500/0）；中间 sleep ≥ 100ms', async () => {
    seedExpiredRows(pool, 1500);
    const result = await expireDraftsJob({ pool });
    expect(result.totalAffected).toBe(1500);
    // 4 批：3 批 × 500 + 1 批 0（用于退出 while）
    expect(result.batches).toBe(4);
    // 各批 LIMIT 都是 500
    for (const c of pool.executeCalls) {
      expect(c.params[0]).toBe(EXPIRE_DRAFTS_BATCH_LIMIT);
    }
    // 相邻有效批之间间隔 ≥ 90ms（容忍 timer 抖动）
    const gaps = pool.executeCalls.slice(1).map((c, i) => {
      const prev = pool.executeCalls[i];
      expect(prev).toBeDefined();
      return c.ts - (prev?.ts ?? c.ts);
    });
    expect(gaps.every((g) => g >= 90)).toBe(true);
  });

  it('0 条过期 → 1 批退出，totalAffected=0', async () => {
    const result = await expireDraftsJob({ pool });
    expect(result.batches).toBe(1);
    expect(result.totalAffected).toBe(0);
  });

  it('600 条过期 → 2 批（500 + 100）+ 1 批 0', async () => {
    seedExpiredRows(pool, 600);
    const result = await expireDraftsJob({ pool });
    expect(result.totalAffected).toBe(600);
    expect(result.batches).toBe(3);
  });
});

/* ============================================================================
 * §10.5-§10.7 — 状态过滤（DRAFT/WAIT_CONFIRM EXPIRED；CONFIRMED 不过期）
 * ========================================================================== */

describe('safety/jobs/expire-drafts — 状态过滤', () => {
  it('CONFIRMED 状态 31 分钟也不过期', async () => {
    pool.rows.push({
      draft_id: 'drf_aaaaaaaaaaaaaaaaaaaaa',
      status: 'CONFIRMED',
      updated_at: new Date(pool.clock.getTime() - 31 * 60_000),
    });
    const result = await expireDraftsJob({ pool });
    expect(result.totalAffected).toBe(0);
    const [row] = pool.rows;
    expect(row?.status).toBe('CONFIRMED');
  });

  it('终态行（SUBMITTED / EXPIRED / CANCELLED / FAILED）一律不被改', async () => {
    const oldTs = new Date(pool.clock.getTime() - 60 * 60_000);
    pool.rows.push({ draft_id: 'd1', status: 'SUBMITTED', updated_at: oldTs });
    pool.rows.push({ draft_id: 'd2', status: 'EXPIRED', updated_at: oldTs });
    pool.rows.push({ draft_id: 'd3', status: 'CANCELLED', updated_at: oldTs });
    pool.rows.push({ draft_id: 'd4', status: 'FAILED', updated_at: oldTs });
    const result = await expireDraftsJob({ pool });
    expect(result.totalAffected).toBe(0);
    expect(pool.rows.every((r) => r.status !== 'EXPIRED' || r.draft_id === 'd2')).toBe(true);
  });

  it('阈值边界：刚好 30 分钟前不过期；31 分钟前过期', async () => {
    pool.rows.push({
      draft_id: 'd_at_30',
      status: 'DRAFT',
      updated_at: new Date(pool.clock.getTime() - 30 * 60_000),
    });
    pool.rows.push({
      draft_id: 'd_after_31',
      status: 'DRAFT',
      updated_at: new Date(pool.clock.getTime() - 31 * 60_000),
    });
    const result = await expireDraftsJob({ pool });
    expect(result.totalAffected).toBe(1);
    expect(pool.rows.find((r) => r.draft_id === 'd_at_30')?.status).toBe('DRAFT');
    expect(pool.rows.find((r) => r.draft_id === 'd_after_31')?.status).toBe('EXPIRED');
  });

  it('UPDATE SQL 形态：SET status=EXPIRED + status IN(DRAFT,WAIT_CONFIRM) + INTERVAL 30 MINUTE', async () => {
    seedExpiredRows(pool, 1);
    await expireDraftsJob({ pool });
    const [call] = pool.executeCalls;
    expect(call).toBeDefined();
    const sql = call?.sql.replace(/\s+/g, ' ').trim() ?? '';
    expect(sql).toContain(`SET status = 'EXPIRED'`);
    expect(sql).toContain('updated_at = NOW(3)');
    expect(sql).toContain(`status IN ('DRAFT', 'WAIT_CONFIRM')`);
    expect(sql).toContain('updated_at < NOW(3) - INTERVAL 30 MINUTE');
    expect(sql).toContain('LIMIT ?');
  });
});

/* ============================================================================
 * 防御上限 / 错误传播
 * ========================================================================== */

describe('safety/jobs/expire-drafts — 防御上限 / 错误传播', () => {
  it('超过 maxBatches 上限 → BizError(INTERNAL_ERROR)', async () => {
    // 自造一个永远返回 affectedRows>0 的 pool（模拟 idx 失效 / 业务量爆炸）
    let calls = 0;
    const infinitePool: DraftPool = {
      query: () => {
        throw new Error('not used');
      },
      execute: () => {
        calls += 1;
        return Promise.resolve([{ affectedRows: 1 }, undefined]);
      },
    };
    await expect(
      expireDraftsJob({ pool: infinitePool, maxBatches: 3 }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(calls).toBe(3);
  });

  it('未注入 pool 且未传 pool 参数 → 抛 DraftPool 未注入', async () => {
    resetDraftManagerForTest();
    await expect(expireDraftsJob()).rejects.toThrow(/DraftPool 未注入/);
  });

  it('SQL 异常 → 直接抛出（不 swallow，由 cron tick 的 onError 收口）', async () => {
    const errorPool: DraftPool = {
      query: () => Promise.reject(new Error('not used')),
      execute: () => Promise.reject(new Error('mysql gone')),
    };
    await expect(expireDraftsJob({ pool: errorPool })).rejects.toThrow(/mysql gone/);
  });
});

/* ============================================================================
 * sleep helper
 * ========================================================================== */

describe('safety/jobs/expire-drafts — sleep helper', () => {
  it('sleep(50) 至少等 45ms', async () => {
    const start = Date.now();
    await sleep(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });

  it('sleep timer 调用 unref()，不悬挂主进程', async () => {
    // 仅形态校验：调用一次确保不抛错；真正"不悬挂"由 setTimeout(...).unref() 兜底
    await expect(sleep(1)).resolves.toBeUndefined();
  });
});

/* ============================================================================
 * cron 注册 / stop / 防重叠 / onError
 * ========================================================================== */

describe('safety/jobs/expire-drafts — startExpireDraftsCron', () => {
  it('返回 stop 函数；调用后 setInterval 被 clear', async () => {
    vi.useFakeTimers();
    const stop = startExpireDraftsCron({ pool, intervalMs: 1000 });
    // 触发一次 tick
    await vi.advanceTimersByTimeAsync(1000);
    const callsBefore = pool.executeCalls.length;
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    const callsAfter = pool.executeCalls.length;
    expect(callsAfter).toBe(callsBefore);
  });

  it('stop 幂等：多次调用不抛错', () => {
    const stop = startExpireDraftsCron({ pool, intervalMs: 60_000 });
    expect(() => {
      stop();
      stop();
      stop();
    }).not.toThrow();
  });

  it('防重叠：上一次 tick 未完成时新的 tick 直接 skip', async () => {
    vi.useFakeTimers();
    let resolveBlocker: (() => void) | null = null;
    const blocker = new Promise<void>((r) => (resolveBlocker = r));
    let calls = 0;
    const slowPool: DraftPool = {
      query: () => {
        throw new Error('not used');
      },
      execute: async () => {
        calls += 1;
        await blocker; // 卡住第一次 tick
        return [{ affectedRows: 0 }, undefined];
      },
    };
    const stop = startExpireDraftsCron({ pool: slowPool, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(100); // tick 1 启动并卡住
    await vi.advanceTimersByTimeAsync(100); // tick 2 应被 running=true skip
    await vi.advanceTimersByTimeAsync(100); // tick 3 同
    expect(calls).toBe(1);
    resolveBlocker!();
    stop();
  });

  it('单次 tick 抛错：onError 收口；后续 tick 仍能继续', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const flakyPool: DraftPool = {
      query: () => {
        throw new Error('not used');
      },
      execute: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('transient'));
        return Promise.resolve([{ affectedRows: 0 }, undefined]);
      },
    };
    const errors: unknown[] = [];
    const stop = startExpireDraftsCron({
      pool: flakyPool,
      intervalMs: 50,
      onError: (e) => errors.push(e),
    });
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    expect(errors.length).toBe(1);
    expect((errors[0] as Error).message).toContain('transient');
    expect(calls).toBeGreaterThanOrEqual(2);
    stop();
  });

  it('默认 intervalMs = 5 分钟（任务卡 §6 cron 5 分钟）', () => {
    expect(EXPIRE_DRAFTS_DEFAULT_INTERVAL_MS).toBe(5 * 60 * 1000);
  });

  it('未传 intervalMs 时按默认 5 分钟触发 tick', async () => {
    vi.useFakeTimers();

    const stop = startExpireDraftsCron({ pool });

    await vi.advanceTimersByTimeAsync(EXPIRE_DRAFTS_DEFAULT_INTERVAL_MS - 1);
    expect(pool.executeCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(pool.executeCalls).toHaveLength(1);

    stop();
  });

  it('默认 maxBatches = 防御上限常量', () => {
    expect(EXPIRE_DRAFTS_MAX_BATCHES_PER_TICK).toBeGreaterThan(0);
  });

  it('默认 batchLimit = 500（任务卡 §7 MUST DO §4）', () => {
    expect(EXPIRE_DRAFTS_BATCH_LIMIT).toBe(500);
  });

  it('默认 batchSleep = 100ms（任务卡 §8.5）', () => {
    expect(EXPIRE_DRAFTS_BATCH_SLEEP_MS).toBe(100);
  });

  it('默认 onError 走 pino warn（不抛错；不传 onError 也不会 crash）', async () => {
    vi.useFakeTimers();
    const flakyPool: DraftPool = {
      query: () => {
        throw new Error('not used');
      },
      execute: () => Promise.reject(new Error('boom-default-onerror')),
    };
    const stop = startExpireDraftsCron({ pool: flakyPool, intervalMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    // 等待微任务结算
    await vi.advanceTimersByTimeAsync(0);
    stop();
    // 仅断言不抛出（pino 自己的 transport 已在 logger.test.ts 单独覆盖）
  });

  it('maxBatchesPerTick 会透传给单次 job 上限', async () => {
    vi.useFakeTimers();
    const infinitePool: DraftPool = {
      query: () => {
        throw new Error('not used');
      },
      execute: () => Promise.resolve([{ affectedRows: 1 }, undefined]),
    };
    const errors: unknown[] = [];

    const stop = startExpireDraftsCron({
      pool: infinitePool,
      intervalMs: 50,
      maxBatchesPerTick: 1,
      onError: (e) => errors.push(e),
    });

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(EXPIRE_DRAFTS_BATCH_SLEEP_MS);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'INTERNAL_ERROR' });
    stop();
  });

  it('cron tick 命中过期行 → 触发 logger.info（totalAffected > 0 分支）', async () => {
    vi.useFakeTimers();
    seedExpiredRows(pool, 3);
    const stop = startExpireDraftsCron({ pool, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    // 让 tick 内部 sleep(100) + 二次 UPDATE 完成；多推一段时间
    await vi.advanceTimersByTimeAsync(200);
    stop();
    // 至少有一次 UPDATE 命中（totalAffected=3 触发 logger.info 分支）
    expect(pool.executeCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('stopped 后再次 tick 被 early-return（防止 setInterval 与 stop 之间的竞态）', async () => {
    vi.useFakeTimers();
    const stop = startExpireDraftsCron({ pool, intervalMs: 100 });
    stop();
    // 触发 setInterval（理论上已被 clear；此处仅作保险，再 advance 一次）
    await vi.advanceTimersByTimeAsync(1000);
    expect(pool.executeCalls.length).toBe(0);
  });
});
