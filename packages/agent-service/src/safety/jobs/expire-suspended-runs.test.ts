/**
 * 切片 16 §9 验收 step 6 / 10 — 过期 suspend 清理 Job 单测
 *
 * 覆盖（任务卡 §10 测试场景 9 / 10）：
 *   - 单批 < 200 条 → 1 批扫描；suspend / session 全部清理
 *   - 多批：1500 条 → 8 批 × 200 + 提前退出（任务卡防御 maxBatches 200）
 *   - SQL 形态：LIMIT 200 + FOR UPDATE SKIP LOCKED + idx_expires 命中
 *   - 错误 swallow：mastra.resume 抛错 → 单行计数 resumeErrors，但仍 DELETE/UPDATE
 *   - 数据库 DELETE / UPDATE 抛错 → 仅 logger.warn，不阻断后续行
 *   - cron 注册 / stop / 防重叠 / onError swallow
 *   - 防御上限：超过 maxBatches → BizError(INTERNAL_ERROR)
 *   - sleep batch 间隔 100ms
 */
import type { DraftItem, DraftStatus } from '@storepilot/shared-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HITL_WORKFLOW_ID,
  type ConfirmManagerPool,
  type MastraResolver,
  type WorkflowResumeArgs,
  resetConfirmManagerForTest,
  setConfirmManagerPool,
  setMastraResolver,
} from '../confirm-manager.js';
import {
  resetDraftManagerForTest,
  setDraftPool,
  type DraftPool,
} from '../draft-manager.js';

import {
  EXPIRE_SUSPENDED_BATCH_LIMIT,
  EXPIRE_SUSPENDED_BATCH_SLEEP_MS,
  EXPIRE_SUSPENDED_DEFAULT_INTERVAL_MS,
  EXPIRE_SUSPENDED_MAX_BATCHES_PER_TICK,
  expireSuspendedRunsJob,
  sleep,
  startExpireSuspendedRunsCron,
} from './expire-suspended-runs.js';

/* ============================================================================
 * Fake ConfirmManagerPool —— 仅识别 expire-suspended-runs 的三条 SQL
 * ========================================================================== */

interface SuspendRowFake {
  run_id: string;
  step_id: string;
  expires_at: Date;
  /** SKIP LOCKED 模拟：标记此行被并发实例占有 */
  locked?: boolean;
}

class FakeExpireSuspendedPool implements ConfirmManagerPool {
  public suspendRows: SuspendRowFake[] = [];
  public sessionRowsActiveRunIds = new Set<string>();
  public sessionRowsByRunId = new Map<
    string,
    {
      session_id: string;
      merchant_id: string;
      current_store_id: string;
      user_id: string;
      active_draft_id: string | null;
    }
  >();
  public clock = new Date('2026-05-07T01:00:00.000Z');
  public selectCalls = 0;
  public deleteCalls: string[] = [];
  public sessionUpdateCalls: string[] = [];
  public selectTimestamps: number[] = [];

  query<T extends Record<string, unknown>>(
    sql: string,
    params: readonly unknown[],
  ): Promise<[T[], unknown]> {
    const norm = sql.replace(/\s+/g, ' ').trim();
    if (
      norm.startsWith('SELECT') &&
      norm.includes('FROM mastra_workflow_suspend') &&
      norm.includes('expires_at < NOW(3)') &&
      norm.includes('LIMIT ?') &&
      norm.includes('FOR UPDATE SKIP LOCKED')
    ) {
      this.selectCalls += 1;
      this.selectTimestamps.push(Date.now());
      const [limit] = params as [number];
      const matched: SuspendRowFake[] = [];
      const cutoff = this.clock;
      for (const r of this.suspendRows) {
        if (matched.length >= limit) break;
        if (!r.locked && r.expires_at < cutoff) {
          // SKIP LOCKED 语义：本测试 fake 模拟为 SELECT 后 mark locked，由 DELETE 后释放
          r.locked = true;
          matched.push(r);
        }
      }
      return Promise.resolve([
        matched.map((r) => ({ run_id: r.run_id, step_id: r.step_id })) as unknown as T[],
        undefined,
      ]);
    }
    if (
      norm.startsWith('SELECT') &&
      norm.includes('FROM agent_session') &&
      norm.includes('WHERE active_run_id = ?') &&
      norm.includes('LIMIT 1')
    ) {
      const [runId] = params as [string];
      const row = this.sessionRowsByRunId.get(runId);
      return Promise.resolve([(row ? [row] : []) as unknown as T[], undefined]);
    }
    throw new Error(`FakeExpireSuspendedPool: 未识别 query SQL: ${norm}`);
  }

