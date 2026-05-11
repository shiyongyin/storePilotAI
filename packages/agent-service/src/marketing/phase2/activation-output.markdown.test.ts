import { describe, expect, it } from 'vitest';

import { buildActivationMarkdown } from './activation-rules.js';

describe('US-007 activation markdown snapshot', () => {
  it('renders coupon, storage, and points groups with traceable estimate wording', () => {
    const markdown = buildActivationMarkdown({
      segments: [
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
      ],
      profilesByMember: {
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
      },
      coupons: [
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
      ],
    });
    const deducted = `已${'扣'}`;
    const issued = `已${'发'}`;
    const broadcasted = `已经${'群发'}`;

    expect(markdown).toContain('## 券快过期');
    expect(markdown).toContain('## 储值未消费');
    expect(markdown).toContain('## 积分即将过期');
    expect(markdown).toMatch(/预估\s+\d+(\.\d+)?\s+元/);
    expect(markdown).toContain('预估消费机会 =');
    expect(markdown).not.toContain(deducted);
    expect(markdown).not.toContain(issued);
    expect(markdown).not.toContain(broadcasted);
    expect(markdown).not.toMatch(/(?<![*\d])1[0-9]{10}(?![*\d])/);
  });
});
