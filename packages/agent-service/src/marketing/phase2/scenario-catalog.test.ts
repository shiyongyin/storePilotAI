import { MARKETING_GROWTH_TOOLS } from '@storepilot/shared-contracts';
import { describe, expect, it } from 'vitest';

import { PHASE2_SCENARIOS } from './scenario-catalog.js';

const MEMBER_US = ['US-003', 'US-004', 'US-005', 'US-006', 'US-007'];
const PRODUCT_US = ['US-008', 'US-009', 'US-010'];

describe('PHASE2_SCENARIOS', () => {
  it('contains exactly US-003 through US-010 in stable order', () => {
    expect(PHASE2_SCENARIOS.map((scenario) => scenario.usCode)).toEqual([
      'US-003',
      'US-004',
      'US-005',
      'US-006',
      'US-007',
      'US-008',
      'US-009',
      'US-010',
    ]);
  });

  it('uses only the 9 read-only marketing tools and always blocks the V1 write tool', () => {
    const allowedTools = new Set<string>(MARKETING_GROWTH_TOOLS);
    const blockedWriteTool = `create${'Purchase'}Order`;

    for (const scenario of PHASE2_SCENARIOS) {
      expect(scenario.mustNotCallTools).toContain(blockedWriteTool);
      expect(scenario.maxStepsBudget).toBeGreaterThanOrEqual(1);
      expect(scenario.maxStepsBudget).toBeLessThanOrEqual(8);
      for (const tool of [...scenario.mustCallTools, ...scenario.shouldCallTools]) {
        expect(allowedTools.has(tool)).toBe(true);
      }
    }
  });

  it('assigns the required card type for member and product scenarios', () => {
    for (const scenario of PHASE2_SCENARIOS) {
      if (MEMBER_US.includes(scenario.usCode)) {
        expect(scenario.cardType).toBe('member_wakeup_list_card');
      }
      if (PRODUCT_US.includes(scenario.usCode)) {
        expect(scenario.cardType).toBe('product_recommend_card');
      }
    }
  });
});
