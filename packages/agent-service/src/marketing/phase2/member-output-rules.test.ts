import { describe, expect, it } from 'vitest';

import {
  buildDormantMemberMarkdown,
  groupDormantMembers,
} from './member-output-rules.js';

const segments = [
  {
    memberId: 'MBR_00123',
    nameMasked: '王女士',
    phoneMasked: '138****1234',
    lastVisitAt: '2026-03-10',
    segmentCode: 'DORMANT_HIGH_VALUE',
    matchReason: '高价值熟客超过个人复购周期 2 倍未到店',
  },
  {
    memberId: 'MBR_00151',
    nameMasked: '赵女士',
    phoneMasked: '136****0151',
    lastVisitAt: '2026-03-20',
    segmentCode: 'DORMANT_WITH_STORAGE',
    matchReason: '仍有储值余额 220 元且 45 天以上未到店',
  },
  {
    memberId: 'MBR_00135',
    nameMasked: '李女士',
    phoneMasked: '139****0135',
    lastVisitAt: '2026-04-01',
    segmentCode: 'DORMANT_WITH_COUPON',
    matchReason: '持有未使用券且 30 天以上未到店',
  },
  {
    memberId: 'MBR_00150',
    nameMasked: '周先生',
    phoneMasked: '135****0150',
    lastVisitAt: '2026-02-28',
    segmentCode: 'DORMANT_NORMAL',
    matchReason: '60 天未到店且无券无储值',
  },
  {
    memberId: 'MBR_00999',
    nameMasked: '低响应会员',
    phoneMasked: '139****9999',
    lastVisitAt: '2026-02-01',
    segmentCode: 'LOW_RESPONSIVE',
    matchReason: '历史 3 次活动触达 0 响应',
  },
] as const;

const coupons = [
  {
    couponId: 'CPN_00135_001',
    memberId: 'MBR_00135',
    daysToExpire: 5,
    status: 'UNUSED',
  },
] as const;

describe('member-output-rules US-003 dormant recall', () => {
  it('groups dormant members in ontology priority order and filters low-responsive members by default', () => {
    const groups = groupDormantMembers({ segments, coupons });

    expect(groups.map((group) => group.reasonCode)).toEqual([
      'DORMANT_HIGH_VALUE',
      'DORMANT_WITH_STORAGE',
      'DORMANT_WITH_COUPON',
      'DORMANT_NORMAL',
    ]);
    expect(groups.flatMap((group) => group.members.map((member) => member.memberId))).not.toContain(
      'MBR_00999',
    );
    expect(groups[0]?.members[0]?.suggestedAction).toContain('专属关怀');
    expect(groups[0]?.members[0]?.suggestedAction).not.toMatch(/低价券|5 折券/);
    expect(groups[1]?.members[0]?.reason).toContain('储值余额');
    expect(groups[2]?.members[0]?.reason).toContain('券');
  });

  it('builds safe markdown with all four sections, masked PII, and card_data', () => {
    const markdown = buildDormantMemberMarkdown({ segments, coupons });

    expect(markdown).toContain('## 高价值沉睡');
    expect(markdown).toContain('## 储值沉睡');
    expect(markdown).toContain('## 有券沉睡');
    expect(markdown).toContain('## 普通沉睡');
    expect(markdown).toContain('138****1234');
    expect(markdown).toContain('member_wakeup_list_card');
    expect(markdown).not.toMatch(/1[0-9]{10}/);
  });

  it('does not fabricate member counts when tools return no dormant members', () => {
    const markdown = buildDormantMemberMarkdown({ segments: [], coupons: [] });

    expect(markdown).toContain('当前没有命中沉睡会员');
    expect(markdown).not.toMatch(/\d+\s*(位|个|人)/);
    expect(markdown).toContain('member_wakeup_list_card');
  });
});
