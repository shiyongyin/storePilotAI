/**
 * 切片 15 §9 第 8-9 + 12 步 — matcher 4 级匹配短路 + 6 种 op + 负数保护 + adjustmentTrace 累加
 *
 * 覆盖（任务卡 docs/tanks/15-skill-replenishment-adjustment.md §9 / §10）：
 *   - 第 8 步：4 级匹配优先级**短路**（SKU_ID 命中 → 不再下钻 SKU_KEYWORD/CATEGORY/ALL）
 *   - 第 9 步：applyAdjustment 6 种 op 全覆盖 + 负数保护
 *   - 第 12 步：同 SKU 多次调整 → adjustmentTrace 累加
 *   - §10 测试场景 2：精确匹配（仅 1 条命中）
 *   - §10 测试场景 7：DECREASE_RATE 不出负
 *   - §10 测试场景 8：SET_QTY = 100
 *   - §10 测试场景 9：EXCLUDE = 0
 *   - §10 测试场景 10：ALL 全部下调 10%
 *   - §10 测试场景 11：CATEGORY_CODE 命中
 *   - 任务卡 §7 MUST DO §6：负数保护（DECREASE_QTY / DECREASE_RATE 不出负）
 *   - matcher 纯函数 grep 守门（与 calculator.test.ts §9.8 同模式）
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { AdjustmentInstruction, DraftItem } from '@storepilot/shared-contracts';
import { describe, expect, it } from 'vitest';

import {
  applyAdjustment,
  buildTraceLine,
  computeNewQty,
  matchTargets,
  type SkuCategoryMap,
} from './matcher.js';

/* ============================================================================
 * Fixtures
 * ========================================================================== */

function makeItem(over: Partial<DraftItem> = {}): DraftItem {
  return {
    skuId: 'SKU001',
    skuName: '矿泉水 550ml',
    unit: '瓶',
    baseSuggestQty: 100,
    finalSuggestQty: 100,
    reason: '近 7/14/30 日均销 10/10/10',
    adjustmentTrace: [],
    ...over,
  };
}

function makeInstruction(
  over: Partial<AdjustmentInstruction> = {},
): AdjustmentInstruction {
  return {
    adjustmentId: 'adj_test_1',
    draftId: 'drf_test_1',
    userMessage: '矿泉水上调 20%',
    targetType: 'SKU_KEYWORD',
    targetValue: '矿泉水',
    adjustmentType: 'INCREASE_RATE',
    adjustmentRate: 0.2,
    reason: 'test',
    createdAt: '2026-05-07T01:00:00.000+00:00',
    ...over,
  };
}

const ITEMS: DraftItem[] = [
  makeItem({ skuId: 'SKU001', skuName: '矿泉水 550ml' }),
  makeItem({ skuId: 'SKU002', skuName: '矿泉水 1.5L' }),
  makeItem({ skuId: 'SKU003', skuName: '可乐 500ml' }),
  makeItem({ skuId: 'SKU004', skuName: '雪碧 500ml' }),
  makeItem({ skuId: 'SKU005', skuName: '红牛 250ml' }),
];

/* ============================================================================
 * §9 步骤 8 — 4 级匹配短路
 * ========================================================================== */

