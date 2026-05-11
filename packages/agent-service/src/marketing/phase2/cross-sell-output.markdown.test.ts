import { describe, expect, it } from 'vitest';

import { buildCrossSellMarkdown } from './cross-sell-rules.js';

describe('US-008 cross-sell markdown snapshot', () => {
  it('renders fixture input memberId=MBR_00123 and basket=[SKU001] with 1-3 safe product recommendations', () => {
    const markdown = buildCrossSellMarkdown({
      memberProfile: {
        memberId: 'MBR_00123',
        nameMasked: '王女士',
        phoneMasked: '138****1234',
        level: 'VIP',
        avgOrderValue: 211.15,
        tags: ['family_buyer'],
      },
      history: {
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
      },
      basketSkuIds: ['SKU001'],
      products: [
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
      ],
      inventoryBySku: {
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
      },
      repurchaseBySku: {
        SKU021: {
          skuId: 'SKU021',
          avgRepurchaseDays: 30,
          daysSinceLastPurchase: 28,
          confidence: 'MEDIUM',
          sampleSize: 5,
        },
      },
    });
    const cardJson = markdown.match(/<!-- card_data:start -->(.*?)<!-- card_data:end -->/s)?.[1];
    const card = JSON.parse(cardJson ?? '{}') as {
      cardType: string;
      products: Array<{ skuId: string; inventoryStatus: string; marginRiskLevel: string }>;
    };

    expect(card.cardType).toBe('product_recommend_card');
    expect(card.products.length).toBeGreaterThanOrEqual(1);
    expect(card.products.length).toBeLessThanOrEqual(3);
    expect(card.products.map((product) => product.skuId)).not.toContain('SKU001');
    expect(card.products[0]).toMatchObject({
      skuId: 'SKU021',
      inventoryStatus: 'IN_STOCK',
      marginRiskLevel: 'LOW',
    });
    expect(markdown).toContain('库存 35 件');
    expect(markdown).toContain('毛利风险 LOW');
    expect(markdown).toContain('店员可以说');
  });
});
