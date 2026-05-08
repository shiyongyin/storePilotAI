/**
 * 切片 17 §9.5 — markSubmitted 失败补偿 Job 单测
 *
 * 覆盖（任务卡 §10 测试场景 5 / §9 5 步）：
 *   - SELECT 形态：submitted_po_no IS NULL AND status='CONFIRMED' AND created_at < NOW(3) - INTERVAL 30 SECOND LIMIT 100
 *   - happy path：1 条 pending → ERP 反查 + markSubmitted → 状态变 SUBMITTED + 写 PO 号
 *   - 多条：5 条 pending → 各自补偿；ERP 用相同 idempotencyKey === draftId
 *   - ERP 失败：单行抛错 → swallow + 下一行继续；totalFailed += 1
 *   - markSubmitted 失败：swallow；下一轮再扫
 *   - 30s grace：created_at = NOW - 10s 不被扫到（防 mid-flight 行）
 *   - 单批不足 LIMIT → 提前退出
 *   - cron 注册 / stop / 防重叠 / onError swallow
 */
import type { DraftItem } from '@storepilot/shared-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resetDraftManagerForTest,
  setDraftPool,
  type DraftPool,
} from '../draft-manager.js';

import {
  COMPENSATE_BATCH_LIMIT,
  COMPENSATE_DEFAULT_INTERVAL_MS,
  COMPENSATE_GRACE_SECONDS,
  COMPENSATE_MAX_BATCHES_PER_TICK,
  compensateMarkSubmittedJob,
  startCompensateMarkSubmittedCron,
} from './compensate-mark-submitted.js';

/* ============================================================================
 * Fake DraftPool —— 仅识别 compensate Job 的 SELECT + markSubmitted UPDATE
 * ========================================================================== */

interface FakeDraft {
  draft_id: string;
  merchant_id: string;
  store_id: string;
  user_id: string;
  trace_id: string;
  status: 'CONFIRMED' | 'SUBMITTED' | 'WAIT_CONFIRM' | 'DRAFT';
  items: DraftItem[];
  submitted_po_no: string | null;
  created_at: Date;
}

class FakeCompensatePool implements DraftPool {
  rows = new Map<string, FakeDraft>();
  clock = new Date('2026-05-07T01:00:00.000Z');
  selectCalls: Array<{ sql: string; params: readonly unknown[] }> = [];
  /** 注入 markSubmitted 失败 */
  markSubmittedShouldFail = false;

  query<T extends Record<string, unknown>>(
    sql: string,
    params: readonly unknown[],
  ): Promise<[T[], unknown]> {
    const norm = sql.replace(/\s+/g, ' ').trim();
    if (
      norm.includes('FROM replenishment_draft') &&
      norm.includes('submitted_po_no IS NULL') &&
      norm.includes(`status = 'CONFIRMED'`) &&
      norm.includes('created_at < NOW(3) - INTERVAL ? SECOND') &&
      norm.includes('LIMIT ?')
    ) {
      this.selectCalls.push({ sql, params });
      const [graceSeconds, limit] = params as [number, number];
      const cutoff = new Date(this.clock.getTime() - graceSeconds * 1000);
      const matched = [...this.rows.values()]
        .filter(
          (r) =>
            r.status === 'CONFIRMED' &&
            r.submitted_po_no === null &&
            r.created_at < cutoff,
        )
        .slice(0, limit);
      return Promise.resolve([
        matched.map((r) => ({
          draft_id: r.draft_id,
          merchant_id: r.merchant_id,
          store_id: r.store_id,
          user_id: r.user_id,
          trace_id: r.trace_id,
          items: r.items,
        })) as unknown as T[],
        undefined,
      ]);
    }
    // markSubmitted 内部 getByIdStrict 也走 query
    if (
      norm.startsWith('SELECT') &&
      norm.includes('FROM replenishment_draft') &&
      norm.includes('WHERE draft_id = ?')
    ) {
      const [draftId, merchantId, storeId] = params as [string, string, string];
      const row = this.rows.get(draftId);
      const matched =
        row && row.merchant_id === merchantId && row.store_id === storeId
          ? [
              {
                draft_id: row.draft_id,
                session_id: 'sess_x',
                merchant_id: row.merchant_id,
                store_id: row.store_id,
                user_id: row.user_id,
                trace_id: row.trace_id,
                forecast_days: 7,
                status: row.status,
                items: row.items,
                strategy_version: 'v1',
                submitted_po_no: row.submitted_po_no,
                expires_at: new Date(this.clock.getTime() + 30 * 60_000),
                created_at: row.created_at,
                updated_at: this.clock,
              },
            ]
          : [];
      return Promise.resolve([matched as unknown as T[], undefined]);
    }
    throw new Error(`FakeCompensatePool: 未识别 query SQL: ${norm}`);
  }

