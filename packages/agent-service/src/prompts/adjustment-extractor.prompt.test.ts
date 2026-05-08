/**
 * 切片 15 §11 自检 — adjustment-extractor.prompt.ts 必须含全部强约束句段
 *
 * 覆盖（任务卡 §6 / §7 MUST DO §1 / MUST NOT §1）：
 *   - 4 + 6 枚举名全部出现
 *   - 不得输出 finalSuggestQty
 *   - 不得调用 createPurchaseOrder
 *   - 不得编造 skuId
 *   - 优先级映射规则（SKU_ID > SKU_KEYWORD > CATEGORY_CODE > ALL）
 *   - 6 种 adjustmentType 映射规则（"上调 20%" → INCREASE_RATE 0.2 等）
 */
import { describe, expect, it } from 'vitest';

import { adjustmentExtractorPrompt } from './adjustment-extractor.prompt.js';

describe('adjustmentExtractorPrompt — 4 + 6 枚举完整出现', () => {
  const ENUMS = [
    'SKU_ID',
    'SKU_KEYWORD',
    'CATEGORY_CODE',
    'ALL',
    'INCREASE_RATE',
    'DECREASE_RATE',
    'INCREASE_QTY',
    'DECREASE_QTY',
    'SET_QTY',
    'EXCLUDE',
  ];

  for (const e of ENUMS) {
    it(`prompt 含枚举值 ${e}`, () => {
      const text = adjustmentExtractorPrompt({
        userMessage: 'x',
        draftId: 'drf_test',
        draftItemNames: ['SKU001 矿泉水'],
      });
      expect(text).toContain(e);
    });
  }
});

describe('adjustmentExtractorPrompt — 强约束句段', () => {
  function getPrompt(): string {
    return adjustmentExtractorPrompt({
      userMessage: '矿泉水上调 20%',
      draftId: 'drf_test',
      draftItemNames: ['SKU001 矿泉水 550ml'],
      candidateCategories: ['饮料类'],
    });
  }

  it('明确禁止 LLM 输出 finalSuggestQty', () => {
    expect(getPrompt()).toMatch(/不得输出.*finalSuggestQty/);
  });

  it('明确禁止编造 skuId', () => {
    expect(getPrompt()).toMatch(/不得编造.*skuId|不得编造 skuId/);
  });

  it('明确禁止调用 createPurchaseOrder / 写工具', () => {
    expect(getPrompt()).toMatch(/createPurchaseOrder|不得调用任何写工具|绝不下采购单/);
  });

  it('强调 4 + 6 枚举范围', () => {
    const text = getPrompt();
    expect(text).toMatch(/4 个枚举之一/);
    expect(text).toMatch(/6 个枚举之一/);
  });

  it('给出"上调 20%" → INCREASE_RATE + adjustmentRate=0.2 的映射示例', () => {
    expect(getPrompt()).toMatch(/INCREASE_RATE \+ adjustmentRate=0\.2/);
  });

  it('给出"不要了/排除" → EXCLUDE 的映射示例', () => {
    expect(getPrompt()).toMatch(/EXCLUDE/);
    expect(getPrompt()).toMatch(/不要了|排除|别买/);
  });

  it('retry=true 时输出"重试抽取"提示', () => {
    const text = adjustmentExtractorPrompt({
      userMessage: 'x',
      draftId: 'drf_test',
      draftItemNames: [],
      retry: true,
    });
    expect(text).toMatch(/重试抽取|修复上次输出/);
  });

  it('candidateCategories 列入"可选品类"小节', () => {
    const text = adjustmentExtractorPrompt({
      userMessage: 'x',
      draftId: 'drf_test',
      draftItemNames: [],
      candidateCategories: ['饮料类', '酒水类'],
    });
    expect(text).toMatch(/可选品类/);
    expect(text).toContain('饮料类');
    expect(text).toContain('酒水类');
  });

  it('明确"输出 JSON 形态"示例（含 targetType / adjustmentType / 字段规则）', () => {
    const text = getPrompt();
    expect(text).toMatch(/输出 JSON 形态/);
    expect(text).toContain('"targetType"');
    expect(text).toContain('"adjustmentType"');
    expect(text).toContain('"adjustmentRate"');
    expect(text).toContain('"adjustmentQty"');
    expect(text).toContain('"reason"');
  });
});
