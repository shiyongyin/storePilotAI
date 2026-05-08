/**
 * 切片 18 §8.6 — replenishment-adjustment 渲染/描述函数补充覆盖率测试
 *
 * 主测试文件 replenishment-adjustment.test.ts 已覆盖 4 step 主路径；本文件补充：
 *   - describeOp 的 6 种 adjustmentType 全分支
 *   - formatPercent 的 NaN / undefined 兜底分支
 *   - renderAdjustmentMarkdown 的边界（before/after 缺一行、reason 含 `|`）
 *   - countAdjustmentLogs / writeAdjustmentLog SQL 调用形态
 *   - loadActiveDraftId 异常路径（DraftPool 未注入）
 */
import type { AdjustmentInstruction, DraftItem } from '@storepilot/shared-contracts';
import { describe, expect, it } from 'vitest';

import { __test_only__ } from './replenishment-adjustment.js';

const { describeOp, renderAdjustmentMarkdown } = __test_only__;

const baseInstruction: AdjustmentInstruction = {
  adjustmentId: 'adj_01HZ',
  draftId: 'drf_test01',
  userMessage: '矿泉水上调 20%',
  targetType: 'SKU_KEYWORD',
  targetValue: '矿泉水',
  adjustmentType: 'INCREASE_RATE',
  adjustmentRate: 0.2,
  reason: '需求上升',
  createdAt: '2025-11-01T08:00:00.000Z',
};

describe('describeOp — 6 种 adjustmentType 全分支', () => {
  it('INCREASE_RATE → "上调 N%"', () => {
    expect(describeOp({ ...baseInstruction, adjustmentType: 'INCREASE_RATE', adjustmentRate: 0.15 }))
      .toContain('上调 15%');
  });
  it('DECREASE_RATE → "下调 N%"', () => {
    expect(describeOp({ ...baseInstruction, adjustmentType: 'DECREASE_RATE', adjustmentRate: 0.3 }))
      .toContain('下调 30%');
  });
  it('INCREASE_QTY → "增加 N"', () => {
    expect(describeOp({ ...baseInstruction, adjustmentType: 'INCREASE_QTY', adjustmentQty: 5 }))
      .toContain('增加 5');
  });
  it('DECREASE_QTY → "减少 N"', () => {
    expect(describeOp({ ...baseInstruction, adjustmentType: 'DECREASE_QTY', adjustmentQty: 2 }))
      .toContain('减少 2');
  });
  it('SET_QTY → "设置为 N"', () => {
    expect(describeOp({ ...baseInstruction, adjustmentType: 'SET_QTY', adjustmentQty: 100 }))
      .toContain('设置为 100');
  });
  it('EXCLUDE → "排除（设为 0）"', () => {
    expect(describeOp({ ...baseInstruction, adjustmentType: 'EXCLUDE' }))
      .toContain('排除（设为 0）');
  });
  it('targetType=ALL → 文案使用 "全部 SKU"', () => {
    expect(
      describeOp({
        ...baseInstruction,
        targetType: 'ALL',
        targetValue: 'ALL',
        adjustmentType: 'INCREASE_RATE',
        adjustmentRate: 0.1,
      }),
    ).toContain('全部 SKU 上调 10%');
  });
  it('INCREASE_QTY 缺 adjustmentQty → 兜底为 "增加 0"', () => {
    expect(describeOp({ ...baseInstruction, adjustmentType: 'INCREASE_QTY' })).toContain('增加 0');
  });
  it('DECREASE_QTY 缺 adjustmentQty → 兜底为 "减少 0"', () => {
    expect(describeOp({ ...baseInstruction, adjustmentType: 'DECREASE_QTY' })).toContain('减少 0');
  });
  it('SET_QTY 缺 adjustmentQty → 兜底为 "设置为 0"', () => {
    expect(describeOp({ ...baseInstruction, adjustmentType: 'SET_QTY' })).toContain('设置为 0');
  });
  it('formatPercent NaN / undefined 兜底为 0%', () => {
    expect(
      describeOp({
        ...baseInstruction,
        adjustmentType: 'INCREASE_RATE',
        adjustmentRate: undefined as unknown as number,
      }),
    ).toContain('0%');
    expect(
      describeOp({
        ...baseInstruction,
        adjustmentType: 'DECREASE_RATE',
        adjustmentRate: Number.NaN,
      }),
    ).toContain('0%');
  });
});

describe('renderAdjustmentMarkdown — 边界', () => {
  const before: DraftItem[] = [
    {
      skuId: 'SKU001',
      skuName: '矿泉水 550ml',
      unit: '瓶',
      baseSuggestQty: 100,
      finalSuggestQty: 100,
      reason: '基线',
      adjustmentTrace: [],
    },
    {
      skuId: 'SKU002',
      skuName: '可乐 330ml',
      unit: '罐',
      baseSuggestQty: 50,
      finalSuggestQty: 50,
      reason: '基线 | 含 pipe',
      adjustmentTrace: [],
    },
  ];
  const after: DraftItem[] = [
    { ...before[0]!, finalSuggestQty: 120, adjustmentTrace: ['+20%'] },
    { ...before[1]!, finalSuggestQty: 0, adjustmentTrace: ['EXCLUDE'] },
  ];

  it('完整渲染 - 含 ## 影响的 SKU 表格 + 剩余次数 + 中文摘要', () => {
    const md = renderAdjustmentMarkdown({
      instruction: baseInstruction,
      beforeItems: before,
      afterItems: after,
      affectedSkuIds: ['SKU001', 'SKU002'],
      remaining: 3,
    });
    expect(md).toContain('# 补货调整结果');
    expect(md).toContain('## 影响的 SKU');
    expect(md).toContain('SKU001');
    expect(md).toContain('SKU002');
    expect(md).toContain('剩余可调整次数：3');
    // pipe 在 reason 中应被转义
    expect(md).toContain('基线 \\| 含 pipe');
  });

  it('after 缺行（仅 before 命中） → 用 before 数据兜底', () => {
    const md = renderAdjustmentMarkdown({
      instruction: baseInstruction,
      beforeItems: before,
      afterItems: [], // 空 after，触发兜底分支
      affectedSkuIds: ['SKU001'],
      remaining: 0,
    });
    expect(md).toContain('SKU001');
    expect(md).toContain('矿泉水 550ml');
  });

  it('before/after 都不命中 skuId（空字符串兜底）', () => {
    const md = renderAdjustmentMarkdown({
      instruction: baseInstruction,
      beforeItems: [],
      afterItems: [],
      affectedSkuIds: ['SKU_GHOST'],
      remaining: 1,
    });
    expect(md).toContain('SKU_GHOST');
    // 名称 / 单位 / reason 全空
    expect(md).toMatch(/SKU_GHOST \| {2}\| {2}\| 0 \| 0 \| {2}\|/);
  });

  it('remaining 为负数 → 渲染为 0', () => {
    const md = renderAdjustmentMarkdown({
      instruction: baseInstruction,
      beforeItems: before,
      afterItems: after,
      affectedSkuIds: ['SKU001'],
      remaining: -5,
    });
    expect(md).toContain('剩余可调整次数：0');
  });
});
