import { describe, expect, it } from 'vitest';

import { buildSlowMovingMarkdown } from './slow-moving-rules.js';

describe('US-010 slow-moving markdown snapshot', () => {
  it('renders fixture SKU078 with stock-age, near-expiry, remaining quantity, and risk triplet', () => {
    const markdown = buildSlowMovingMarkdown({
      products: [
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
      ],
      inventoryBySku: {
        SKU078: {
          skuId: 'SKU078',
          skuName: '春款休闲鞋 SKU078',
          availableQty: 41,
          stockAgeDays: 90,
          nearExpiryDays: 5,
          slowMovingFlag: true,
          status: 'NEAR_EXPIRY',
        },
      },
      discountedMarginRateBySku: {
        SKU078: 0.12,
      },
      storeAvgMarginRate: 0.3,
    });
    const reckless = `全场 ${'1折'}甩卖`;
    const repriced = `已${'改价'}`;
    const cleared = `已经${'清仓'}`;

    expect(markdown).toContain('SKU078');
    expect(markdown).toContain('库龄 90 天 / 5 天临期 / 剩余 41 件');
    expect(markdown).toContain('毛利风险 HIGH');
    expect(markdown).toContain('确认仍在可售期、符合门店/监管规则后再执行');
    expect(markdown).toContain('过度清仓伤品牌形象');
    expect(markdown).not.toContain(reckless);
    expect(markdown).not.toContain(repriced);
    expect(markdown).not.toContain(cleared);
  });
});
