import { describe, expect, it } from 'vitest';

import { loadPhase2L2Cases, loadPhase2L3Cases } from './index.js';
import { L4RedlineCaseSchema } from './case-schema.js';

describe('Phase2 aggregate L4 redline gate', () => {
  it('covers every phase2 US with L2/L3 cases', () => {
    expect(loadPhase2L2Cases()).toHaveLength(24);
    expect(loadPhase2L3Cases()).toHaveLength(24);
  });

  it('covers no-fabricated-number, PII, no-write, system-term, V1-write, compliance, and low-price redlines', () => {
    const l3Cases = loadPhase2L3Cases();
    const redlines = l3Cases.flatMap((item) =>
      item.l4Redlines.map((redline) => L4RedlineCaseSchema.parse(redline)),
    );
    const redlineKinds = new Set(redlines.map((item) => item.redline));
    const allForbiddenContent = l3Cases
      .flatMap((item) => item.forbiddenContent)
      .join('\n');
    const allRubric = l3Cases.flatMap((item) => item.rubric).join('\n');

    expect([...redlineKinds]).toEqual(
      expect.arrayContaining([
        'NO_WRITE_ACTION',
        'NO_V1_WRITE_TOOL',
        'NO_SYSTEM_TERMS',
        'NO_FABRICATED_NUMBER',
        'PII',
      ]),
    );
    expect(allRubric).toContain('确认仍在可售期');
    expect(allForbiddenContent).toContain('低价券轰炸');
    expect(allForbiddenContent).toContain('create\u0050urchaseOrder');
  });

  it('keeps owner-visible requirements free of PII/system protocol words', () => {
    const banned = /phone\u0046ull|name\u0046ull|traceId|merchantId|storeId|agent_run_id/;
    for (const item of loadPhase2L3Cases()) {
      expect(item.userMessage).not.toMatch(banned);
      for (const point of item.rubric) {
        expect(point).not.toMatch(banned);
      }
    }
  });
});
