/**
 * 切片 04 — DraftStatus / DraftItem / ReplenishmentDraft / AdjustmentInstruction 单测
 * 行为断言:
 *   - DraftStatus.options.length === 7,且包含 EXPIRED
 *   - draftId 正则 ^drf_[a-z0-9]{16,32}$
 *   - AdjustmentTargetType 4 项 + AdjustmentOpType 6 项
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AdjustmentInstruction,
  AdjustmentOpType,
  AdjustmentTargetType,
  DraftItem,
  DraftStatus,
  ReplenishmentDraft,
} from './drafts.js';

describe('DraftStatus 7 状态', () => {
  it('options.length === 7 且包含 EXPIRED', () => {
    expect(DraftStatus.options).toHaveLength(7);
    expect(DraftStatus.options).toContain('EXPIRED');
  });

  it('与切片 03 表注释一致(7 状态完全相等)', () => {
    expect(new Set(DraftStatus.options)).toEqual(
      new Set([
        'DRAFT',
        'WAIT_CONFIRM',
        'CONFIRMED',
        'SUBMITTED',
        'EXPIRED',
        'CANCELLED',
        'FAILED',
      ]),
    );
  });

  it.each(DraftStatus.options)('parse %s 成功', (status) => {
    expect(DraftStatus.parse(status)).toBe(status);
  });

  it('拒绝小写值(状态枚举漂移)', () => {
    expect(() => DraftStatus.parse('draft')).toThrow();
  });
});

describe('DraftItem', () => {
  it('happy + adjustmentTrace 默认空数组', () => {
    const item = DraftItem.parse({
      skuId: 'SKU001',
      skuName: '可乐',
      unit: '瓶',
      baseSuggestQty: 10,
      finalSuggestQty: 12,
      reason: '基于上周销量',
    });
    expect(item.adjustmentTrace).toEqual([]);
  });

  it('finalSuggestQty 必须非负整数', () => {
    expect(() =>
      DraftItem.parse({
        skuId: 'X',
        skuName: 'x',
        unit: '瓶',
        baseSuggestQty: 1,
        finalSuggestQty: -1,
        reason: 'r',
      }),
    ).toThrow();
  });

  it('reason ≤ 200 字', () => {
    expect(() =>
      DraftItem.parse({
        skuId: 'X',
        skuName: 'x',
        unit: '瓶',
        baseSuggestQty: 1,
        finalSuggestQty: 1,
        reason: 'a'.repeat(201),
      }),
    ).toThrow();
  });
});

describe('ReplenishmentDraft', () => {
  const happy = {
    draftId: 'drf_abcdefghij1234567890',
    sessionId: 'sess_xxx',
    merchantId: 'M001',
    storeId: 'S001',
    userId: 'boss-001',
    traceId: 'trace_001',
    forecastDays: 7,
    status: 'DRAFT' as const,
    items: [],
    strategyVersion: 'v1.0.0',
    createdAt: '2026-01-01T00:00:00+08:00',
    expiresAt: '2026-01-01T00:30:00+08:00',
  };

  it('happy', () => {
    const draft = ReplenishmentDraft.parse(happy);
    expect(draft.submittedPoNo).toBeNull();
  });

  it('draftId 正则强约束(必须 drf_ 前缀 + 16-32 lowercase alnum)', () => {
    expect(() => ReplenishmentDraft.parse({ ...happy, draftId: 'order_123' })).toThrow();
    expect(() => ReplenishmentDraft.parse({ ...happy, draftId: 'drf_TOOSHORT' })).toThrow();
    expect(() =>
      ReplenishmentDraft.parse({ ...happy, draftId: 'drf_UPPERCASEXXXXXXXXXX' }),
    ).toThrow();
  });

  it('items.max(2000)', () => {
    const items = Array.from({ length: 2001 }, (_, i) => ({
      skuId: `S${i}`,
      skuName: 'x',
      unit: '瓶',
      baseSuggestQty: 1,
      finalSuggestQty: 1,
      reason: 'r',
    }));
    expect(() => ReplenishmentDraft.parse({ ...happy, items })).toThrow();
  });

  it('forecastDays 1..30', () => {
    expect(() => ReplenishmentDraft.parse({ ...happy, forecastDays: 0 })).toThrow();
    expect(() => ReplenishmentDraft.parse({ ...happy, forecastDays: 31 })).toThrow();
  });

  it('createdAt 必须 ISO offset datetime(无时区拒绝)', () => {
    expect(() =>
      ReplenishmentDraft.parse({ ...happy, createdAt: '2026-01-01T00:00:00' }),
    ).toThrow();
  });

  it('schema 演进兼容：extend 可选字段后旧 payload 仍能 parse', () => {
    const EvolvedReplenishmentDraft = ReplenishmentDraft.extend({
      operatorNote: z.string().max(100).optional(),
    });
    const draft = EvolvedReplenishmentDraft.parse(happy);
    expect(draft.draftId).toBe(happy.draftId);
    expect(draft.operatorNote).toBeUndefined();
  });
});

describe('AdjustmentTargetType / AdjustmentOpType', () => {
  it('AdjustmentTargetType 4 项', () => {
    expect(AdjustmentTargetType.options).toHaveLength(4);
    expect(new Set(AdjustmentTargetType.options)).toEqual(
      new Set(['SKU_ID', 'SKU_KEYWORD', 'CATEGORY_CODE', 'ALL']),
    );
  });

  it('AdjustmentOpType 6 项', () => {
    expect(AdjustmentOpType.options).toHaveLength(6);
    expect(new Set(AdjustmentOpType.options)).toEqual(
      new Set([
        'INCREASE_RATE',
        'DECREASE_RATE',
        'INCREASE_QTY',
        'DECREASE_QTY',
        'SET_QTY',
        'EXCLUDE',
      ]),
    );
  });
});

describe('AdjustmentInstruction', () => {
  const happy = {
    adjustmentId: 'adj_001',
    draftId: 'drf_abcdefghij1234567890',
    userMessage: '可乐增加 10%',
    targetType: 'SKU_ID' as const,
    targetValue: 'SKU001',
    adjustmentType: 'INCREASE_RATE' as const,
    adjustmentRate: 0.1,
    reason: '促销',
    createdAt: '2026-01-01T00:00:00+08:00',
  };

  it('happy + adjustmentRate 在 [-1, 5]', () => {
    expect(AdjustmentInstruction.parse(happy)).toBeDefined();
  });

  it('adjustmentRate 越界(-1.1)拒绝', () => {
    expect(() => AdjustmentInstruction.parse({ ...happy, adjustmentRate: -1.1 })).toThrow();
  });

  it('userMessage ≤ 500 字', () => {
    expect(() =>
      AdjustmentInstruction.parse({ ...happy, userMessage: 'x'.repeat(501) }),
    ).toThrow();
  });
});