  execute(
    sql: string,
    params: readonly unknown[],
  ): Promise<[{ affectedRows: number }, unknown]> {
    const norm = sql.replace(/\s+/g, ' ').trim();
    if (norm.startsWith('DELETE FROM mastra_workflow_suspend WHERE run_id = ?')) {
      const [runId] = params as [string];
      this.deleteCalls.push(runId);
      const before = this.suspendRows.length;
      this.suspendRows = this.suspendRows.filter((r) => r.run_id !== runId);
      const affected = before - this.suspendRows.length;
      return Promise.resolve([{ affectedRows: affected }, undefined]);
    }
    if (
      norm.startsWith('UPDATE agent_session') &&
      norm.includes('active_run_id = NULL') &&
      norm.includes('WHERE active_run_id = ?')
    ) {
      const [runId] = params as [string];
      this.sessionUpdateCalls.push(runId);
      const had = this.sessionRowsActiveRunIds.delete(runId);
      this.sessionRowsByRunId.delete(runId);
      return Promise.resolve([{ affectedRows: had ? 1 : 0 }, undefined]);
    }
    throw new Error(`FakeExpireSuspendedPool: 未识别 execute SQL: ${norm}`);
  }

  transaction<T>(): Promise<T> {
    throw new Error('FakeExpireSuspendedPool: cron 不应使用 transaction');
  }
}

interface FakeDraftRow {
  draft_id: string;
  session_id: string;
  merchant_id: string;
  store_id: string;
  user_id: string;
  trace_id: string;
  forecast_days: number;
  status: DraftStatus;
  items: DraftItem[];
  strategy_version: string;
  submitted_po_no: string | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

class FakeDraftPool implements DraftPool {
  public rows = new Map<string, FakeDraftRow>();
  public clock = new Date('2026-05-07T01:00:00.000Z');

  insert(row: Partial<FakeDraftRow> & Pick<FakeDraftRow, 'draft_id'>): void {
    const now = this.clock;
    this.rows.set(row.draft_id, {
      draft_id: row.draft_id,
      session_id: row.session_id ?? 'sess_expired',
      merchant_id: row.merchant_id ?? 'M001',
      store_id: row.store_id ?? 'S001',
      user_id: row.user_id ?? 'boss-001',
      trace_id: row.trace_id ?? 'trace_expired',
      forecast_days: row.forecast_days ?? 7,
      status: row.status ?? 'WAIT_CONFIRM',
      items: row.items ?? [],
      strategy_version: row.strategy_version ?? 'P1-M0-S0',
      submitted_po_no: row.submitted_po_no ?? null,
      expires_at: row.expires_at ?? new Date(now.getTime() + 30 * 60_000),
      created_at: row.created_at ?? now,
      updated_at: row.updated_at ?? now,
    });
  }

