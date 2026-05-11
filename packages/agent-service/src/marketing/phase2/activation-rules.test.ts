import { describe, expect, it } from 'vitest';

import {
  buildActivationItems,
  buildActivationMarkdown,
  estimateActivationOpportunity,
} from './activation-rules.js';

const segments = [
  {
    memberId: 'MBR_00135',
    nameMasked: '李女士',
    phoneMasked: '139****0135',
    level: 'GOLD',
    lastVisitAt: '2026-04-01',
    totalSpent: 2380,
    totalOrders: 14,
    avgOrderValue: 170,
    segmentCode: 'COUPON_EXPIRING',
    matchReason: '有券 5 天后过期',
    score: 8.6,
  },
  {
    memberId: 'MBR_00123',
    nameMasked: '王女士',
    phoneMasked: '138****1234',
    level: 'VIP',
    lastVisitAt: '2026-03-10',
    totalSpent: 4856.5,
    totalOrders: 23,
    avgOrderValue: 211.15,
    segmentCode: 'DORMANT_WITH_STORAGE',
    matchReason: '仍有储值余额 380 元且 45 天以上未到店',
    score: 8.8,
  },
  {
    memberId: 'MBR_00151',
    nameMasked: '赵女士',
    phoneMasked: '136****0151',
    level: 'SILVER',
    lastVisitAt: '2026-03-20',
    totalSpent: 1380,
    totalOrders: 9,
    avgOrderValue: 153.33,
    segmentCode: 'DORMANT_WITH_STORAGE',
    matchReason: '仍有储值余额 220 元且 45 天以上未到店',
    score: 8.5,
  },
] as const;

const profilesByMember = {
  MBR_00135: {
    points: { points: 680, pointsExpiringIn30d: 80 },
    storageBalance: { balance: 0, totalRecharged: 0, totalConsumed: 0 },
    couponSummary: { unusedCount: 3, expiringIn7dCount: 1 },
  },
  MBR_00123: {
    points: { points: 1250, pointsExpiringIn30d: 200 },
    storageBalance: { balance: 380, totalRecharged: 1000, totalConsumed: 620 },
    couponSummary: { unusedCount: 1, expiringIn7dCount: 0 },
  },
  MBR_00151: {
    points: { points: 310, pointsExpiringIn30d: 30 },
    storageBalance: { balance: 220, totalRecharged: 500, totalConsumed: 280 },
    couponSummary: { unusedCount: 0, expiringIn7dCount: 0 },
  },
} as const;

const coupons = [
  {
    couponId: 'CPN_00135_001',
    memberId: 'MBR_00135',
    memberNameMasked: '李女士',
    couponType: 'CASH',
    amount: 30,
    threshold: 199,
    validFrom: '2026-05-01',
    validTo: '2026-05-15',
    daysToExpire: 5,
    status: 'UNUSED',
  },
  {
    couponId: 'CPN_00135_002',
    memberId: 'MBR_00135',
    memberNameMasked: '李女士',
    couponType: 'DISCOUNT',
    discount: 0.88,
    threshold: 299,
    validFrom: '2026-04-20',
    validTo: '2026-05-30',
    daysToExpire: 20,
    status: 'UNUSED',
  },
  {
    couponId: 'CPN_00123_001',
    memberId: 'MBR_00123',
    memberNameMasked: '王女士',
    couponType: 'GIFT',
    threshold: 399,
    validFrom: '2026-05-01',
    validTo: '2026-05-20',
    daysToExpire: 10,
    status: 'UNUSED',
  },
] as const;

describe('US-007 activation rules', () => {
  it('estimates only from storage balance, coupon threshold, or avg order value and marks the source', () => {
    expect(
      estimateActivationOpportunity({
        activationType: 'STORAGE_BALANCE',
        storageBalance: 380,
        avgOrderValue: 211.15,
      }),
    ).toEqual({
      amount: 211.15,
      source: '预估消费机会 = min(储值余额 380 元, 历史客单价 211.15 元)',
    });

    expect(
      estimateActivationOpportunity({
        activationType: 'COUPON_EXPIRING',
        couponThreshold: 199,
        avgOrderValue: 170,
      }),
    ).toEqual({
      amount: 199,
      source: '预估消费机会 = 券门槛 199 元',
    });

    expect(
      estimateActivationOpportunity({
        activationType: 'POINTS_EXPIRING',
        pointsExpiringIn30d: 80,
        avgOrderValue: 170,
      }),
    ).toEqual({
      amount: null,
      source: '积分即将过期 80 分；不估金额',
    });
  });

  it('separates coupon, storage, and points activation signals without mixing reasons', () => {
    const items = buildActivationItems({
      segments,
      profilesByMember,
      coupons,
    });

    expect(items.map((item) => `${item.activationType}:${item.memberId}`)).toEqual([
      'COUPON_EXPIRING:MBR_00135',
      'STORAGE_BALANCE:MBR_00123',
      'STORAGE_BALANCE:MBR_00151',
      'POINTS_EXPIRING:MBR_00123',
      'POINTS_EXPIRING:MBR_00135',
      'POINTS_EXPIRING:MBR_00151',
    ]);
    expect(items[0]).toMatchObject({
      memberId: 'MBR_00135',
      basis: '券 CPN_00135_001 5 天后到期；门槛 199 元；面额 30 元',
      estimatedOpportunityText: '预估 199 元',
      estimatedOpportunitySource: '预估消费机会 = 券门槛 199 元',
    });
    expect(items.find((item) => item.memberId === 'MBR_00123' && item.activationType === 'STORAGE_BALANCE')).toMatchObject({
      basis: '储值余额 380 元；45 天以上未到店',
      estimatedOpportunityText: '预估 211.15 元',
    });
    expect(items.find((item) => item.memberId === 'MBR_00123' && item.activationType === 'POINTS_EXPIRING')).toMatchObject({
      basis: '30 天内将过期积分 200 分',
      estimatedOpportunityText: '不估金额',
    });
    expect(items.find((item) => item.memberId === 'MBR_00135' && item.activationType === 'POINTS_EXPIRING')).toMatchObject({
      basis: '30 天内将过期积分 80 分',
      estimatedOpportunityText: '不估金额',
    });
  });

  it('builds safe grouped markdown and never claims write actions were executed', () => {
    const markdown = buildActivationMarkdown({
      segments,
      profilesByMember,
      coupons,
    });
    const deducted = `已${'扣'}`;
    const issued = `已${'发'}`;
    const broadcasted = `已经${'群发'}`;

    expect(markdown).toContain('## 券快过期');
    expect(markdown).toContain('## 储值未消费');
    expect(markdown).toContain('## 积分即将过期');
    expect(markdown).toContain('预估 199 元');
    expect(markdown).toContain('预估消费机会 = 券门槛 199 元');
    expect(markdown).toContain('member_wakeup_list_card');
    expect(markdown).not.toContain(deducted);
    expect(markdown).not.toContain(issued);
    expect(markdown).not.toContain(broadcasted);
    expect(markdown).not.toMatch(/(?<![*\d])1[0-9]{10}(?![*\d])/);
    expect(markdown).not.toMatch(/tool_calls|function_call|traceId|merchantId|storeId|agent_run_id/i);
  });
});
