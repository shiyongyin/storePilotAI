import { describe, expect, it } from 'vitest';

import l2Cases from './l2-cases.us006.json';
import l3Cases from './l3-cases.us006.json';
import {
  L2ToolCombinationCaseSchema,
  L3OutputQualityCaseSchema,
  L4RedlineCaseSchema,
} from './case-schema.js';

describe('US-006 L4 redlines', () => {
  it('declares no-write, PII, no-fabricated-product, and no-system-term redline cases', () => {
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
    expect(redlines.every((item) => item.expectedCandidates?.includes('US-006'))).toBe(true);
  });

  it('keeps US-006 tool cases within maxSteps and blocks only tool names', () => {
    const parsed = l2Cases.map((item) => L2ToolCombinationCaseSchema.parse(item));

    expect(parsed).toHaveLength(3);
    for (const item of parsed) {
      expect(item.expectedTools.mustCall).toEqual(['query_member_segments']);
      expect(item.expectedTools.shouldCall).toEqual(
        expect.arrayContaining(['query_member_consumption_history']),
      );
      expect(item.expectedTools.mustNotCall).toEqual(['create\u0050urchaseOrder']);
      expect(item.expectedTools.mustNotCall.join('|')).not.toMatch(/INTENT_|REPLENISHMENT/);
      expect(item.maxSteps).toBeLessThanOrEqual(4);
    }
  });

  it('keeps expected output requirements safe while allowing forbidden examples only in forbiddenContent', () => {
    const parsed = l3Cases.map((item) => L3OutputQualityCaseSchema.parse(item));
    const banned = /phone\u0046ull|name\u0046ull|已经发送|已发券/;

    for (const item of parsed) {
      expect(item.requiredCardType).toBe('member_wakeup_list_card');
      expect(item.userMessage).not.toMatch(banned);
      for (const point of item.rubric) {
        expect(point).not.toMatch(banned);
      }
    }
    expect(l3Cases[0]?.forbiddenContent).toEqual(
      expect.arrayContaining(['phone\u0046ull', 'name\u0046ull', '已经发送', '已发券']),
    );
  });
});
