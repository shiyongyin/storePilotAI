/**
 * 切片 17 §9.11 — composePoPreview（preview markdown 渲染）单测
 *
 * 覆盖：
 *   - 任务卡 §7 MUST DO §7：preview markdown 含 itemCount / totalQty / 影响 SKU 列表（不省略）。
 *   - 任务卡 §10 测试场景 10：preview 完整 — 50 SKU 全部列出，不省略。
 *   - 任务卡 §7 MUST NOT §2 / R-PO-003：所有数字直接来自 DraftItem，不调 LLM。
 *   - 表格安全：reason 内 `|` 字符必须转义为 `\|`，避免破坏列分隔。
 */
import type { DraftItem } from '@storepilot/shared-contracts';
import { describe, expect, it } from 'vitest';

import type { DraftView } from '../../safety/draft-manager.js';

import { composePoPreview } from './compose-po-preview.js';

function makeItem(over: Partial<DraftItem> = {}): DraftItem {
  return {
    skuId: 'SKU001',
    skuName: '矿泉水 550ml',
    unit: '瓶',
    baseSuggestQty: 100,
    finalSuggestQty: 100,
    reason: '加权日均 10',
    adjustmentTrace: [],
    ...over,
  };
}

function makeDraft(items: DraftItem[]): DraftView {
  const now = new Date('2026-05-07T01:00:00.000Z');
  return {
    draftId: 'drf_aaaaaaaaaaaaaaaaaaaaaaaa',
    sessionId: 'sess_test',
    merchantId: 'M-1',
    storeId: 'S-1',
    userId: 'U-1',
    traceId: 'trace_seed',
    forecastDays: 7,
    status: 'WAIT_CONFIRM',
    items,
    strategyVersion: 'M0-S0-Pp-1',
    submittedPoNo: null,
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

describe('切片 17 §9.11 — composePoPreview', () => {
  it('返回 itemCount / totalQty / markdown 三件套（含完整 SKU 列）', () => {
    const draft = makeDraft([
      makeItem({ skuId: 'SKU001', skuName: '矿泉水', finalSuggestQty: 24, unit: '瓶' }),
      makeItem({ skuId: 'SKU002', skuName: '可乐', finalSuggestQty: 36, unit: '瓶' }),
      makeItem({ skuId: 'SKU003', skuName: '面条', finalSuggestQty: 5, unit: '箱' }),
    ]);

    const result = composePoPreview(draft);
    expect(result.itemCount).toBe(3);
    expect(result.totalQty).toBe(65);
    expect(result.markdown).toContain('# 采购单确认');
    expect(result.markdown).toContain('影响 SKU 数：3');
    expect(result.markdown).toContain('总数量：65');
    // 单位品类数：瓶 / 箱 → 2
    expect(result.markdown).toContain('单位品类数：2');
    // 完整列出 3 行
    expect(result.markdown).toContain('SKU001');
    expect(result.markdown).toContain('SKU002');
    expect(result.markdown).toContain('SKU003');
    expect(result.markdown).toContain('请回复"确认"以创建采购单');
  });

  it('§10.10 — 50 SKU 全部列出（不省略）', () => {
    const items: DraftItem[] = [];
    for (let i = 0; i < 50; i++) {
      const skuId = `SKU${String(i + 1).padStart(3, '0')}`;
      items.push(
        makeItem({
          skuId,
          skuName: `测试商品 ${i + 1}`,
          finalSuggestQty: 10 + i,
          unit: '件',
        }),
      );
    }
    const result = composePoPreview(makeDraft(items));
    expect(result.itemCount).toBe(50);

    // 50 行表格 = 50 个 SKU 出现
    for (let i = 0; i < 50; i++) {
      const skuId = `SKU${String(i + 1).padStart(3, '0')}`;
      expect(result.markdown).toContain(skuId);
    }

    // 不允许"..."等省略形态
    expect(result.markdown).not.toContain('...更多');
    expect(result.markdown).not.toContain('省略');
  });

  it('reason 含 "|" 字符 → 转义为 "\\|" 不破坏表格', () => {
    const draft = makeDraft([
      makeItem({ skuId: 'SKU001', reason: '加权 | 日均 10' }),
    ]);
    const result = composePoPreview(draft);
    expect(result.markdown).toContain('加权 \\| 日均 10');
    expect(result.markdown).not.toMatch(/\| 加权 \| 日均 10 \|/); // 未转义会破坏列
  });

  it('reason 含换行 → 折叠为空格保持单行', () => {
    const draft = makeDraft([
      makeItem({ skuId: 'SKU001', reason: '原因\n第二行' }),
    ]);
    const result = composePoPreview(draft);
    expect(result.markdown).toContain('原因 第二行');
  });

  it('totalQty = 所有 finalSuggestQty 之和', () => {
    const draft = makeDraft([
      makeItem({ finalSuggestQty: 100 }),
      makeItem({ skuId: 'SKU2', finalSuggestQty: 50 }),
      makeItem({ skuId: 'SKU3', finalSuggestQty: 25 }),
    ]);
    expect(composePoPreview(draft).totalQty).toBe(175);
  });

  it('单一 unit → 单位品类数 = 1', () => {
    const draft = makeDraft([
      makeItem({ skuId: 'SKU1', unit: '瓶' }),
      makeItem({ skuId: 'SKU2', unit: '瓶' }),
    ]);
    expect(composePoPreview(draft).markdown).toContain('单位品类数：1');
  });
});
