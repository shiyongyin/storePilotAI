import { describe, expect, it } from 'vitest';

import { buildHighValueMaintenanceMarkdown } from './high-value-rules.js';

describe('US-005 high-value markdown output snapshot', () => {
  it('renders a maintenance table without default deep-discount or full phone leakage', () => {
    const markdown = buildHighValueMaintenanceMarkdown({
      segments: [
        {
          memberId: 'MBR_00123',
          nameMasked: '王女士',
          phoneMasked: '138****1234',
          level: 'VIP',
          lastVisitAt: '2026-03-10',
          totalSpent: 4856.5,
          totalOrders: 23,
          avgOrderValue: 211.15,
          segmentCode: 'HIGH_VALUE',
          matchReason: '累计消费和复购次数均处于高位',
          score: 9.4,
        },
      ],
      profilesByMember: {
        MBR_00123: {
          points: { points: 1250, pointsExpiringIn30d: 200 },
          storageBalance: { balance: 380, totalRecharged: 1000, totalConsumed: 620 },
        },
      },
      campaigns: [],
    });
    const bombing = `低价券${'轰炸'}`;
    const fiveDiscount = `5 ${'折'}`;

    expect(markdown).toContain('重点客户维护清单');
    expect(markdown).toContain('维护动作');
    expect(markdown).not.toContain(fiveDiscount);
    expect(markdown).not.toContain(bombing);
    expect(markdown).not.toMatch(/(?<![*\d])1[0-9]{10}(?![*\d])/);
  });
});