describe('切片 15 §9 步骤 8 — 4 级匹配短路（不级联）', () => {
  it('SKU_ID 命中 → 仅返回该 1 条；不会回退 SKU_KEYWORD / CATEGORY / ALL', () => {
    const matched = matchTargets({
      items: ITEMS,
      instruction: { targetType: 'SKU_ID', targetValue: 'SKU001' },
    });
    expect(matched).toHaveLength(1);
    expect(matched[0]?.skuId).toBe('SKU001');
  });

  it('SKU_ID 0 命中 → 直接返回空数组（不回退 SKU_KEYWORD）', () => {
    const matched = matchTargets({
      items: ITEMS,
      instruction: { targetType: 'SKU_ID', targetValue: 'SKU999' },
    });
    expect(matched).toHaveLength(0);
  });

  it('SKU_KEYWORD 内部短路：先精确匹配，命中后不回退到 contains', () => {
    const matched = matchTargets({
      items: ITEMS,
      instruction: { targetType: 'SKU_KEYWORD', targetValue: '矿泉水 550ml' },
    });
    // 精确名称命中 → 仅 1 条（虽然 "矿泉水 1.5L" 也包含 "矿泉水"，但精确匹配短路了）
    expect(matched).toHaveLength(1);
    expect(matched[0]?.skuId).toBe('SKU001');
  });

  it('SKU_KEYWORD 精确未命中 → contains 模糊匹配', () => {
    const matched = matchTargets({
      items: ITEMS,
      instruction: { targetType: 'SKU_KEYWORD', targetValue: '矿泉水' },
    });
    expect(matched.map((it) => it.skuId).sort()).toEqual(['SKU001', 'SKU002']);
  });

  it('SKU_KEYWORD 空字符串 → 拒绝模糊（避免命中所有）', () => {
    const matched = matchTargets({
      items: ITEMS,
      instruction: { targetType: 'SKU_KEYWORD', targetValue: '' },
    });
    expect(matched).toHaveLength(0);
  });

  it('CATEGORY_CODE 命中（基于 skuCategoryMap）', () => {
    const map: SkuCategoryMap = new Map([
      ['SKU001', '饮料类'],
      ['SKU002', '饮料类'],
      ['SKU003', '饮料类'],
      ['SKU004', '饮料类'],
      ['SKU005', '功能饮料'],
    ]);
    const matched = matchTargets({
      items: ITEMS,
      instruction: { targetType: 'CATEGORY_CODE', targetValue: '功能饮料' },
      skuCategoryMap: map,
    });
    expect(matched).toHaveLength(1);
    expect(matched[0]?.skuId).toBe('SKU005');
  });

  it('CATEGORY_CODE 但 skuCategoryMap 缺失 → 0 命中（让上层 ADJUSTMENT_SKU_UNMATCHED）', () => {
    const matched = matchTargets({
      items: ITEMS,
      instruction: { targetType: 'CATEGORY_CODE', targetValue: '饮料类' },
    });
    expect(matched).toHaveLength(0);
  });

  it('ALL 返回全部 items 拷贝（不修改原数组）', () => {
    const matched = matchTargets({
      items: ITEMS,
      instruction: { targetType: 'ALL', targetValue: '' },
    });
    expect(matched).toHaveLength(ITEMS.length);
    expect(matched).not.toBe(ITEMS); // 必须是不同引用
    // 修改返回值不会影响原 ITEMS
    matched[0] = { ...matched[0]!, finalSuggestQty: 999 };
    expect(ITEMS[0]?.finalSuggestQty).toBe(100);
  });
});

/* ============================================================================
 * §10 测试场景 2 — 精确匹配
 * ========================================================================== */

describe('切片 15 §10.2 — 精确匹配（SKU_ID）', () => {
  it('SKU001 精确命中 1 条', () => {
    const matched = matchTargets({
      items: ITEMS,
      instruction: { targetType: 'SKU_ID', targetValue: 'SKU001' },
    });
    expect(matched).toHaveLength(1);
    expect(matched[0]?.skuName).toBe('矿泉水 550ml');
  });
});

/* ============================================================================
 * §9 步骤 9 — applyAdjustment 6 种 op + 负数保护
 * ========================================================================== */

describe('切片 15 §9 步骤 9 — 6 种 adjustmentType 全覆盖', () => {
  it('INCREASE_RATE 0.2 → 100 上调到 120', () => {
    const result = applyAdjustment({
      matched: [makeItem({ finalSuggestQty: 100 })],
      instruction: makeInstruction({ adjustmentType: 'INCREASE_RATE', adjustmentRate: 0.2 }),
    });
    expect(result[0]?.finalSuggestQty).toBe(120);
  });

  it('INCREASE_RATE 向上取整：100 * 1.005 = 100.5 → 101', () => {
    const result = applyAdjustment({
      matched: [makeItem({ finalSuggestQty: 100 })],
      instruction: makeInstruction({ adjustmentType: 'INCREASE_RATE', adjustmentRate: 0.005 }),
    });
    expect(result[0]?.finalSuggestQty).toBe(101);
  });

  it('DECREASE_RATE 0.3 → 100 下调到 70（向下取整）', () => {
    const result = applyAdjustment({
      matched: [makeItem({ finalSuggestQty: 100 })],
      instruction: makeInstruction({ adjustmentType: 'DECREASE_RATE', adjustmentRate: 0.3 }),
    });
    expect(result[0]?.finalSuggestQty).toBe(70);
  });

  it('INCREASE_QTY +50 → 100 + 50 = 150', () => {
    const result = applyAdjustment({
      matched: [makeItem({ finalSuggestQty: 100 })],
      instruction: makeInstruction({
        adjustmentType: 'INCREASE_QTY',
        adjustmentQty: 50,
        adjustmentRate: undefined,
      }),
    });
    expect(result[0]?.finalSuggestQty).toBe(150);
  });

  it('DECREASE_QTY -20 → 100 - 20 = 80', () => {
    const result = applyAdjustment({
      matched: [makeItem({ finalSuggestQty: 100 })],
      instruction: makeInstruction({
        adjustmentType: 'DECREASE_QTY',
        adjustmentQty: 20,
        adjustmentRate: undefined,
      }),
    });
    expect(result[0]?.finalSuggestQty).toBe(80);
  });

  it('SET_QTY = 100 → finalSuggestQty 直接 = 100（任务卡 §10.8）', () => {
    const result = applyAdjustment({
      matched: [makeItem({ finalSuggestQty: 50 })],
      instruction: makeInstruction({
        adjustmentType: 'SET_QTY',
        adjustmentQty: 100,
        adjustmentRate: undefined,
      }),
    });
    expect(result[0]?.finalSuggestQty).toBe(100);
  });

  it('EXCLUDE → finalSuggestQty = 0（任务卡 §10.9）', () => {
    const result = applyAdjustment({
      matched: [makeItem({ finalSuggestQty: 100 })],
      instruction: makeInstruction({
        adjustmentType: 'EXCLUDE',
        adjustmentRate: undefined,
      }),
    });
    expect(result[0]?.finalSuggestQty).toBe(0);
  });
});

