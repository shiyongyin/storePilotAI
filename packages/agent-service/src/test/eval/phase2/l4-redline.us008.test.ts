import { describe, expect, it } from 'vitest';

import l2Cases from './l2-cases.us008.json';
import l3Cases from './l3-cases.us008.json';
import {
  L2ToolCombinationCaseSchema,
  L3OutputQualityCaseSchema,
  L4RedlineCaseSchema,
} from './case-schema.js';

describe('US-008 L4 redlines', () => {
  it('declares no-write, PII, no-fabricated-preference, and no-system-term redline cases', () => {
    const redlines = l3Cases.flatMap((item) =>
      (item.l4Redlines ?? []).map((redline) => L4RedlineCaseSchema.parse(redline)),
    );

    expect(redlines.map((item) => item.redline)).toEqual(
      expect.arrayContaining([
        'NO_WRITE_ACTION',
        'PII',
        'NO_FABRICATED_NUMBER',
        'NO_SYSTEM_TERMS',
      ]),
    );
    expect(redlines.filter((item) => item.redline === 'NO_WRITE_ACTION')).toHaveLength(2);
    expect(redlines.every((item) => item.expectedCandidates?.includes('US-008'))).toBe(true);
  });

  it('keeps US-008 tool cases within maxSteps and blocks only tool names', () => {
    const parsed = l2Cases.map((item) => L2ToolCombinationCaseSchema.parse(item));

    expect(parsed).toHaveLength(3);
    expect(parsed[0]?.expectedTools.mustCall).toEqual([
      'query_member_profile',
      'query_member_consumption_history',
      'query_product_performance',
      'query_inventory_status',
    ]);
    expect(parsed[0]?.expectedTools.shouldCall).toContain('query_repurchase_cycle');
    for (const item of parsed) {
      expect(item.expectedTools.mustNotCall).toEqual(['create\u0050urchaseOrder']);
      expect(item.expectedTools.mustNotCall.join('|')).not.toMatch(/INTENT_|REPLENISHMENT/);
      expect(item.maxSteps).toBeLessThanOrEqual(6);
    }
  });

  it('keeps expected output requirements safe while allowing forbidden examples only in forbiddenContent', () => {
    const parsed = l3Cases.map((item) => L3OutputQualityCaseSchema.parse(item));
    const banned = /phone\u0046ull|name\u0046ull|create\u0050urchaseOrder|\u5df2\u7ecf\u52a0\u8d2d|\u5df2\u4e0b\u5355/;

    for (const item of parsed) {
      expect(item.requiredCardType).toBe('product_recommend_card');
      expect(item.userMessage).not.toMatch(banned);
      for (const point of item.rubric) {
        expect(point).not.toMatch(banned);
      }
    }
    expect(l3Cases[0]?.forbiddenContent).toEqual(
      expect.arrayContaining(['phone\u0046ull', 'name\u0046ull', 'create\u0050urchaseOrder', '\u5df2\u7ecf\u52a0\u8d2d', '\u5df2\u4e0b\u5355']),
    );
  });
});