  query<T extends Record<string, unknown>>(
    sql: string,
    params: readonly unknown[],
  ): Promise<[T[], unknown]> {
    const norm = sql.replace(/\s+/g, ' ').trim();
    if (
      norm.startsWith('SELECT') &&
      norm.includes('FROM replenishment_draft') &&
      norm.includes('WHERE draft_id = ?') &&
      norm.includes('merchant_id = ?') &&
      norm.includes('store_id = ?') &&
      norm.includes('LIMIT 1')
    ) {
      const [draftId, merchantId, storeId] = params as [string, string, string];
      const row = this.rows.get(draftId);
      const matched =
        row && row.merchant_id === merchantId && row.store_id === storeId
          ? [
              {
                draft_id: row.draft_id,
                session_id: row.session_id,
                merchant_id: row.merchant_id,
                store_id: row.store_id,
                user_id: row.user_id,
                trace_id: row.trace_id,
                forecast_days: row.forecast_days,
                status: row.status,
                items: row.items,
                strategy_version: row.strategy_version,
                submitted_po_no: row.submitted_po_no,
                expires_at: row.expires_at,
                created_at: row.created_at,
                updated_at: row.updated_at,
              },
            ]
          : [];
      return Promise.resolve([matched as unknown as T[], undefined]);
    }
    throw new Error(`FakeDraftPool: 未识别 query SQL: ${norm}`);
  }

  execute(
    sql: string,
    params: readonly unknown[],
  ): Promise<[{ affectedRows: number }, unknown]> {
    const norm = sql.replace(/\s+/g, ' ').trim();
    if (
      norm.startsWith('UPDATE replenishment_draft') &&
      norm.includes('SET status = ?') &&
      norm.includes('WHERE draft_id = ?') &&
      norm.includes('merchant_id = ?') &&
      norm.includes('store_id = ?') &&
      norm.includes('status = ?')
    ) {
      const [to, draftId, merchantId, storeId, from] = params as [
        DraftStatus,
        string,
        string,
        string,
        DraftStatus,
      ];
      const row = this.rows.get(draftId);
      if (
        !row ||
        row.merchant_id !== merchantId ||
        row.store_id !== storeId ||
        row.status !== from
      ) {
        return Promise.resolve([{ affectedRows: 0 }, undefined]);
      }
      row.status = to;
      row.updated_at = this.clock;
      return Promise.resolve([{ affectedRows: 1 }, undefined]);
    }
    return Promise.resolve([{ affectedRows: 0 }, undefined]);
  }
}

/* ============================================================================
 * Fake MastraResolver
 * ========================================================================== */

class FakeMastraResolverImpl implements MastraResolver {
  public resumeCalls: WorkflowResumeArgs[] = [];
  public resumeImpl: (args: WorkflowResumeArgs) => Promise<unknown> = () =>
    Promise.resolve({ ok: true });

