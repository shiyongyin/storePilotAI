import { describe, expect, it } from 'vitest';

import { buildDormantMemberMarkdown } from './member-output-rules.js';

describe('US-003 dormant markdown output snapshot', () => {
  it('renders the four required dormant sections without internal terms or full phone numbers', () => {
    const markdown = buildDormantMemberMarkdown({
      segments: [
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
          segmentCode: 'COUPON_EXPIRING',
          matchReason: '有券 5 天后过期',
        },
        {
          memberId: 'MBR_00150',
          nameMasked: '周先生',
          phoneMasked: '135****0150',
          lastVisitAt: '2026-02-28',
          segmentCode: 'DORMANT_NORMAL',
          matchReason: '60 天未到店且无券无储值',
        },
      ],
      coupons: [
        {
          couponId: 'CPN_00135_001',
          memberId: 'MBR_00135',
          daysToExpire: 5,
          status: 'UNUSED',
        },
      ],
    });

    expect(markdown).toContain('## 高价值沉睡');
    expect(markdown).toContain('## 储值沉睡');
    expect(markdown).toContain('## 有券沉睡');
    expect(markdown).toContain('## 普通沉睡');
    expect(markdown).not.toMatch(/(?<![*\d])1[0-9]{10}(?![*\d])/);
  });
});
