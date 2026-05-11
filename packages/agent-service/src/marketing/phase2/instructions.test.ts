import { describe, expect, it } from 'vitest';

import { buildPhase2Instructions } from './instructions.js';

describe('buildPhase2Instructions', () => {
  it('builds composable phase2 instructions without leaking system terms or PII examples', () => {
    const instructions = buildPhase2Instructions();

    expect(instructions).toContain('US-003');
    expect(instructions).toContain('US-004');
    expect(instructions).toContain('US-005');
    expect(instructions).toContain('REPURCHASE_DUE');
    expect(instructions).toContain('HIGH_VALUE');
    expect(instructions).toContain('US-010');
    expect(instructions).toContain('US-009');
    expect(instructions).toContain('US-010');
    expect(instructions).toContain('高毛利主推不是最贵商品排序');
    expect(instructions).toContain('过期或不可售商品只能建议下架/报损/联系 ERP 流程');
    expect(instructions).toContain('product_recommend_card');
    expect(instructions).toContain('9 个只读');
    expect(instructions).toContain('V1 采购写工具');
    expect(instructions).toContain('脱敏');
    expect(instructions).toContain('缺货');
    expect(instructions).toContain('毛利');
    expect(instructions).not.toMatch(/1\d{10}/);
  });
});
