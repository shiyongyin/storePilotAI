import { describe, expect, it } from 'vitest';

import { queryMemberSegmentsHandler } from './query-member-segments.js';

const context = {
  tenant: {
    merchantId: 'M001',
    storeId: 'S001',
  },
};

describe('query_member_segments handler', () => {
  it('returns deterministic US-003 dormant member signals without PII', () => {
    const result = queryMemberSegmentsHandler(
      {
        segmentCodes: [
          'DORMANT_NORMAL',
          'DORMANT_HIGH_VALUE',
          'DORMANT_WITH_STORAGE',
          'DORMANT_WITH_COUPON',
          'COUPON_EXPIRING',
        ],
        limit: 20,
      },
      context,
    ) as {
      segments: Array<{
        memberId: string;
        segmentCode: string;
        nameMasked: string;
        phoneMasked?: string;
        matchReason: string;
      }>;
    };

    expect(result.segments.map((segment) => segment.segmentCode)).toEqual(
      expect.arrayContaining([
        'DORMANT_NORMAL',
        'DORMANT_HIGH_VALUE',
        'DORMANT_WITH_STORAGE',
        'DORMANT_WITH_COUPON',
        'COUPON_EXPIRING',
      ]),
    );
    expect(result.segments.some((segment) => segment.memberId === 'MBR_00123')).toBe(true);
    expect(result.segments.some((segment) => segment.memberId === 'MBR_00135')).toBe(true);
    expect(result.segments.some((segment) => segment.memberId === 'MBR_00150')).toBe(true);
    expect(result.segments.some((segment) => segment.memberId === 'MBR_00151')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/phoneFull|nameFull|1[0-9]{10}/);
  });

  it('keeps LOW_RESPONSIVE out unless explicitly requested', () => {
    const unfilteredResult = queryMemberSegmentsHandler(
      {
        limit: 20,
      },
      context,
    ) as { segments: Array<{ segmentCode: string }> };

    expect(unfilteredResult.segments.map((segment) => segment.segmentCode)).not.toContain(
      'LOW_RESPONSIVE',
    );

    const defaultResult = queryMemberSegmentsHandler(
      {
        segmentCodes: ['DORMANT_NORMAL'],
        limit: 20,
      },
      context,
    ) as { segments: Array<{ segmentCode: string }> };

    expect(defaultResult.segments.map((segment) => segment.segmentCode)).toEqual([
      'DORMANT_NORMAL',
    ]);

    const explicitResult = queryMemberSegmentsHandler(
      {
        segmentCodes: ['LOW_RESPONSIVE'],
        limit: 20,
      },
      context,
    ) as { segments: Array<{ segmentCode: string }> };

    expect(explicitResult.segments.map((segment) => segment.segmentCode)).toEqual([
      'LOW_RESPONSIVE',
    ]);
  });

  it('returns HIGH_VALUE and LOYAL_FREQUENT boundaries while keeping LOW_RESPONSIVE excluded by default', () => {
    const result = queryMemberSegmentsHandler(
      {
        segmentCodes: ['HIGH_VALUE', 'LOYAL_FREQUENT'],
        limit: 20,
      },
      context,
    ) as {
      segments: Array<{
        memberId: string;
        segmentCode: string;
        score?: number;
        nameMasked: string;
        phoneMasked?: string;
      }>;
    };

    expect(result.segments.map((segment) => segment.segmentCode)).toEqual(
      expect.arrayContaining(['HIGH_VALUE', 'LOYAL_FREQUENT']),
    );
    expect(result.segments.some((segment) => segment.memberId === 'MBR_00123')).toBe(true);
    expect(result.segments.some((segment) => segment.memberId === 'MBR_00135')).toBe(true);
    expect(result.segments.map((segment) => segment.memberId)).not.toContain('MBR_00152');
    expect(JSON.stringify(result)).not.toMatch(/phoneFull|nameFull|1[0-9]{10}/);
  });

  it('returns NEW_FIRST_PURCHASE and NEW_NEED_TWO_VISIT boundaries for US-006 without walk-in tickets', () => {
    const result = queryMemberSegmentsHandler(
      {
        segmentCodes: ['NEW_FIRST_PURCHASE', 'NEW_NEED_TWO_VISIT'],
        limit: 20,
      },
      context,
    ) as {
      segments: Array<{
        memberId: string;
        segmentCode: string;
        nameMasked: string;
        phoneMasked?: string;
        totalOrders: number;
        matchReason: string;
      }>;
    };

    expect(result.segments.map((segment) => segment.segmentCode)).toEqual(
      expect.arrayContaining(['NEW_FIRST_PURCHASE', 'NEW_NEED_TWO_VISIT']),
    );
    expect(result.segments.some((segment) => segment.memberId === 'MBR_00142')).toBe(true);
    expect(
      result.segments.find((segment) => segment.memberId === 'MBR_00142'),
    ).toMatchObject({
      segmentCode: 'NEW_NEED_TWO_VISIT',
      totalOrders: 1,
    });
    expect(result.segments.every((segment) => Boolean(segment.memberId))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/phoneFull|nameFull|1[0-9]{10}/);
  });
});
