import { describe, expect, it } from 'vitest';

import {
  buildSlowMovingMarkdown,
  buildSlowMovingRecommendations,
} from './slow-moving-rules.js';

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
    skuId: 'SKU060',
    skuName: '换季短靴 SKU060',
    categoryId: 'CAT_BOOTS',
    categoryName: '短靴',
    salesQty: 4,
    salesAmount: 1196,
    grossMarginRate: 0.36,
    trend: 'DOWN',
    inventoryStatus: 'SLOW_MOVING',
  },
  {
    skuId: 'SKU_EXPIRED',
    skuName: '不可售测试款',
    categoryId: 'CAT_CARE',
    categoryName: '护理品',
    salesQty: 1,
    salesAmount: 99,
    grossMarginRate: 0.28,
    trend: 'DOWN',
    inventoryStatus: 'NEAR_EXPIRY',
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
  SKU078: {
    skuId: 'SKU078',
    skuName: '春款休闲鞋 SKU078',
    availableQty: 41,
    stockAgeDays: 90,
    nearExpiryDays: 5,
    slowMovingFlag: true,
    status: 'NEAR_EXPIRY',
  },
  SKU060: {
    skuId: 'SKU060',
    skuName: '换季短靴 SKU060',
    availableQty: 24,
    stockAgeDays: 75,
    slowMovingFlag: true,
    status: 'SLOW_MOVING',
  },
  SKU_EXPIRED: {
    skuId: 'SKU_EXPIRED',
    skuName: '不可售测试款',
    availableQty: 12,
    stockAgeDays: 45,
    nearExpiryDays: 0,
    slowMovingFlag: false,
    status: 'NEAR_EXPIRY',
  },
} as const;

const campaigns = [
  {
    campaignId: 'CAMP_2026FEB',
    campaignName: '情人节搭配活动',
    grossMarginRate: 0.25,
    resultSummary: '销售有提升但毛利率下降 5pp',
  },
] as const;

describe('US-010 slow-moving and near-expiry rules', () => {
  it('identifies SKU078 and includes stock age, near-expiry days, remaining quantity, and risk triplet', () => {
    const items = buildSlowMovingRecommendations({
      products,
      inventoryBySku,
      campaigns,
      discountedMarginRateBySku: {
        SKU078: 0.12,
      },
      storeAvgMarginRate: 0.3,
    });
    const sku078 = items.find((item) => item.skuId === 'SKU078');

    expect(items.map((item) => item.skuId)).toContain('SKU078');
    expect(items.map((item) => item.skuId)).not.toContain('SKU001');
    expect(sku078).toMatchObject({
      skuId: 'SKU078',
      availableQty: 41,
      stockAgeDays: 90,
      nearExpiryDays: 5,
      slowMoving: true,
      nearExpiry: true,
      marginRiskLevel: 'HIGH',
      marginRiskFlag: true,
      complianceRiskFlag: true,
    });
    expect(sku078?.clearanceReason).toContain('库龄 90 天');
    expect(sku078?.clearanceReason).toContain('5 天临期');
    expect(sku078?.clearanceReason).toContain('剩余 41 件');
    expect(sku078?.salesSignalText).toContain('近 30 天销量 6 件');
    expect(sku078?.inventoryValueText).toContain('库存金额未返回');
    expect(sku078?.marginRiskText).toContain('毛利风险 HIGH');
    expect(sku078?.complianceRiskText).toContain('确认仍在可售期、符合门店/监管规则后再执行');
    expect(sku078?.brandRiskNote).toContain('过度清仓伤品牌形象');
    expect(sku078?.fitSegments).not.toContain('HIGH_VALUE');
  });

  it('routes expired or non-sellable inventory to removal-only action instead of a promotion mechanism', () => {
    const items = buildSlowMovingRecommendations({
      products,
      inventoryBySku,
      discountedMarginRateBySku: {
        SKU_EXPIRED: 0.2,
      },
    });
    const expired = items.find((item) => item.skuId === 'SKU_EXPIRED');

    expect(expired).toMatchObject({
      skuId: 'SKU_EXPIRED',
      actionType: 'REMOVE_ONLY',
      complianceRiskFlag: true,
      marginRiskFlag: false,
    });
    expect(expired?.suggestedMechanism).toContain('下架/报损/联系 ERP 流程');
    expect(expired?.suggestedMechanism).not.toContain('促销');
    expect(expired?.complianceRiskText).toContain('已不可售');
  });

  it('builds safe markdown and product_recommend_card with margin, compliance, and brand risks', () => {
    const markdown = buildSlowMovingMarkdown({
      products,
      inventoryBySku,
      campaigns,
      discountedMarginRateBySku: {
        SKU078: 0.12,
      },
      storeAvgMarginRate: 0.3,
    });
    const repriced = `已${'改价'}`;
    const cleared = `已经${'清仓'}`;
    const reckless = `全场 ${'1折'}甩卖`;
    const writeTool = `create${'Purchase'}Order`;
    const cardJson = markdown.match(/<!-- card_data:start -->(.*?)<!-- card_data:end -->/s)?.[1];
    const card = JSON.parse(cardJson ?? '{}') as {
      cardType: string;
      products: Array<{
        skuId: string;
        marginRiskFlag: boolean;
        marginRiskLevel: string;
        complianceRiskFlag: boolean;
        brandRiskNote: string;
      }>;
    };

    expect(markdown).toContain('## 滞销/临期库存处理建议');
    expect(markdown).toContain('库龄 90 天 / 5 天临期 / 剩余 41 件');
    expect(markdown).toContain('毛利风险 HIGH');
    expect(markdown).toContain('合规风险');
    expect(markdown).toContain('品牌风险');
    expect(markdown).toContain('product_recommend_card');
    expect(markdown).not.toContain(repriced);
    expect(markdown).not.toContain(cleared);
    expect(markdown).not.toContain(reckless);
    expect(markdown).not.toContain(writeTool);
    expect(markdown).not.toMatch(/(?<![*\d])1[0-9]{10}(?![*\d])/);
    expect(markdown).not.toMatch(/tool_calls|function_call|traceId|merchantId|storeId|agent_run_id/i);

    expect(card.cardType).toBe('product_recommend_card');
    expect(card.products.find((product) => product.skuId === 'SKU078')).toMatchObject({
      marginRiskFlag: true,
      marginRiskLevel: 'HIGH',
      complianceRiskFlag: true,
      brandRiskNote: '过度清仓伤品牌形象',
    });
  });
});
