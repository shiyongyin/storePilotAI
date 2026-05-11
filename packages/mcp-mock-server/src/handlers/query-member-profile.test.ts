import { describe, expect, it } from 'vitest';

import { queryMemberProfileHandler } from './query-member-profile.js';

const context = {
  tenant: {
    merchantId: 'M001',
    storeId: 'S001',
  },
};

describe('query_member_profile handler', () => {
  it('returns traceable balance and points summaries without full PII', () => {
    const result = queryMemberProfileHandler({ memberId: 'MBR_00123' }, context) as {
      member: {
        memberId: string;
        nameMasked: string;
        phoneMasked?: string;
        avgOrderValue?: number;
      };
      points: { points: number; pointsExpiringIn30d: number };
      storageBalance: { balance: number; totalRecharged: number; totalConsumed: number };
      couponSummary: { unusedCount: number; expiringIn7dCount: number };
    };

    expect(result.member).toMatchObject({
      memberId: 'MBR_00123',
      nameMasked: '王女士',
      phoneMasked: '138****1234',
      avgOrderValue: 211.15,
    });
    expect(result.storageBalance).toMatchObject({
      balance: 380,
      totalRecharged: 1000,
      totalConsumed: 620,
    });
    expect(result.points).toMatchObject({
      points: 1250,
      pointsExpiringIn30d: 200,
    });
    expect(JSON.stringify(result)).not.toMatch(/phoneFull|nameFull|(?<![*\d])1[0-9]{10}(?![*\d])/);
  });

  it('returns coupon-sensitive member summary for activation without inventing coupon counts', () => {
    const result = queryMemberProfileHandler({ memberId: 'MBR_00135' }, context) as {
      points: { points: number; pointsExpiringIn30d: number };
      storageBalance: { balance: number };
      couponSummary: { unusedCount: number; expiringIn7dCount: number };
    };

    expect(result.storageBalance.balance).toBe(0);
    expect(result.points.pointsExpiringIn30d).toBe(80);
    expect(result.couponSummary).toEqual({ unusedCount: 3, expiringIn7dCount: 1 });
  });
});