  execute(
    sql: string,
    params: readonly unknown[],
  ): Promise<[{ affectedRows: number }, unknown]> {
    const norm = sql.replace(/\s+/g, ' ').trim();
    if (
      norm.startsWith('UPDATE replenishment_draft') &&
      norm.includes(`SET status = 'SUBMITTED'`) &&
      norm.includes(`status = 'CONFIRMED'`)
    ) {
      if (this.markSubmittedShouldFail) {
        return Promise.reject(new Error('Fake DB error: markSubmitted UPDATE failed'));
      }
      const [poNo, draftId, merchantId, storeId] = params as [
        string,
        string,
        string,
        string,
      ];
      const row = this.rows.get(draftId);
      if (
        !row ||
        row.merchant_id !== merchantId ||
        row.store_id !== storeId ||
        row.status !== 'CONFIRMED'
      ) {
        return Promise.resolve([{ affectedRows: 0 }, undefined]);
      }
      row.status = 'SUBMITTED';
      row.submitted_po_no = poNo;
      return Promise.resolve([{ affectedRows: 1 }, undefined]);
    }
    throw new Error(`FakeCompensatePool: 未识别 execute SQL: ${norm}`);
  }
}

/* ============================================================================
 * Fake ERP createPurchaseOrder Tool（与 purchase-order-create.test.ts 同形）
 * ========================================================================== */

interface FakeCreatePoCall {
  // Mastra 1.0 ToolAction.execute(inputData) — inputData 直接展开。
  merchantId: string;
  storeId: string;
  source: 'AI_REPLENISHMENT_AGENT';
  sourceDraftId: string;
  idempotencyKey: string;
  items: Array<{ skuId: string; quantity: number; unit: string; reason: string }>;
}

class FakeTools {
  calls: FakeCreatePoCall[] = [];
  /** 注入第 N 次调用抛错（便于测试 ERP 失败 swallow） */
  failOnCall: number | null = null;
  poNoMap = new Map<string, string>();

  createPurchaseOrder = {
    execute: (args: FakeCreatePoCall) => {
      this.calls.push(args);
      if (this.failOnCall !== null && this.calls.length === this.failOnCall) {
        return Promise.reject(new Error('Fake ERP error'));
      }
      const key = args.idempotencyKey;
      if (this.poNoMap.has(key)) {
        return Promise.resolve({
          success: true as const,
          purchaseOrderNo: this.poNoMap.get(key)!,
          createdAt: '2026-05-07T01:00:00.000Z',
        });
      }
      const poNo = `PO_${key.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}`;
      this.poNoMap.set(key, poNo);
      return Promise.resolve({
        success: true as const,
        purchaseOrderNo: poNo,
        createdAt: '2026-05-07T01:00:00.000Z',
      });
    },
  };
}

/* ============================================================================
 * Helpers
 * ========================================================================== */

function makeItem(over: Partial<DraftItem> = {}): DraftItem {
  return {
    skuId: 'SKU001',
    skuName: '矿泉水',
    unit: '瓶',
    baseSuggestQty: 100,
    finalSuggestQty: 24,
    reason: 'r',
    adjustmentTrace: [],
    ...over,
  };
}

function seedPendingDraft(
  pool: FakeCompensatePool,
  over: Partial<FakeDraft> = {},
): FakeDraft {
  const id = over.draft_id ?? `drf_${Math.random().toString(16).slice(2, 18).padEnd(16, 'a')}`;
  const draft: FakeDraft = {
    draft_id: id,
    merchant_id: 'M-1',
    store_id: 'S-1',
    user_id: 'U-1',
    trace_id: 'tr',
    status: 'CONFIRMED',
    items: [makeItem({ skuId: 'SKU001', finalSuggestQty: 24 })],
    submitted_po_no: null,
    // 默认 1 分钟前创建（满足 30s grace）
    created_at: new Date(pool.clock.getTime() - 60 * 1000),
    ...over,
  };
  pool.rows.set(draft.draft_id, draft);
  return draft;
}

let pool: FakeCompensatePool;
let tools: FakeTools;

beforeEach(() => {
  pool = new FakeCompensatePool();
  tools = new FakeTools();
  setDraftPool(pool);
});

afterEach(() => {
  resetDraftManagerForTest();
  vi.useRealTimers();
});

/* ============================================================================
 * SQL 形态 / 常量
 * ========================================================================== */

