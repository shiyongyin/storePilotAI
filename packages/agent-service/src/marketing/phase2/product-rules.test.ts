import { describe, expect, it } from 'vitest';

import {
  computeMarginRisk,
  isNearExpiry,
  isSellableInventory,
  isSlowMoving,
  selectProductRecommendationCandidates,
} from './product-rules.js';

const sku001 = {
  skuId: 'SKU001',
  skuName: '轻跑鞋 SKU001',
  categoryId: 'CAT_RUNNING',
  categoryName: '跑步鞋',
  salesQty: 86,
  salesAmount: 25680,
  grossMarginRate: 0.46,
  trend: 'UP',
  inventoryStatus: 'IN_STOCK',
} as const;

const sku078 = {
  skuId: 'SKU078',
  skuName: '春款休闲鞋 SKU078',
  categoryId: 'CAT_CASUAL',
  categoryName: '休闲鞋',
  salesQty: 6,
  salesAmount: 1794,
  grossMarginRate: 0.22,
  trend: 'DOWN',
  inventoryStatus: 'NEAR_EXPIRY',
} as const;

const inventoryBySku = {
  SKU001: {
    skuId: 'SKU001',
    skuName: '轻跑鞋 SKU001',
    availableQty: 62,
    stockAgeDays: 18,
    slowMovingFlag: false,
    status: 'IN_STOCK',
  },
  SKU078: {
    skuId: 'SKU078',
    skuName: '春款休闲鞋 SKU078',
    availableQty: 41,
    stockAgeDays: 90,
    nearExpiryDays: 5,
    slowMovingFlag: true,
    status: 'NEAR_EXPIRY',
  },
  SKU_OUT: {
    skuId: 'SKU_OUT',
    skuName: '缺货测试款',
    availableQty: 0,
    stockAgeDays: 12,
    slowMovingFlag: false,
    status: 'OUT_OF_STOCK',
  },
} as const;

describe('Phase 2 product public rules', () => {
  it('filters unsellable inventory and rejects abnormal negative inventory numbers', () => {
    expect(isSellableInventory(inventoryBySku.SKU001)).toBe(true);
    expect(isSellableInventory(inventoryBySku.SKU_OUT)).toBe(false);
    expect(isSellableInventory({ ...inventoryBySku.SKU001, status: 'OUT_OF_STOCK' })).toBe(false);
    expect(isSellableInventory({ ...inventoryBySku.SKU001, availableQty: 0 })).toBe(false);
    expect(() => isSellableInventory({ ...inventoryBySku.SKU001, availableQty: -1 })).toThrow(
      /invalid inventory/i,
    );
  });

  it('computes HIGH, MEDIUM, and LOW margin risk from R-MKT-RULE-005 boundaries', () => {
    expect(
      computeMarginRisk({
        originalMarginRate: 0.46,
        discountedMarginRate: -0.01,
        storeAvgMarginRate: 0.3,
      }),
    ).toBe('HIGH');
    expect(
      computeMarginRisk({
        originalMarginRate: 0.46,
        discountedMarginRate: 0.09,
        storeAvgMarginRate: 0.3,
      }),
    ).toBe('HIGH');
    expect(
      computeMarginRisk({
        originalMarginRate: 0.46,
        discountedMarginRate: 0.14,
        storeAvgMarginRate: 0.3,
      }),
    ).toBe('HIGH');
    expect(
      computeMarginRisk({
        originalMarginRate: 0.46,
        discountedMarginRate: 0.15,
        storeAvgMarginRate: 0.3,
      }),
    ).toBe('MEDIUM');
    expect(
      computeMarginRisk({
        originalMarginRate: 0.46,
        discountedMarginRate: 0.21,
        storeAvgMarginRate: 0.3,
      }),
    ).toBe('LOW');
  });

  it('detects slow-moving and near-expiry signals without recommending them in normal promotion mode', () => {
    expect(
      isSlowMoving({
        salesQty30d: 8,
        categoryAvgSalesQty30d: 30,
        stockAgeDays: 60,
      }),
    ).toBe(true);
    expect(
      isSlowMoving({
        salesQty30d: 9,
        categoryAvgSalesQty30d: 30,
        stockAgeDays: 60,
      }),
    ).toBe(false);
    expect(isSlowMoving({ slowMovingFlag: true, salesQty30d: 99, categoryAvgSalesQty30d: 30, stockAgeDays: 1 })).toBe(true);
    expect(isNearExpiry({ nearExpiryDays: 7, availableQty: 41 })).toBe(true);
    expect(isNearExpiry({ nearExpiryDays: 7, availableQty: 0 })).toBe(false);

    const normalCandidates = selectProductRecommendationCandidates({
      products: [sku001, sku078],
      inventoryBySku,
      mode: 'NORMAL_PROMOTION',
      minMarginRate: 0.35,
    });

    expect(normalCandidates.map((candidate) => candidate.skuId)).toEqual(['SKU001']);
    expect(normalCandidates[0]).toMatchObject({
      skuId: 'SKU001',
      grossMarginRate: 0.46,
      inventoryStatus: 'IN_STOCK',
      availableQty: 62,
    });

    const clearanceCandidates = selectProductRecommendationCandidates({
      products: [sku001, sku078],
      inventoryBySku,
      mode: 'CLEARANCE',
    });

    expect(clearanceCandidates.map((candidate) => candidate.skuId)).toContain('SKU078');
    expect(clearanceCandidates.find((candidate) => candidate.skuId === 'SKU078')).toMatchObject({
      slowMoving: true,
      nearExpiry: true,
      marginRiskLevel: 'LOW',
      complianceRiskFlag: true,
    });
  });
});
