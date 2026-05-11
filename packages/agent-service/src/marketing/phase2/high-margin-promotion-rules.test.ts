import { describe, expect, it } from 'vitest';

import {
  buildHighMarginPromotionMarkdown,
  buildHighMarginPromotionRecommendations,
} from './high-margin-promotion-rules.js';

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
    skuId: 'SKU045',
    skuName: '通勤乐福鞋 SKU045',
    categoryId: 'CAT_COMMUTE',
    categoryName: '通勤鞋',
    salesQty: 62,
    salesAmount: 22320,
    grossMarginRate: 0.42,
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
    skuId: 'SKU033',
    skuName: '护理套装 SKU033',
    categoryId: 'CAT_CARE',
    categoryName: '护理品',
    salesQty: 39,
    salesAmount: 7020,
    grossMarginRate: 0.34,
    trend: 'UP',
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
  {
    skuId: 'SKU_REFUND',
    skuName: '退货偏高测试款',
    categoryId: 'CAT_RUNNING',
    categoryName: '跑步鞋',
    salesQty: 44,
    salesAmount: 13200,
    grossMarginRate: 0.49,
    trend: 'UP',
    inventoryStatus: 'IN_STOCK',
    refundRate: 0.16,
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
  SKU045: {
    skuId: 'SKU045',
    skuName: '通勤乐福鞋 SKU045',
    availableQty: 44,
    stockAgeDays: 24,
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
  SKU033: {
    skuId: 'SKU033',
    skuName: '护理套装 SKU033',
    availableQty: 28,
    stockAgeDays: 16,
    slowMovingFlag: false,
    status: 'LOW_STOCK',
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
  SKU_REFUND: {
    skuId: 'SKU_REFUND',
    skuName: '退货偏高测试款',
    availableQty: 55,
    stockAgeDays: 12,
    slowMovingFlag: false,
    status: 'IN_STOCK',
  },
} as const;

const segments = [
  {
    segmentCode: 'HIGH_VALUE',
    segmentName: '高价值熟客',
    matchReason: '累计消费和复购次数均处于高位',
    score: 9.4,
  },
  {
    segmentCode: 'LOYAL_FREQUENT',
    segmentName: '高频忠诚',
    matchReason: '近 12 月复购次数较高',
    score: 8.3,
  },
  {
    segmentCode: 'LOW_RESPONSIVE',
    segmentName: '活动低响应',
    matchReason: '历史活动响应偏低',
    score: 2.1,
  },
] as const;

const campaigns = [
  {
    campaignId: 'CAMP_2025NOV',
    campaignName: '双 11 老客回访',
    grossMarginRate: 0.41,
    resultSummary: '复购率提升 18%，毛利保持稳定',
  },
] as const;

describe('US-009 high-margin promotion rules', () => {
  it('returns Top 3-5 high-margin products and filters OUT_OF_STOCK, near-expiry, slow-moving, and high refundRate items', () => {
    const items = buildHighMarginPromotionRecommendations({
      products,
      inventoryBySku,
      segments,
      campaigns,
      minMarginRate: 0.3,
      storeAvgMarginRate: 0.3,
    });

    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.length).toBeLessThanOrEqual(5);
    expect(items.map((item) => item.skuId)).toEqual(['SKU001', 'SKU045', 'SKU021', 'SKU033']);
    expect(items.map((item) => item.skuId)).not.toContain('SKU078');
    expect(items.map((item) => item.skuId)).not.toContain('SKU_OUT');
    expect(items.map((item) => item.skuId)).not.toContain('SKU_REFUND');
    expect(items[0]).toMatchObject({
      skuId: 'SKU001',
      grossMarginRate: 0.46,
      availableQty: 62,
      marginRiskLevel: 'LOW',
      fitSegments: ['HIGH_VALUE', 'LOYAL_FREQUENT'],
    });
    expect(items[0]?.marginAdvantageText).toContain('毛利率 46%');
    expect(items[0]?.targetAudienceText).toContain('高价值熟客');
    expect(items[0]?.campaignReference).toContain('双 11 老客回访');
    expect(items[0]?.riskText).toContain('退货投诉信号未返回');
  });

  it('uses margin-risk computation when a discount mechanism is explicitly provided', () => {
    const items = buildHighMarginPromotionRecommendations({
      products: [products[0]],
      inventoryBySku,
      segments,
      storeAvgMarginRate: 0.3,
      includeDiscountMechanism: true,
      discountedMarginRateBySku: {
        SKU001: 0.12,
      },
    });

    expect(items).toHaveLength(1);
    expect(items[0]?.suggestedMechanism).toContain('第二件适度折扣');
    expect(items[0]?.mechanismRiskText).toContain('折后毛利率 12%');
    expect(items[0]?.mechanismRiskText).toContain('毛利风险 HIGH');
    expect(items[0]?.marginRiskLevel).toBe('HIGH');
  });

  it('builds owner-safe markdown with product_recommend_card, traceable margin percentages, audience, script, mechanism, and risk', () => {
    const markdown = buildHighMarginPromotionMarkdown({
      products,
      inventoryBySku,
      segments,
      campaigns,
      minMarginRate: 0.3,
      storeAvgMarginRate: 0.3,
    });
    const broadcasted = `已${'群发'}`;
    const listed = `已${'上架'}`;
    const repriced = `已${'改价'}`;
    const writeTool = `create${'Purchase'}Order`;
    const cardJson = markdown.match(/<!-- card_data:start -->(.*?)<!-- card_data:end -->/s)?.[1];
    const card = JSON.parse(cardJson ?? '{}') as {
      cardType: string;
      products: Array<{ skuId: string; marginRate: number; inventoryStatus: string; fitSegments: string[] }>;
    };

    expect(markdown).toContain('## 本周建议主推商品');
    expect(markdown).toContain('| 商品 | 毛利优势 | 库存 | 适合人群 | 建议机制 | 话术 | 风险 |');
    expect(markdown).toContain('SKU001');
    expect(markdown).toContain('毛利率 46%');
    expect(markdown).toContain('库存 62 件');
    expect(markdown).toContain('高价值熟客');
    expect(markdown).toContain('话术');
    expect(markdown).toContain('product_recommend_card');
    expect(markdown).not.toContain('SKU078');
    expect(markdown).not.toContain('SKU_OUT');
    expect(markdown).not.toContain('SKU_REFUND');
    expect(markdown).not.toContain(broadcasted);
    expect(markdown).not.toContain(listed);
    expect(markdown).not.toContain(repriced);
    expect(markdown).not.toContain(writeTool);
    expect(markdown).not.toMatch(/(?<![*\d])1[0-9]{10}(?![*\d])/);
    expect(markdown).not.toMatch(/tool_calls|function_call|traceId|merchantId|storeId|agent_run_id/i);

    expect(card.cardType).toBe('product_recommend_card');
    expect(card.products[0]).toMatchObject({
      skuId: 'SKU001',
      marginRate: 0.46,
      inventoryStatus: 'IN_STOCK',
      fitSegments: ['HIGH_VALUE', 'LOYAL_FREQUENT'],
    });
  });
});