describe('切片 17 §9.5 — compensate-mark-submitted SQL 形态 / 常量', () => {
  it('LIMIT 100（任务卡 §8.3）', () => {
    expect(COMPENSATE_BATCH_LIMIT).toBe(100);
  });

  it('30 秒 grace（任务卡 §8.3）', () => {
    expect(COMPENSATE_GRACE_SECONDS).toBe(30);
  });

  it('1 分钟 cron 间隔（任务卡 §6 / §8.3）', () => {
    expect(COMPENSATE_DEFAULT_INTERVAL_MS).toBe(60 * 1000);
  });

  it('SELECT 形态包含 submitted_po_no IS NULL + status=CONFIRMED + INTERVAL ? SECOND', async () => {
    seedPendingDraft(pool);
    await compensateMarkSubmittedJob({ pool, tools });
    expect(pool.selectCalls.length).toBeGreaterThan(0);
    const sql = pool.selectCalls[0]!.sql;
    expect(sql).toContain('submitted_po_no IS NULL');
    expect(sql).toContain(`status = 'CONFIRMED'`);
    expect(sql).toContain('created_at < NOW(3) - INTERVAL ? SECOND');
    expect(sql).toContain('LIMIT ?');
  });
});

/* ============================================================================
 * happy path
 * ========================================================================== */

describe('切片 17 §9.5 — compensate happy', () => {
  it('1 条 pending → ERP 反查 + markSubmitted → status=SUBMITTED + 写 PO 号', async () => {
    const draft = seedPendingDraft(pool);

    const result = await compensateMarkSubmittedJob({ pool, tools });

    expect(result.totalProcessed).toBe(1);
    expect(result.totalCompensated).toBe(1);
    expect(result.totalFailed).toBe(0);

    // ERP 调 1 次，idempotencyKey === draftId
    expect(tools.calls).toHaveLength(1);
    expect(tools.calls[0]!.idempotencyKey).toBe(draft.draft_id);
    expect(tools.calls[0]!.sourceDraftId).toBe(draft.draft_id);
    expect(tools.calls[0]!.source).toBe('AI_REPLENISHMENT_AGENT');

    // markSubmitted 后 status=SUBMITTED + 写 PO 号
    const persisted = pool.rows.get(draft.draft_id);
    expect(persisted?.status).toBe('SUBMITTED');
    expect(persisted?.submitted_po_no).toMatch(/^PO[_-]/);
  });

  it('5 条 pending → 5 次 ERP 调用 + 5 次补偿成功', async () => {
    for (let i = 0; i < 5; i++) {
      seedPendingDraft(pool, {
        draft_id: `drf_pending${'x'.repeat(15)}${i}`,
      });
    }

    const result = await compensateMarkSubmittedJob({ pool, tools });

    expect(result.totalProcessed).toBe(5);
    expect(result.totalCompensated).toBe(5);
    expect(result.totalFailed).toBe(0);
    expect(tools.calls).toHaveLength(5);

    // 全部 SUBMITTED
    for (const r of pool.rows.values()) {
      expect(r.status).toBe('SUBMITTED');
      expect(r.submitted_po_no).toMatch(/^PO[_-]/);
    }
  });

  it('items 来自 draftItems（R-PO-003：结构化）', async () => {
    seedPendingDraft(pool, {
      items: [
        makeItem({ skuId: 'A', finalSuggestQty: 10, unit: 'box', reason: 'r1' }),
        makeItem({ skuId: 'B', finalSuggestQty: 20, unit: 'pack', reason: 'r2' }),
      ],
    });
    await compensateMarkSubmittedJob({ pool, tools });
    expect(tools.calls[0]!.items).toEqual([
      { skuId: 'A', quantity: 10, unit: 'box', reason: 'r1' },
      { skuId: 'B', quantity: 20, unit: 'pack', reason: 'r2' },
    ]);
  });
});

/* ============================================================================
 * 30s grace
 * ========================================================================== */

describe('切片 17 §9.5 — 30s grace（防 mid-flight 行被反查）', () => {
  it('created_at = NOW - 10s（< 30s grace）→ 不被扫到', async () => {
    seedPendingDraft(pool, {
      created_at: new Date(pool.clock.getTime() - 10 * 1000), // 10s 前
    });
    const result = await compensateMarkSubmittedJob({ pool, tools });
    expect(result.totalProcessed).toBe(0);
    expect(tools.calls).toHaveLength(0);
  });

  it('created_at = NOW - 60s（> 30s grace）→ 被扫到', async () => {
    seedPendingDraft(pool, {
      created_at: new Date(pool.clock.getTime() - 60 * 1000),
    });
    const result = await compensateMarkSubmittedJob({ pool, tools });
    expect(result.totalProcessed).toBe(1);
  });
});

/* ============================================================================
 * 错误场景：ERP 失败 / markSubmitted 失败 → swallow + 下一行继续
 * ========================================================================== */

