/**
 * 切片 18 §8.6 — compensate-mark-submitted 补充覆盖率测试
 *
 * 目标：补齐 §8.5 cov-check 门禁里 `safety/` 分档的剩余分支：
 *   - parseItems：string → JSON.parse → 数组分支 / 非数组分支 / parse 抛错分支
 *   - startCompensateMarkSubmittedCron：默认 onError / stop 幂等 / 防重叠
 *
 * 严格遵守 §7 MUST NOT §1（不 mock DB），用 in-memory FakeDraftPool 隔离时间与状态。
 */
import type { DraftItem } from '@storepilot/shared-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resetDraftManagerForTest,
  setDraftPool,
  type DraftPool,
} from '../draft-manager.js';

import {
  __test_only__,
  startCompensateMarkSubmittedCron,
} from './compensate-mark-submitted.js';

const { parseItems } = __test_only__;
const { compensateOne } = __test_only__;

const SAMPLE_ITEM: DraftItem = {
  skuId: 'SKU001',
  skuName: '矿泉水',
  unit: '瓶',
  baseSuggestQty: 100,
  finalSuggestQty: 24,
  reason: 'r',
  adjustmentTrace: [],
};

describe('parseItems — 三分支兼容', () => {
  it('已 parse 的对象（mysql2 默认 JSON 列）→ 直接透传', () => {
    const raw: DraftItem[] = [SAMPLE_ITEM];
    expect(parseItems(raw)).toBe(raw);
  });

  it('字符串 + 合法数组 → JSON.parse 后返回', () => {
    const out = parseItems(JSON.stringify([SAMPLE_ITEM]));
    expect(Array.isArray(out)).toBe(true);
    expect(out[0]?.skuId).toBe('SKU001');
  });

  it('字符串 + 非数组（如 object）→ 兜底返回 []', () => {
    const out = parseItems('{"foo":"bar"}');
    expect(out).toEqual([]);
  });

  it('字符串 + 非法 JSON → catch 兜底返回 []', () => {
    const out = parseItems('this is not json');
    expect(out).toEqual([]);
  });
});

describe('compensateOne — tombstone / catch 边界', () => {
  it('user_id 为空时使用 compensate 兜底，仍按 draftId 幂等调 ERP', async () => {
    const calls: unknown[] = [];
    const tools = {
      createPurchaseOrder: {
        execute: (input: unknown) => {
          calls.push(input);
          return Promise.resolve({
            success: true as const,
            purchaseOrderNo: 'PO_compensate001',
            createdAt: '2026-05-08T00:00:00.000Z',
          });
        },
      },
    };
    const pool: DraftPool = {
      query: <T extends Record<string, unknown>>() =>
        Promise.resolve([
          [
            {
              draft_id: 'drf_compensate_user_fallback',
              session_id: 'sess_compensate',
              merchant_id: 'M-1',
              store_id: 'S-1',
              user_id: '',
              trace_id: 'tr',
              forecast_days: 7,
              status: 'CONFIRMED',
              items: [SAMPLE_ITEM],
              strategy_version: 'v1',
              submitted_po_no: null,
              expires_at: new Date(Date.now() + 60_000),
              created_at: new Date(),
              updated_at: new Date(),
            },
          ] as unknown as T[],
          undefined,
        ]),
      execute: () => Promise.resolve([{ affectedRows: 1 }, undefined]),
    };
    setDraftPool(pool);

    const ok = await compensateOne({
      row: {
        draft_id: 'drf_compensate_user_fallback',
        merchant_id: 'M-1',
        store_id: 'S-1',
        user_id: '',
        trace_id: 'tr',
        items: [SAMPLE_ITEM],
      },
      tools,
    });

    expect(ok).toBe(true);
    expect(calls[0]).toMatchObject({
      sourceDraftId: 'drf_compensate_user_fallback',
      idempotencyKey: 'drf_compensate_user_fallback',
    });
  });

  it('ERP 抛出非 Error 值时返回 false，下一轮重试', async () => {
    const ok = await compensateOne({
      row: {
        draft_id: 'drf_compensate_non_error',
        merchant_id: 'M-1',
        store_id: 'S-1',
        user_id: 'U-1',
        trace_id: 'tr',
        items: [SAMPLE_ITEM],
      },
      tools: {
        createPurchaseOrder: {
          execute: () => Promise.reject('erp-string-error'),
        },
      },
    });

    expect(ok).toBe(false);
  });
});

describe('startCompensateMarkSubmittedCron — 默认参数 / stop 幂等', () => {
  const noopPool: DraftPool = {
    query: () => Promise.resolve([[], undefined]),
    execute: () => Promise.resolve([{ affectedRows: 0 }, undefined]),
  };

  beforeEach(() => {
    setDraftPool(noopPool);
  });

  afterEach(() => {
    resetDraftManagerForTest();
    vi.useRealTimers();
  });

  it('未传 intervalMs / onError / maxBatchesPerTick → 走默认分支启动', () => {
    vi.useFakeTimers();
    const stop = startCompensateMarkSubmittedCron({});
    expect(typeof stop).toBe('function');
    stop();
  });

  it('stop 调用 2 次 → 幂等（第二次直接返回，不抛错）', () => {
    vi.useFakeTimers();
    const stop = startCompensateMarkSubmittedCron({ intervalMs: 1000 });
    stop();
    expect(() => stop()).not.toThrow();
  });

  it('防重叠：tick 进行中再次到时不堆积（query 慢于 interval 时只会有 1 个 in-flight）', async () => {
    vi.useFakeTimers();
    let inFlight = 0;
    let maxInFlight = 0;
    const slowPool: DraftPool = {
      query: () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise((resolve) => {
          setTimeout(() => {
            inFlight -= 1;
            resolve([[], undefined]);
          }, 500);
        });
      },
      execute: () => Promise.resolve([{ affectedRows: 0 }, undefined]),
    };
    const stop = startCompensateMarkSubmittedCron({ pool: slowPool, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(450);
    stop();
    await vi.advanceTimersByTimeAsync(600);
    expect(maxInFlight).toBeLessThanOrEqual(1);
  });
});
