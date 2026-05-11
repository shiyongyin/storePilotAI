import { describe, expect, it } from 'vitest';

import { queryMemberSegmentsHandler } from './query-member-segments.js';
import { queryRepurchaseCycleHandler } from './query-repurchase-cycle.js';

const context = {
  tenant: {
    merchantId: 'M001',
    storeId: 'S001',
  },
};

describe('query_repurchase_cycle handler', () => {
  it('provides REPURCHASE_DUE segment fixtures for US-004 without mixing dormant-normal as the main result', () => {
    const result = queryMemberSegmentsHandler(
      {
        segmentCodes: ['REPURCHASE_DUE'],
        limit: 20,
      },
      context,
    ) as {
      segments: Array<{
        memberId: string;
        segmentCode: string;
        nameMasked: string;
        phoneMasked?: string;
      }>;
    };

    expect(result.segments.map((segment) => segment.segmentCode)).toEqual([
      'REPURCHASE_DUE',
      'REPURCHASE_DUE',
      'REPURCHASE_DUE',
    ]);
    expect(result.segments.map((segment) => segment.memberId)).toEqual(
      expect.arrayContaining(['MBR_00123', 'MBR_00135', 'MBR_00142']),
    );
    expect(result.segments.map((segment) => segment.memberId)).not.toContain('MBR_00150');
    expect(JSON.stringify(result)).not.toMatch(/phoneFull|nameFull|(?<![*\d])1[0-9]{10}(?![*\d])/);
  });

  it('returns a high-confidence overdue cycle with traceable derived overdue days', () => {
    const result = queryRepurchaseCycleHandler({ memberId: 'MBR_00123' }, context) as {
      memberId: string;
      avgRepurchaseDays: number;
      daysSinceLastPurchase: number;
      confidence: string;
      sampleSize: number;
    };

    expect(result).toMatchObject({
      memberId: 'MBR_00123',
      avgRepurchaseDays: 28,
      daysSinceLastPurchase: 61,
      confidence: 'HIGH',
    });
    expect(result.sampleSize).toBeGreaterThanOrEqual(5);
    expect(result.avgRepurchaseDays - result.daysSinceLastPurchase).toBe(-33);
  });

  it('returns a low-confidence small-sample boundary for new members close to repurchase window', () => {
    const result = queryRepurchaseCycleHandler({ memberId: 'MBR_00142' }, context) as {
      memberId: string;
      avgRepurchaseDays: number;
      daysSinceLastPurchase: number;
      confidence: string;
      sampleSize: number;
    };

    expect(result).toMatchObject({
      memberId: 'MBR_00142',
      avgRepurchaseDays: 30,
      daysSinceLastPurchase: 28,
      confidence: 'LOW',
      sampleSize: 1,
    });
    expect(result.daysSinceLastPurchase).toBeGreaterThanOrEqual(result.avgRepurchaseDays * 0.9);
  });
});
