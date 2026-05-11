import { describe, expect, it } from 'vitest';

import { queryCouponInventoryHandler } from './query-coupon-inventory.js';

const context = {
  tenant: {
    merchantId: 'M001',
    storeId: 'S001',
  },
};

describe('query_coupon_inventory handler', () => {
  it('returns MBR_00135 unused coupon fixtures including one expiring in 5 days without PII', () => {
    const result = queryCouponInventoryHandler(
      {
        memberId: 'MBR_00135',
        status: 'UNUSED',
        limit: 20,
      },
      context,
    ) as {
      coupons: Array<{
        couponId: string;
        memberId?: string;
        memberNameMasked?: string;
        daysToExpire: number;
        status: string;
        threshold?: number;
        amount?: number;
      }>;
      summary: { totalUnused: number; expiringIn7d: number };
    };

    expect(result.coupons).toHaveLength(3);
    expect(result.coupons.map((coupon) => coupon.couponId)).toEqual([
      'CPN_00135_001',
      'CPN_00135_002',
      'CPN_00135_003',
    ]);
    expect(result.coupons[0]).toMatchObject({
      memberId: 'MBR_00135',
      memberNameMasked: '李女士',
      daysToExpire: 5,
      status: 'UNUSED',
      threshold: 199,
      amount: 30,
    });
    expect(result.summary).toMatchObject({ totalUnused: 3, expiringIn7d: 1 });
    expect(JSON.stringify(result)).not.toMatch(/phoneFull|nameFull|(?<![*\d])1[0-9]{10}(?![*\d])/);
  });

  it('filters expiring coupons by daysToExpire using tool fields only', () => {
    const result = queryCouponInventoryHandler(
      {
        status: 'UNUSED',
        expiringInDays: 7,
        limit: 20,
      },
      context,
    ) as { coupons: Array<{ couponId: string; daysToExpire: number; status: string }> };

    expect(result.coupons.map((coupon) => coupon.couponId)).toEqual(['CPN_00135_001']);
    expect(result.coupons.every((coupon) => coupon.status === 'UNUSED' && coupon.daysToExpire <= 7)).toBe(true);
  });
});
