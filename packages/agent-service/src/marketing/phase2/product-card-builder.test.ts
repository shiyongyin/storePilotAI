import { describe, expect, it } from 'vitest';

import { buildProductRecommendCard, buildProductRecommendMarkdown } from './product-card-builder.js';

const candidates = [
  {
    skuId: 'SKU001',
    skuName: '轻跑鞋 SKU001',
    categoryCode: 'CAT_RUNNING',
    categoryName: '跑步鞋',
    grossMarginRate: 0.46,
    inventoryStatus: 'IN_STOCK',
    availableQty: 62,
    stockAgeDays: 18,
    slowMoving: false,
    nearExpiry: false,
    fitSegments: ['LOYAL_FREQUENT', 'HIGH_VALUE'],
    suggestedMechanism: '老客专属搭配，不改价',
    marginRiskLevel: 'LOW',
    marginRiskFlag: false,
    complianceRiskFlag: false,
    brandRiskNote: '',
    recommendationReason: '毛利率 0.46，高于输入阈值；库存 62 件可售',
  },
  {
    skuId: 'SKU078',
    skuName: '春款休闲鞋 SKU078',
    categoryCode: 'CAT_CASUAL',
    categoryName: '休闲鞋',
    grossMarginRate: 0.22,
    inventoryStatus: 'NEAR_EXPIRY',
    availableQty: 41,
    stockAgeDays: 90,
    nearExpiryDays: 5,
    slowMoving: true,
    nearExpiry: true,
    fitSegments: ['PRICE_SENSITIVE'],
    suggestedMechanism: '清库存前先做合规检查，避免亏本清仓',
    marginRiskLevel: 'MEDIUM',
    marginRiskFlag: true,
    complianceRiskFlag: true,
    brandRiskNote: '临期商品过度清仓会影响品牌形象',
    recommendationReason: '库龄 90 天；临期 5 天；剩余 41 件',
  },
] as const;

describe('Phase 2 product recommend card builder', () => {
  it('builds only product_recommend_card with required product fields and risk extensions', () => {
    const card = buildProductRecommendCard({
      title: '商品推荐公共卡片测试',
      products: candidates,
    });

    expect(card.cardType).toBe('product_recommend_card');
    expect(card.products).toHaveLength(2);
    expect(card.products[0]).toEqual({
      skuId: 'SKU001',
      skuName: '轻跑鞋 SKU001',
      categoryCode: 'CAT_RUNNING',
      marginRate: 0.46,
      inventoryStatus: 'IN_STOCK',
      fitSegments: ['LOYAL_FREQUENT', 'HIGH_VALUE'],
      suggestedMechanism: '老客专属搭配，不改价',
      marginRiskFlag: false,
      marginRiskLevel: 'LOW',
      complianceRiskFlag: false,
      brandRiskNote: '',
    });
    expect(card.products[1]).toMatchObject({
      skuId: 'SKU078',
      marginRiskFlag: true,
      marginRiskLevel: 'MEDIUM',
      complianceRiskFlag: true,
      brandRiskNote: '临期商品过度清仓会影响品牌形象',
    });
  });

  it('rejects missing products and unsafe negative inventory before card_data is emitted', () => {
    expect(() => buildProductRecommendCard({ title: '空商品', products: [] })).toThrow(/at least one/i);
    expect(() =>
      buildProductRecommendCard({
        title: '异常库存',
        products: [{ ...candidates[0], availableQty: -1 }],
      }),
    ).toThrow(/invalid inventory/i);
  });

  it('builds owner-safe markdown with inventory, margin, and risk notes but no write-action claims', () => {
    const markdown = buildProductRecommendMarkdown({
      title: '商品推荐公共卡片测试',
      products: candidates,
    });
    const repriced = `已${'改价'}`;
    const cleared = `已经${'清仓'}`;

    expect(markdown).toContain('| 商品 | 库存状态 | 毛利率 | 适合人群 | 推荐机制 | 风险说明 |');
    expect(markdown).toContain('轻跑鞋 SKU001');
    expect(markdown).toContain('库存 62 件');
    expect(markdown).toContain('毛利率 0.46');
    expect(markdown).toContain('product_recommend_card');
    expect(markdown).not.toContain(repriced);
    expect(markdown).not.toContain(cleared);
    expect(markdown).not.toMatch(/tool_calls|function_call|traceId|merchantId|storeId|agent_run_id/i);
  });
});