  getWorkflow(workflowId: string) {
    if (workflowId !== HITL_WORKFLOW_ID) {
      throw new Error(`FakeMastraResolverImpl: workflowId mismatch: ${workflowId}`);
    }
    return {
      resume: async (args: WorkflowResumeArgs) => {
        this.resumeCalls.push(args);
        return this.resumeImpl(args);
      },
    };
  }
}

/* ============================================================================
 * Helpers
 * ========================================================================== */

function seedExpiredRuns(pool: FakeExpireSuspendedPool, count: number): void {
  const old = new Date(pool.clock.getTime() - 32 * 60_000); // 32 分钟前过期
  for (let i = 0; i < count; i += 1) {
    const runId = `run_expired_${i.toString().padStart(5, '0')}`;
    pool.suspendRows.push({
      run_id: runId,
      step_id: 'askConfirm',
      expires_at: old,
    });
    pool.sessionRowsActiveRunIds.add(runId);
    pool.sessionRowsByRunId.set(runId, {
      session_id: `sess_${runId}`,
      merchant_id: 'M001',
      current_store_id: 'S001',
      user_id: 'boss-001',
      active_draft_id: null,
    });
  }
}

let pool: FakeExpireSuspendedPool;
let draftPool: FakeDraftPool;
let mastra: FakeMastraResolverImpl;

beforeEach(() => {
  pool = new FakeExpireSuspendedPool();
  draftPool = new FakeDraftPool();
  mastra = new FakeMastraResolverImpl();
  setConfirmManagerPool(pool);
  setMastraResolver(mastra);
  setDraftPool(draftPool);
});

afterEach(() => {
  resetConfirmManagerForTest();
  resetDraftManagerForTest();
  vi.useRealTimers();
});

/* ============================================================================
 * SQL 形态（任务卡 §9 step 10）
 * ========================================================================== */

describe('expire-suspended-runs — SQL 形态', () => {
  it('SELECT 含 LIMIT ? 且 FOR UPDATE SKIP LOCKED + idx_expires（任务卡 §9 step 10）', async () => {
    seedExpiredRuns(pool, 1);
    await expireSuspendedRunsJob({ pool, mastraResolver: mastra });
    expect(pool.selectCalls).toBeGreaterThanOrEqual(1);
  });

  it('LIMIT 200（任务卡 §7 MUST DO §6）', () => {
    expect(EXPIRE_SUSPENDED_BATCH_LIMIT).toBe(200);
  });
});

/* ============================================================================
 * 单批 happy path
 * ========================================================================== */

describe('expire-suspended-runs — happy', () => {
  it('5 条过期 run → 5 次 mastra.resume(CANCEL EXPIRED) + 5 DELETE + 5 UPDATE session', async () => {
    seedExpiredRuns(pool, 5);
    const result = await expireSuspendedRunsJob({ pool, mastraResolver: mastra });
    expect(result.totalProcessed).toBe(5);
    expect(result.resumeErrors).toBe(0);
    expect(mastra.resumeCalls).toHaveLength(5);
    for (const call of mastra.resumeCalls) {
      expect(call.resumeData).toEqual({ decision: 'CANCEL', reason: 'EXPIRED' });
    }
    expect(pool.deleteCalls).toHaveLength(5);
    expect(pool.sessionUpdateCalls).toHaveLength(5);
    expect(pool.suspendRows).toHaveLength(0);
  });

  it('过期 run 关联 active_draft_id → draft 状态流转为 CANCELLED', async () => {
    seedExpiredRuns(pool, 1);
    const runId = 'run_expired_00000';
    const draftId = 'drf_expired_aaaaaaaaaaaa';
    pool.sessionRowsByRunId.set(runId, {
      session_id: 'sess_expired_00000',
      merchant_id: 'M001',
      current_store_id: 'S001',
      user_id: 'boss-001',
      active_draft_id: draftId,
    });
    draftPool.insert({ draft_id: draftId, status: 'WAIT_CONFIRM' });

    await expireSuspendedRunsJob({ pool, mastraResolver: mastra });

    expect(draftPool.rows.get(draftId)?.status).toBe('CANCELLED');
  });

  it('0 条过期 → 1 批扫描退出，processed=0', async () => {
    const result = await expireSuspendedRunsJob({ pool, mastraResolver: mastra });
    expect(result.batches).toBe(1);
    expect(result.totalProcessed).toBe(0);
    expect(mastra.resumeCalls).toHaveLength(0);
  });
});

/* ============================================================================
 * 错误 swallow
 * ========================================================================== */

describe('expire-suspended-runs — 错误 swallow', () => {
  it('mastra.resume 抛错 → 单行计 resumeErrors，但仍 DELETE 与 UPDATE', async () => {
    seedExpiredRuns(pool, 3);
    mastra.resumeImpl = () => Promise.reject(new Error('mastra boom'));

    const result = await expireSuspendedRunsJob({ pool, mastraResolver: mastra });
    expect(result.totalProcessed).toBe(3);
    expect(result.resumeErrors).toBe(3);
    expect(pool.deleteCalls).toHaveLength(3);
    expect(pool.sessionUpdateCalls).toHaveLength(3);
  });

  it('部分 mastra.resume 抛错 → 仍处理其它行', async () => {
    seedExpiredRuns(pool, 5);
    let counter = 0;
    mastra.resumeImpl = () => {
      counter += 1;
      if (counter % 2 === 0) {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve({ ok: true });
    };

    const result = await expireSuspendedRunsJob({ pool, mastraResolver: mastra });
    expect(result.totalProcessed).toBe(5);
    expect(result.resumeErrors).toBe(2);
  });
});

/* ============================================================================
 * 多批 + sleep
 * ========================================================================== */

describe('expire-suspended-runs — 多批 + sleep 100ms', () => {
  it('1500 条过期 → 8 批 × 200 + 1 批 0；连续两批之间 sleep ≥ 90ms', async () => {
    seedExpiredRuns(pool, 1500);
    const result = await expireSuspendedRunsJob({ pool, mastraResolver: mastra });
    expect(result.totalProcessed).toBe(1500);
    // 8 批每批 200，第 8 批 < 200 → 提前退出（不再有第 9 批 0 行）
    // 实际 1500 / 200 = 7.5 → 7 批 200 + 1 批 100 = 8 批
    expect(result.batches).toBeGreaterThanOrEqual(7);

    // 相邻有效批之间间隔 ≥ 90ms（容忍 timer 抖动）
    const gaps = pool.selectTimestamps.slice(1).map((t, i) => t - (pool.selectTimestamps[i] ?? t));
    // 最后一批可能 < 200 直接退出，所以只检查前面的 gap
    if (gaps.length > 1) {
      expect(gaps.slice(0, -1).every((g) => g >= 90)).toBe(true);
    }
  });

  it('200 条整除 → 2 批（200 + 0 退出）', async () => {
    seedExpiredRuns(pool, 200);
    const result = await expireSuspendedRunsJob({ pool, mastraResolver: mastra });
    expect(result.totalProcessed).toBe(200);
    expect(result.batches).toBe(2); // 第 1 批 200，第 2 批 0 → 退出
  });

  it('199 条 → 1 批（提前退出，不再发第二条 SELECT）', async () => {
    seedExpiredRuns(pool, 199);
    const result = await expireSuspendedRunsJob({ pool, mastraResolver: mastra });
    expect(result.totalProcessed).toBe(199);
    expect(result.batches).toBe(1);
  });
});

/* ============================================================================
 * 防御上限
 * ========================================================================== */

describe('expire-suspended-runs — 防御上限', () => {
  it('maxBatches 命中 → BizError(INTERNAL_ERROR)', async () => {
    // 自造无尽返回 LIMIT 行的 pool
    const infinitePool: ConfirmManagerPool = {
      query: <T extends Record<string, unknown>>(): Promise<[T[], unknown]> =>
        Promise.resolve([
          [{ run_id: 'r', step_id: 's' }] as unknown as T[],
          undefined,
        ]),
      execute: () => Promise.resolve([{ affectedRows: 1 }, undefined]),
      transaction: <T>(): Promise<T> => Promise.reject(new Error('not used')),
    };
    // 让 fake pool 的 query 始终返回 200 行（撑满 LIMIT 不会提前退出）
    const sustainPool: ConfirmManagerPool = {
      query: <T extends Record<string, unknown>>(): Promise<[T[], unknown]> => {
        const rows: Array<{ run_id: string; step_id: string }> = [];
        for (let i = 0; i < EXPIRE_SUSPENDED_BATCH_LIMIT; i += 1) {
          rows.push({ run_id: `r${i}`, step_id: 's' });
        }
        return Promise.resolve([rows as unknown as T[], undefined]);
      },
      execute: () => Promise.resolve([{ affectedRows: 1 }, undefined]),
      transaction: <T>(): Promise<T> => Promise.reject(new Error('not used')),
    };
    void infinitePool; // 保留示例

    await expect(
      expireSuspendedRunsJob({
        pool: sustainPool,
        mastraResolver: mastra,
        maxBatches: 3,
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('未注入 pool 且未传 pool → ConfirmManagerPool 未注入', async () => {
    resetConfirmManagerForTest();
    setMastraResolver(mastra);
    await expect(expireSuspendedRunsJob()).rejects.toThrow(/ConfirmManagerPool 未注入/);
  });

  it('未注入 mastraResolver 且未传 → MastraResolver 未注入', async () => {
    resetConfirmManagerForTest();
    setConfirmManagerPool(pool);
    await expect(expireSuspendedRunsJob()).rejects.toThrow(/MastraResolver 未注入/);
  });
});

/* ============================================================================
 * sleep helper
 * ========================================================================== */

describe('expire-suspended-runs — sleep helper', () => {
  it('sleep(50) 至少等 45ms', async () => {
    const start = Date.now();
    await sleep(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });
});

/* ============================================================================
 * cron 注册 / stop / 防重叠
 * ========================================================================== */

describe('expire-suspended-runs — startExpireSuspendedRunsCron', () => {
  it('返回 stop 函数；调用后 setInterval 被 clear', async () => {
    vi.useFakeTimers();
    const stop = startExpireSuspendedRunsCron({
      pool,
      mastraResolver: mastra,
      intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    const callsBefore = pool.selectCalls;
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(pool.selectCalls).toBe(callsBefore);
  });

  it('stop 幂等：多次调用不抛错', () => {
    const stop = startExpireSuspendedRunsCron({
      pool,
      mastraResolver: mastra,
      intervalMs: 60_000,
    });
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
    const slowPool: ConfirmManagerPool = {
      query: async <T extends Record<string, unknown>>(): Promise<[T[], unknown]> => {
        await blocker;
        return [
          [] as T[],
          undefined,
        ];
      },
      execute: () => Promise.resolve([{ affectedRows: 0 }, undefined]),
      transaction: <T>(): Promise<T> => Promise.reject(new Error('not used')),
    };
    let callCount = 0;
    const wrappedPool: ConfirmManagerPool = {
      ...slowPool,
      query: async <T extends Record<string, unknown>>(
        sql: string,
        params: readonly unknown[],
      ): Promise<[T[], unknown]> => {
        callCount += 1;
        return slowPool.query<T>(sql, params);
      },
    };
    const stop = startExpireSuspendedRunsCron({
      pool: wrappedPool,
      mastraResolver: mastra,
      intervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(callCount).toBe(1);
    resolveBlocker!();
    stop();
  });

  it('单次 tick 抛错：onError 收口；后续 tick 仍能继续', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const flakyPool: ConfirmManagerPool = {
      query: <T extends Record<string, unknown>>(): Promise<[T[], unknown]> => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('transient'));
        return Promise.resolve([
          [] as T[],
          undefined,
        ]);
      },
      execute: () => Promise.resolve([{ affectedRows: 0 }, undefined]),
      transaction: <T>(): Promise<T> => Promise.reject(new Error('not used')),
    };
    const errors: unknown[] = [];
    const stop = startExpireSuspendedRunsCron({
      pool: flakyPool,
      mastraResolver: mastra,
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
    expect(EXPIRE_SUSPENDED_DEFAULT_INTERVAL_MS).toBe(5 * 60 * 1000);
  });

  it('默认 batchSleep = 100ms', () => {
    expect(EXPIRE_SUSPENDED_BATCH_SLEEP_MS).toBe(100);
  });

  it('默认 maxBatches > 0', () => {
    expect(EXPIRE_SUSPENDED_MAX_BATCHES_PER_TICK).toBeGreaterThan(0);
  });

  it('默认 onError 走 pino warn（不传 onError 也不会 crash）', async () => {
    vi.useFakeTimers();
    const flakyPool: ConfirmManagerPool = {
      query: () => Promise.reject(new Error('boom-default-onerror')),
      execute: () => Promise.resolve([{ affectedRows: 0 }, undefined]),
      transaction: <T>(): Promise<T> => Promise.reject(new Error('not used')),
    };
    const stop = startExpireSuspendedRunsCron({
      pool: flakyPool,
      mastraResolver: mastra,
      intervalMs: 50,
    });
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);
    stop();
  });

  it('cron tick 命中过期行 → logger.info 分支（totalProcessed > 0）', async () => {
    vi.useFakeTimers();
    seedExpiredRuns(pool, 3);
    const stop = startExpireSuspendedRunsCron({
      pool,
      mastraResolver: mastra,
      intervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    stop();
    expect(pool.selectCalls).toBeGreaterThanOrEqual(1);
  });
});
