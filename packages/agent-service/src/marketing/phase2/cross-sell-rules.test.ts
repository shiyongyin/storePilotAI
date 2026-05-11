import { describe, expect, it } from 'vitest';

import {
  buildCrossSellMarkdown,
  buildCrossSellRecommendations,
} from './cross-sell-rules.js';

const memberProfile = {
  memberId: 'MBR_00123',
  nameMasked: '王女士',
  phoneMasked: '138****1234',
  level: 'VIP',
  avgOrderValue: 211.15,
  tags: ['high_value', 'family_buyer'],
} as const;

const history = {
  memberId: 'MBR_00123',
  orders: [
    {
      orderId: 'ORD_20260310_00123',
      orderDate: '2026-03-10',
      salesAmount: 399,
      itemCount: 1,
      skuIds: ['SKU001'],
    },
  ],
  frequentSkuIds: ['SKU001'],
  totalSalesAmount: 399,
  totalOrderCount: 1,
} as const;

const products = [
  {
    skuId: 'SKU001',
    skuName: '轻跑鞋 SKU001',
    categoryId: 'CAT_RUNNING',
    categoryName: '跑步鞋',
    salesQty: 86,
    salesAmount: 25680,
    grossMarginRate: 0.46,
    trend: 'UP',
    inventoryStatus: 'IN_STOCK',
  },
  {
    skuId: 'SKU021',
    skuName: '儿童运动鞋 SKU021',
    categoryId: 'CAT_KIDS',
    categoryName: '童鞋',
    salesQty: 48,
    salesAmount: 14352,
    grossMarginRate: 0.38,
    trend: 'FLAT',
    inventoryStatus: 'IN_STOCK',
  },
  {
    skuId: 'SKU078',
    skuName: '春款休闲鞋 SKU078',
    categoryId: 'CAT_CASUAL',
    categoryName: '休闲鞋',
    salesQty: 6,
    salesAmount: 1794,
    grossMarginRate: 0.22,
    trend: 'DOWN',
    inventoryStatus: 'NEAR_EXPIRY',
  },
  {
    skuId: 'SKU_OUT',
    skuName: '缺货测试款',
    categoryId: 'CAT_RUNNING',
    categoryName: '跑步鞋',
    salesQty: 10,
    salesAmount: 999,
    grossMarginRate: 0.5,
    trend: 'UP',
    inventoryStatus: 'OUT_OF_STOCK',
  },
] as const;

const inventoryBySku = {
  SKU001: {
    skuId: 'SKU001',
    skuName: '轻跑鞋 SKU001',
    availableQty: 62,
    stockAgeDays: 18,
    slowMovingFlag: false,
    status: 'IN_STOCK',
  },
  SKU021: {
    skuId: 'SKU021',
    skuName: '儿童运动鞋 SKU021',
    availableQty: 35,
    stockAgeDays: 22,
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

const repurchaseBySku = {
  SKU021: {
    skuId: 'SKU021',
    avgRepurchaseDays: 30,
    daysSinceLastPurchase: 28,
    confidence: 'MEDIUM',
    sampleSize: 5,
  },
} as const;

describe('US-008 cross-sell rules', () => {
  it('returns 1-3 fit-first recommendations and filters basket, OUT_OF_STOCK, and availableQuantity <= 0 cases', () => {
    const items = buildCrossSellRecommendations({
      memberProfile,
      history,
      basketSkuIds: ['SKU001'],
      products,
      inventoryBySku,
      repurchaseBySku,
    });

    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.length).toBeLessThanOrEqual(3);
    expect(items.map((item) => item.skuId)).toEqual(['SKU021']);
    expect(items.map((item) => item.skuId)).not.toContain('SKU001');
    expect(items.map((item) => item.skuId)).not.toContain('SKU078');
    expect(items.map((item) => item.skuId)).not.toContain('SKU_OUT');
    expect(items[0]).toMatchObject({
      skuId: 'SKU021',
      inventoryStatus: 'IN_STOCK',
      availableQty: 35,
      marginRiskLevel: 'LOW',
    });
    expect(items[0]?.recommendationReason).toContain('历史常购 SKU001');
    expect(items[0]?.recommendationReason).toContain('复购窗口接近');
    expect(items[0]?.staffScript.split(/[。！？]/).filter(Boolean).length).toBeLessThanOrEqual(2);
  });

  it('does not claim personal history when memberId is missing and only uses basket context', () => {
    const items = buildCrossSellRecommendations({
      basketSkuIds: ['SKU001'],
      products,
      inventoryBySku,
      repurchaseBySku,
    });

    expect(items.map((item) => item.skuId)).toEqual(['SKU021']);
    expect(items[0]?.recommendationReason).toContain('未识别到会员');
    expect(items[0]?.recommendationReason).toContain('基于当前购物篮');
    expect(items[0]?.recommendationReason).not.toContain('他常买');
    expect(items[0]?.recommendationReason).not.toContain('她常买');
  });

  it('builds safe product markdown with product_recommend_card, inventory, margin risk, and staff script', () => {
    const markdown = buildCrossSellMarkdown({
      memberProfile,
      history,
      basketSkuIds: ['SKU001'],
      products,
      inventoryBySku,
      repurchaseBySku,
    });
    const alreadyAdded = `已经${'加购'}`;
    const ordered = `已${'下单'}`;

    expect(markdown).toContain('## 到店搭配推荐');
    expect(markdown).toContain('| 推荐 SKU | 推荐理由 | 库存状态 | 毛利/风险 | 店员话术 |');
    expect(markdown).toContain('SKU021');
    expect(markdown).not.toContain('SKU001 |');
    expect(markdown).toContain('库存 35 件');
    expect(markdown).toContain('毛利风险 LOW');
    expect(markdown).toContain('店员可以说');
    expect(markdown).toContain('product_recommend_card');
    expect(markdown).not.toContain(alreadyAdded);
    expect(markdown).not.toContain(ordered);
    expect(markdown).not.toMatch(/(?<![*\d])1[0-9]{10}(?![*\d])/);
    expect(markdown).not.toMatch(/tool_calls|function_call|traceId|merchantId|storeId|agent_run_id/i);
  });
});