describe('切片 17 §9.5 — 单行失败 swallow', () => {
  it('ERP 第 1 次抛错 → swallow + 第 2 / 3 行成功；下一轮再试该行', async () => {
    seedPendingDraft(pool, { draft_id: `drf_a${'1'.repeat(23)}` });
    seedPendingDraft(pool, { draft_id: `drf_a${'2'.repeat(23)}` });
    seedPendingDraft(pool, { draft_id: `drf_a${'3'.repeat(23)}` });
    tools.failOnCall = 1; // 第 1 次调用抛错

    const result = await compensateMarkSubmittedJob({ pool, tools });

    expect(result.totalProcessed).toBe(3);
    expect(result.totalCompensated).toBe(2);
    expect(result.totalFailed).toBe(1);
    // ERP 仍调用 3 次（第 1 次抛错被 catch；后两次成功）
    expect(tools.calls).toHaveLength(3);

    // 失败行仍 CONFIRMED + submitted_po_no IS NULL（下一轮再试）
    const failedRow = pool.rows.get(`drf_a${'1'.repeat(23)}`);
    expect(failedRow?.status).toBe('CONFIRMED');
    expect(failedRow?.submitted_po_no).toBeNull();
  });

  it('markSubmitted 抛错 → swallow + 下一行继续；下一轮再试', async () => {
    seedPendingDraft(pool, { draft_id: `drf_b${'1'.repeat(23)}` });
    pool.markSubmittedShouldFail = true;

    const result = await compensateMarkSubmittedJob({ pool, tools });

    expect(result.totalFailed).toBe(1);
    expect(tools.calls).toHaveLength(1); // ERP 仍调用了一次

    // 行仍 CONFIRMED + submitted_po_no IS NULL（markSubmitted 失败被 swallow）
    const row = pool.rows.get(`drf_b${'1'.repeat(23)}`);
    expect(row?.status).toBe('CONFIRMED');
    expect(row?.submitted_po_no).toBeNull();
  });

  it('items 为空（异常 CONFIRMED 草稿）→ skip（不调 ERP）', async () => {
    seedPendingDraft(pool, { items: [] });

    const result = await compensateMarkSubmittedJob({ pool, tools });

    expect(result.totalProcessed).toBe(1);
    expect(result.totalFailed).toBe(1);
    expect(tools.calls).toHaveLength(0);
  });
});

/* ============================================================================
 * 提前退出 / 防御上限
 * ========================================================================== */

describe('切片 17 §9.5 — 单批不足 LIMIT → 提前退出', () => {
  it('1 条数据 → 仅 1 批扫描（< LIMIT 100 提前退出）', async () => {
    seedPendingDraft(pool);
    const result = await compensateMarkSubmittedJob({ pool, tools });
    expect(result.batches).toBe(1);
    expect(pool.selectCalls).toHaveLength(1);
  });

  it('0 条数据 → 1 批 0 行 → 直接返回', async () => {
    const result = await compensateMarkSubmittedJob({ pool, tools });
    expect(result.batches).toBe(1);
    expect(result.totalProcessed).toBe(0);
  });

  it('防御 maxBatchesPerTick 默认值', () => {
    expect(COMPENSATE_MAX_BATCHES_PER_TICK).toBeGreaterThanOrEqual(1);
  });
});

/* ============================================================================
 * cron 注册 / stop / 防重叠
 * ========================================================================== */

describe('切片 17 §9.5 — cron 注册', () => {
  it('startCompensateMarkSubmittedCron 返回 stop 函数；stop 后不再 tick', async () => {
    vi.useFakeTimers();
    const stop = startCompensateMarkSubmittedCron({
      pool,
      tools,
      intervalMs: 1000,
    });

    // 未到时间 → 0 次扫描
    expect(pool.selectCalls).toHaveLength(0);

    seedPendingDraft(pool);
    await vi.advanceTimersByTimeAsync(1100);
    // 至少 1 次（防重叠不会 > 2）
    const before = pool.selectCalls.length;
    expect(before).toBeGreaterThanOrEqual(1);

    stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(pool.selectCalls.length).toBe(before);
  });

  it('单次 tick 抛错 → onError 回调；不阻断后续 tick', async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];

    // 注入 pool.query 抛错
    const failingPool: DraftPool = {
      // eslint-disable-next-line @typescript-eslint/require-await
      query: async () => {
        throw new Error('boom');
      },
      execute: () => Promise.resolve([{ affectedRows: 0 }, undefined]),
    };

    const stop = startCompensateMarkSubmittedCron({
      pool: failingPool,
      tools,
      intervalMs: 100,
      onError: (err) => errors.push(err),
    });

    await vi.advanceTimersByTimeAsync(150);
    expect(errors.length).toBeGreaterThan(0);
    stop();
  });
});