describe('切片 15 §7 MUST DO §6 — 负数保护', () => {
  it('DECREASE_QTY 100 → 100 - 100 = 0（不出负）', () => {
    const result = applyAdjustment({
      matched: [makeItem({ finalSuggestQty: 100 })],
      instruction: makeInstruction({
        adjustmentType: 'DECREASE_QTY',
        adjustmentQty: 200, // 比当前还多
        adjustmentRate: undefined,
      }),
    });
    expect(result[0]?.finalSuggestQty).toBe(0);
  });

  it('DECREASE_RATE > 1 → finalSuggestQty=0（不出负；任务卡 §10.7）', () => {
    const result = applyAdjustment({
      matched: [makeItem({ finalSuggestQty: 100 })],
      instruction: makeInstruction({
        adjustmentType: 'DECREASE_RATE',
        adjustmentRate: 1.5, // 异常值
      }),
    });
    expect(result[0]?.finalSuggestQty).toBe(0);
  });

  it('DECREASE_RATE 负数 → 取绝对值后下调（防止 LLM 抽取漂移导致出负）', () => {
    // rate=-0.3 → 取 abs=0.3 → 下调 30% → 70
    const result = applyAdjustment({
      matched: [makeItem({ finalSuggestQty: 100 })],
      instruction: makeInstruction({
        adjustmentType: 'DECREASE_RATE',
        adjustmentRate: -0.3,
      }),
    });
    expect(result[0]?.finalSuggestQty).toBe(70);
  });

  it('SET_QTY = -50 → 0（不出负）', () => {
    const result = applyAdjustment({
      matched: [makeItem({ finalSuggestQty: 100 })],
      instruction: makeInstruction({
        adjustmentType: 'SET_QTY',
        adjustmentQty: -50,
        adjustmentRate: undefined,
      }),
    });
    expect(result[0]?.finalSuggestQty).toBe(0);
  });

  it('rate 缺失 → INCREASE_RATE 等价 +0%', () => {
    expect(
      computeNewQty(100, { adjustmentType: 'INCREASE_RATE', adjustmentRate: undefined }),
    ).toBe(100);
  });

  it('NaN / Infinity rate → 视为 0', () => {
    expect(
      computeNewQty(100, { adjustmentType: 'INCREASE_RATE', adjustmentRate: NaN }),
    ).toBe(100);
    expect(
      computeNewQty(100, {
        adjustmentType: 'INCREASE_RATE',
        adjustmentRate: Number.POSITIVE_INFINITY,
      }),
    ).toBe(100);
  });

  it('NaN / Infinity qty → 视为 0', () => {
    expect(
      computeNewQty(100, { adjustmentType: 'INCREASE_QTY', adjustmentQty: NaN }),
    ).toBe(100);
    expect(
      computeNewQty(100, {
        adjustmentType: 'DECREASE_QTY',
        adjustmentQty: Number.POSITIVE_INFINITY,
      }),
    ).toBe(100);
  });

  it('current 为负 / NaN → 视为 0', () => {
    expect(
      computeNewQty(NaN, { adjustmentType: 'INCREASE_RATE', adjustmentRate: 0.5 }),
    ).toBe(0);
    expect(
      computeNewQty(-10, { adjustmentType: 'INCREASE_QTY', adjustmentQty: 5 }),
    ).toBe(5);
  });
});

/* ============================================================================
 * §9 步骤 12 — adjustmentTrace 累加
 * ========================================================================== */

