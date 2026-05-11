import { describe, expect, it } from 'vitest';

import {
  buildNewCustomerSecondVisitItems,
  buildNewCustomerSecondVisitMarkdown,
  deriveNewCustomerStage,
} from './new-customer-rules.js';

const segments = [
  {
    memberId: 'MBR_00003',
    nameMasked: '林女士',
    phoneMasked: '136****0003',
    level: 'NEW',
    joinDate: '2026-05-07',
    lastVisitAt: '2026-05-07',
    totalSpent: 299,
    totalOrders: 1,
    segmentCode: 'NEW_FIRST_PURCHASE',
    matchReason: '新会员首次消费后 3 天内',
    score: 7.2,
  },
  {
    memberId: 'MBR_00007',
    nameMasked: '许先生',
    phoneMasked: '137****0007',
    level: 'NEW',
    joinDate: '2026-05-03',
    lastVisitAt: '2026-05-03',
    totalSpent: 258,
    totalOrders: 1,
    segmentCode: 'NEW_FIRST_PURCHASE',
    matchReason: '新会员首次消费后 7 天内',
    score: 7.1,
  },
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
    memberId: 'MBR_00031',
    nameMasked: '超窗会员',
    phoneMasked: '135****0031',
    level: 'NEW',
    joinDate: '2026-04-09',
    lastVisitAt: '2026-04-09',
    totalSpent: 199,
    totalOrders: 1,
    segmentCode: 'NEW_NEED_TWO_VISIT',
    matchReason: '新客首购后较久未到店',
    score: 5.5,
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
] as const;

const historiesByMember = {
  MBR_00003: {
    orders: [
      {
        orderId: 'ORD_20260507_00003',
        orderDate: '2026-05-07',
        salesAmount: 299,
        itemCount: 1,
        skuIds: ['SKU001'],
      },
    ],
    frequentSkuIds: ['SKU001'],
    totalSalesAmount: 299,
    totalOrderCount: 1,
  },
  MBR_00007: {
    orders: [
      {
        orderId: 'ORD_20260503_00007',
        orderDate: '2026-05-03',
        salesAmount: 258,
        itemCount: 1,
        skuIds: ['SKU078'],
      },
    ],
    frequentSkuIds: ['SKU078'],
    totalSalesAmount: 258,
    totalOrderCount: 1,
  },
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
  MBR_00031: {
    orders: [
      {
        orderId: 'ORD_20260409_00031',
        orderDate: '2026-04-09',
        salesAmount: 199,
        itemCount: 1,
        skuIds: ['SKU001'],
      },
    ],
    frequentSkuIds: ['SKU001'],
    totalSalesAmount: 199,
    totalOrderCount: 1,
  },
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
] as const;

describe('US-006 new-customer second-visit rules', () => {
  it('derives 0-3, 4-7, and 8-30 day windows from first purchase date', () => {
    expect(deriveNewCustomerStage({ daysSinceFirstPurchase: 3 })).toMatchObject({
      stageCode: 'THANK_YOU',
      title: '0-3 天感谢',
    });
    expect(deriveNewCustomerStage({ daysSinceFirstPurchase: 7 })).toMatchObject({
      stageCode: 'SECOND_VISIT',
      title: '4-7 天二次到店',
    });
    expect(deriveNewCustomerStage({ daysSinceFirstPurchase: 25 })).toMatchObject({
      stageCode: 'RECOVERY',
      title: '8-30 天转化挽回',
    });
    expect(deriveNewCustomerStage({ daysSinceFirstPurchase: 31 })).toBeNull();
  });

  it('keeps only created members with one confirmed first purchase and excludes walk-in tickets', () => {
    const items = buildNewCustomerSecondVisitItems({
      asOfDate: '2026-05-10',
      segments,
      historiesByMember,
      products,
    });

    expect(items.map((item) => item.memberId)).toEqual(['MBR_00003', 'MBR_00007', 'MBR_00142']);
    expect(items.map((item) => item.memberId)).not.toContain('MBR_00031');
    expect(JSON.stringify(items)).not.toContain('散客');
    expect(items.find((item) => item.memberId === 'MBR_00142')).toMatchObject({
      firstPurchaseProduct: '儿童运动鞋 SKU021',
      firstPurchaseCategory: '童鞋',
      daysSinceFirstPurchase: 25,
      daysWithoutSecondVisitText: '25 天未二次到店',
      stageCode: 'RECOVERY',
    });
  });

  it('does not invent a concrete product recommendation when product data is unavailable', () => {
    const items = buildNewCustomerSecondVisitItems({
      asOfDate: '2026-05-10',
      segments: [segments[2]],
      historiesByMember: { MBR_00142: historiesByMember.MBR_00142 },
      products: [],
    });

    expect(items[0]?.crossSellSuggestion).toBe('到店时根据首购品类做搭配，不编具体 SKU');
    expect(items[0]?.suggestedScript).toContain('上次选的商品');
  });

  it('builds safe markdown and member_wakeup_list_card data without direct execution wording', () => {
    const markdown = buildNewCustomerSecondVisitMarkdown({
      asOfDate: '2026-05-10',
      segments,
      historiesByMember,
      products,
    });
    const alreadySent = `已经${'发送'}`;
    const couponIssued = `已${'发券'}`;

    expect(markdown).toContain('## 新客二次到店转化');
    expect(markdown).toContain('0-3 天感谢');
    expect(markdown).toContain('4-7 天二次到店');
    expect(markdown).toContain('8-30 天转化挽回');
    expect(markdown).toContain('25 天未二次到店');
    expect(markdown).toContain('儿童运动鞋 SKU021');
    expect(markdown).toContain('member_wakeup_list_card');
    expect(markdown).not.toContain(alreadySent);
    expect(markdown).not.toContain(couponIssued);
    expect(markdown).not.toMatch(/(?<![*\d])1[0-9]{10}(?![*\d])/);
    expect(markdown).not.toMatch(/tool_calls|function_call|traceId|merchantId|storeId|agent_run_id/i);

    const cardJson = markdown.match(/<!-- card_data:start -->(.*?)<!-- card_data:end -->/s)?.[1];
    expect(cardJson).toBeDefined();
    const card = JSON.parse(cardJson ?? '{}') as {
      cardType: string;
      members: Array<{ reasonCode: string; priority: number; suggestedAction: string }>;
    };
    expect(card.cardType).toBe('member_wakeup_list_card');
    expect(card.members.map((member) => member.reasonCode)).toEqual([
      'NEW_FIRST_PURCHASE',
      'NEW_FIRST_PURCHASE',
      'NEW_NEED_TWO_VISIT',
    ]);
    expect(card.members.map((member) => member.priority)).toEqual([1, 2, 3]);
  });
});
