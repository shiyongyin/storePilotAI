import { describe, expect, it } from 'vitest';

import { buildNewCustomerSecondVisitMarkdown } from './new-customer-rules.js';

describe('US-006 new-customer markdown snapshot', () => {
  it('renders the three second-visit windows and keeps walk-in tickets out of the member list', () => {
    const markdown = buildNewCustomerSecondVisitMarkdown({
      asOfDate: '2026-05-10',
      segments: [
        {
          memberId: 'MBR_00142',
          nameMasked: '陈先生',
          phoneMasked: '137****0142',
          level: 'NEW',
          joinDate: '2026-04-15',
          lastVisitAt: '2026-04-15',
          totalSpent: 399,
          totalOrders: 1,
          segmentCode: 'NEW_NEED_TWO_VISIT',
          matchReason: '新客首购后超过 7 天未二次到店',
          score: 7.9,
        },
        {
          memberId: null,
          nameMasked: '散客',
          level: 'NEW',
          joinDate: '2026-05-09',
          totalSpent: 198,
          totalOrders: 1,
          segmentCode: 'NEW_FIRST_PURCHASE',
          matchReason: '未创建会员的散客小票',
          score: 1,
        },
      ],
      historiesByMember: {
        MBR_00142: {
          orders: [
            {
              orderId: 'ORD_20260415_00142',
              orderDate: '2026-04-15',
              salesAmount: 399,
              itemCount: 1,
              skuIds: ['SKU021'],
            },
          ],
          frequentSkuIds: ['SKU021'],
          totalSalesAmount: 399,
          totalOrderCount: 1,
        },
      },
      products: [
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
    });

    expect(markdown).toContain('0-3 天感谢');
    expect(markdown).toContain('4-7 天二次到店');
    expect(markdown).toContain('8-30 天转化挽回');
    expect(markdown).toContain('25 天未二次到店');
    expect(markdown).toContain('儿童运动鞋 SKU021');
    expect(markdown).not.toContain('散客');
    expect(markdown).not.toMatch(/(?<![*\d])1[0-9]{10}(?![*\d])/);
  });
});