describe('切片 15 §9 步骤 12 — adjustmentTrace 累加（不替换）', () => {
  it('已有 trace 1 行 → applyAdjustment 后 trace 长度变 2', () => {
    const before = makeItem({
      finalSuggestQty: 100,
      adjustmentTrace: ['INCREASE_RATE(0.1) by user @ 2026-05-06T10:00:00.000+00:00'],
    });
    const result = applyAdjustment({
      matched: [before],
      instruction: makeInstruction({
        adjustmentType: 'INCREASE_RATE',
        adjustmentRate: 0.2,
        createdAt: '2026-05-07T01:00:00.000+00:00',
      }),
    });
    expect(result[0]?.adjustmentTrace).toHaveLength(2);
    expect(result[0]?.adjustmentTrace[0]).toContain('INCREASE_RATE(0.1)'); // 旧 trace 保留
    expect(result[0]?.adjustmentTrace[1]).toContain('INCREASE_RATE(0.2)'); // 新 trace 追加
    expect(result[0]?.adjustmentTrace[1]).toContain('2026-05-07T01:00:00.000+00:00');
  });

  it('原对象 / trace 数组不被 mutate（不可变）', () => {
    const original = makeItem({
      finalSuggestQty: 100,
      adjustmentTrace: ['old'],
    });
    const before = original;
    applyAdjustment({
      matched: [before],
      instruction: makeInstruction(),
    });
    expect(original.adjustmentTrace).toEqual(['old']);
    expect(original.finalSuggestQty).toBe(100);
  });
});

describe('buildTraceLine 行格式', () => {
  it('RATE 类型：含 rate 数字', () => {
    const line = buildTraceLine(
      makeInstruction({ adjustmentType: 'INCREASE_RATE', adjustmentRate: 0.2 }),
    );
    expect(line).toContain('INCREASE_RATE(0.2)');
    expect(line).toContain('by user @ 2026-05-07T01:00:00.000+00:00');
  });

  it('QTY 类型：含 qty 整数', () => {
    const line = buildTraceLine(
      makeInstruction({
        adjustmentType: 'INCREASE_QTY',
        adjustmentQty: 50,
        adjustmentRate: undefined,
      }),
    );
    expect(line).toContain('INCREASE_QTY(50)');
  });

  it('EXCLUDE：括号为空', () => {
    const line = buildTraceLine(
      makeInstruction({ adjustmentType: 'EXCLUDE', adjustmentRate: undefined }),
    );
    expect(line).toContain('EXCLUDE()');
  });
});

/* ============================================================================
 * §10.10 — ALL 全部下调 10%
 * ========================================================================== */

describe('切片 15 §10.10 — ALL 全部下调 10%', () => {
  it('ALL + DECREASE_RATE 0.1 → 所有 items 下调 10%', () => {
    const matched = matchTargets({
      items: ITEMS,
      instruction: { targetType: 'ALL', targetValue: '' },
    });
    const result = applyAdjustment({
      matched,
      instruction: makeInstruction({
        targetType: 'ALL',
        targetValue: '',
        adjustmentType: 'DECREASE_RATE',
        adjustmentRate: 0.1,
      }),
    });
    expect(result).toHaveLength(ITEMS.length);
    for (const it of result) {
      expect(it.finalSuggestQty).toBe(90); // 100 * 0.9 = 90
    }
  });
});

/* ============================================================================
 * 纯函数 grep 守门（与 calculator.test.ts §9.8 同模式）
 * ========================================================================== */

describe('matcher.ts 纯函数 grep 守门（任务卡 §7 MUST NOT §1）', () => {
  it('源文件不得出现 await / fetch / mcp / openai / db / Math.random / require', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./matcher.ts', import.meta.url)),
      'utf8',
    );
    const stripped = src
      .split('\n')
      // 跳过注释行（含 await / fetch 等单词描述）
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    expect(stripped, 'matcher.ts 不得出现 await').not.toMatch(/\bawait\b/);
    expect(stripped, 'matcher.ts 不得出现 fetch 调用').not.toMatch(/\bfetch\s*\(/);
    expect(stripped, 'matcher.ts 不得出现 require(...)').not.toMatch(/\brequire\s*\(/);
    expect(stripped, 'matcher.ts 不得出现 Math.random').not.toMatch(/Math\.random/);
    expect(stripped, 'matcher.ts 不得直接 import openai').not.toMatch(/from '@ai-sdk\/openai'/);
    expect(stripped, 'matcher.ts 不得直接 import mysql2').not.toMatch(/from 'mysql2/);
  });
});
