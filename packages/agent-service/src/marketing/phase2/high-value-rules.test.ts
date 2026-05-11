import { describe, expect, it } from 'vitest';

import {
  buildHighValueMaintenanceItems,
  buildHighValueMaintenanceMarkdown,
  deriveHighValueScore,
} from './high-value-rules.js';

const segments = [
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
  {
    memberId: 'MBR_00123',
    nameMasked: '王女士',
    phoneMasked: '138****1234',
    level: 'VIP',
    lastVisitAt: '2026-03-10',
    totalSpent: 4856.5,
    totalOrders: 23,
    avgOrderValue: 211.15,
    segmentCode: 'DORMANT_HIGH_VALUE',
    matchReason: '高价值熟客超过个人复购周期 2 倍未到店',
    score: 9.1,
  },
  {
    memberId: 'MBR_00135',
    nameMasked: '李女士',
    phoneMasked: '139****0135',
    level: 'GOLD',
    lastVisitAt: '2026-04-01',
    totalSpent: 2380,
    totalOrders: 14,
    avgOrderValue: 170,
    segmentCode: 'LOYAL_FREQUENT',
    matchReason: '近 12 月复购次数较高',
    score: 8.3,
  },
  {
    memberId: 'MBR_00151',
    nameMasked: '赵女士',
    phoneMasked: '136****0151',
    level: 'SILVER',
    lastVisitAt: '2026-03-20',
    totalSpent: 1380,
    totalOrders: 9,
    avgOrderValue: 153.33,
    segmentCode: 'LOYAL_FREQUENT',
    matchReason: '到店频次较稳定',
  },
  {
    memberId: 'MBR_00152',
    nameMasked: '低响应会员',
    phoneMasked: '134****0152',
    level: 'NORMAL',
    lastVisitAt: '2026-02-01',
    totalSpent: 520,
    totalOrders: 4,
    avgOrderValue: 130,
    segmentCode: 'LOW_RESPONSIVE',
    matchReason: '历史 3 次活动触达 0 次响应',
    score: 2.1,
  },
] as const;

const profilesByMember = {
  MBR_00123: {
    points: { points: 1250, pointsExpiringIn30d: 200 },
    storageBalance: { balance: 380, totalRecharged: 1000, totalConsumed: 620 },
  },
  MBR_00135: {
    points: { points: 680, pointsExpiringIn30d: 80 },
    storageBalance: { balance: 0, totalRecharged: 0, totalConsumed: 0 },
  },
  MBR_00151: {
    points: { points: 310, pointsExpiringIn30d: 30 },
    storageBalance: { balance: 220, totalRecharged: 500, totalConsumed: 280 },
  },
} as const;

const campaigns = [
  {
    campaignId: 'CAMP_2025NOV',
    campaignName: '双 11 老客回访',
    touchedMembers: 150,
    convertedMembers: 42,
    salesAmount: 38900,
    grossMarginRate: 0.41,
    resultSummary: '复购率提升 18%，毛利保持稳定',
  },
] as const;

describe('US-005 high-value member maintenance rules', () => {
  it('uses tool score first, filters low-responsive members by default, and keeps high-value dormant as a risk tag', () => {
    const items = buildHighValueMaintenanceItems({ segments, profilesByMember, campaigns });

    expect(items.map((item) => item.memberId)).toEqual(['MBR_00123', 'MBR_00135', 'MBR_00151']);
    expect(items.map((item) => item.memberId)).not.toContain('MBR_00152');
    expect(items[0]).toMatchObject({
      memberId: 'MBR_00123',
      score: 9.4,
      scoreSource: 'TOOL',
      reasonCode: 'HIGH_VALUE',
    });
    expect(items[0]?.riskPreference).toContain('高价值但近期沉睡');
    expect(items[0]?.riskPreference).toContain('储值余额 380 元');
  });

  it('declares a deterministic fallback score formula when tool score is absent', () => {
    const score = deriveHighValueScore({
      member: {
        totalSpent: 1380,
        totalOrders: 9,
        avgOrderValue: 153.33,
        level: 'SILVER',
      },
      storageBalance: 220,
      maxValues: {
        totalSpent: 4856.5,
        totalOrders: 23,
        avgOrderValue: 211.15,
        storageBalance: 380,
      },
      segmentCodes: ['LOYAL_FREQUENT'],
    });

    expect(score.formula).toContain('normalize(totalSpent)*0.35');
    expect(score.value).toBeGreaterThan(0);
    expect(score.value).toBeLessThan(10);
  });

  it('builds owner-safe markdown with relationship actions, no unsupported complaint claims, and no discount bombing', () => {
    const markdown = buildHighValueMaintenanceMarkdown({ segments, profilesByMember, campaigns });
    const bombing = `低价券${'轰炸'}`;
    const fiveDiscount = `5 ${'折'}`;
    const unsupportedComplaintClaim = `无${'投诉'}`;

    expect(markdown).toContain('## 重点客户维护清单');
    expect(markdown).toContain('| 顾客 | 价值依据 | 风险/偏好 | 维护动作 | 推荐话术 |');
    expect(markdown).toContain('消费金额 4856.5 元');
    expect(markdown).toContain('活动响应：会员级明细未返回');
    expect(markdown).toContain('毛利贡献：会员级毛利未返回');
    expect(markdown).toContain('member_wakeup_list_card');
    expect(markdown).not.toContain(fiveDiscount);
    expect(markdown).not.toContain(bombing);
    expect(markdown).not.toContain(unsupportedComplaintClaim);
    expect(markdown).not.toMatch(/(?<![*\d])1[0-9]{10}(?![*\d])/);
    expect(markdown).not.toMatch(/tool_calls|function_call|traceId|merchantId|storeId|agent_run_id/i);
  });
});
