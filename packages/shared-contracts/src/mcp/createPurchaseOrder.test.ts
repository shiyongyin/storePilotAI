/**
 * 切片 05 — createPurchaseOrder 单测
 * 关键断言:idempotencyKey === sourceDraftId(R-PO-002)refine 在 schema 层生效
 */
import { describe, expect, it } from 'vitest';

import { createPurchaseOrder, PurchaseOrderResult } from './createPurchaseOrder.js';

describe('createPurchaseOrder.input refine', () => {
  const baseInput = {
    merchantId: 'M001',
    storeId: 'S001',
    source: 'AI_REPLENISHMENT_AGENT' as const,
    sourceDraftId: 'drf_abc',
    idempotencyKey: 'drf_abc',
    items: [{ skuId: 'SKU001', quantity: 10, unit: '瓶', reason: '基线' }],
  };

  it('happy: idempotencyKey === sourceDraftId 通过', () => {
    expect(createPurchaseOrder.input.parse(baseInput)).toEqual(baseInput);
  });

  it('refine 拒绝 idempotencyKey !== sourceDraftId(R-PO-002)', () => {
    expect(() =>
      createPurchaseOrder.input.parse({
        ...baseInput,
        sourceDraftId: 'A',
        idempotencyKey: 'B',
      }),
    ).toThrow();
  });

  it('source 必须 AI_REPLENISHMENT_AGENT(literal 守门)', () => {
    expect(() =>
      createPurchaseOrder.input.parse({ ...baseInput, source: 'MANUAL' as never }),
    ).toThrow();
  });

  it('items 必须 ≥ 1', () => {
    expect(() => createPurchaseOrder.input.parse({ ...baseInput, items: [] })).toThrow();
  });

  it('items.max(2000)', () => {
    const items = Array.from({ length: 2001 }, (_, i) => ({
      skuId: `S${i}`,
      quantity: 1,
      unit: '瓶',
      reason: 'r',
    }));
    expect(() => createPurchaseOrder.input.parse({ ...baseInput, items })).toThrow();
  });

  it('quantity 必须非负整数', () => {
    expect(() =>
      createPurchaseOrder.input.parse({
        ...baseInput,
        items: [{ skuId: 'S', quantity: -1, unit: '瓶', reason: 'r' }],
      }),
    ).toThrow();
    expect(() =>
      createPurchaseOrder.input.parse({
        ...baseInput,
        items: [{ skuId: 'S', quantity: 0.5, unit: '瓶', reason: 'r' }],
      }),
    ).toThrow();
  });
});

describe('PurchaseOrderResult', () => {
  it('purchaseOrderNo 正则 ^PO[_-][A-Za-z0-9]{6,32}$', () => {
    // 合规:PO_ABC123 / PO-MOCK123456 / PO_MOCK1735812345abcdef
    expect(() =>
      PurchaseOrderResult.parse({
        success: true,
        purchaseOrderNo: 'PO_MOCK1735812345abcd',
        createdAt: '2026-01-01T00:00:00+08:00',
      }),
    ).not.toThrow();
    expect(() =>
      PurchaseOrderResult.parse({
        success: true,
        purchaseOrderNo: 'PO-ABCDEF',
        createdAt: '2026-01-01T00:00:00+08:00',
      }),
    ).not.toThrow();
    // 不合规:中间含下划线(分隔符只允许在 PO 后第一个位置)
    expect(() =>
      PurchaseOrderResult.parse({
        success: true,
        purchaseOrderNo: 'PO_MOCK_123456',
        createdAt: '2026-01-01T00:00:00+08:00',
      }),
    ).toThrow();
    // 不合规:小写前缀
    expect(() =>
      PurchaseOrderResult.parse({
        success: true,
        purchaseOrderNo: 'po_lowercase',
        createdAt: '2026-01-01T00:00:00+08:00',
      }),
    ).toThrow();
    // 不合规:后缀不足 6 字符
    expect(() =>
      PurchaseOrderResult.parse({
        success: true,
        purchaseOrderNo: 'PO_AB',
        createdAt: '2026-01-01T00:00:00+08:00',
      }),
    ).toThrow();
  });
});
