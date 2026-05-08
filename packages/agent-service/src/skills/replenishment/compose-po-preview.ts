/**
 * 切片 17 — 采购单 preview markdown 渲染（composePoPreview）
 *
 * 严格按 docs/tanks/17-skill-purchase-order-create-hitl.md §7 / §8.1 落地。
 *
 * 职责：
 *   - 把 DraftView.items 渲染成 markdown，用于 HITL askConfirmStep 的 suspend payload。
 *   - markdown 必须含：商品数 / 总数量 / 总品类 / 影响 SKU 完整列表（**不省略**，§7 MUST DO §7）。
 *   - markdown 与采购单数据来源同构：所有数字直接来自 DraftView.items（结构化）。
 *
 * 强约束（违反即拒收）：
 *   - **MUST 完整列影响 SKU**（任务卡 §7 MUST DO §7 / §11 自检 §8）：影响 SKU 列表不得截断；
 *     如有 N 行就必须输出 N 行表格，便于老板逐行核对。
 *   - **MUST 数字结构化**（任务卡 §7 MUST NOT §2 / R-PO-003）：本函数不接 LLM；
 *     全部字段直接读 `DraftItem.{skuId, skuName, unit, finalSuggestQty, reason}`。
 *   - **MUST 纯函数**（无 IO，无 logger）：本函数与 assertDraftCanCreatePo 配套，
 *     在 previewStep 内同步渲染，避免引入额外 await。
 *
 * 引用：
 *   - 任务卡 docs/tanks/17-skill-purchase-order-create-hitl.md §7 / §8.1
 *   - E-Skill.md §T-SKILL-05.5.1（PreviewSchema 定义）
 *   - 切片 13（DraftView）
 *
 * @since 2026-05-07（切片 17 落地）
 */
import type { DraftView } from '../../safety/draft-manager.js';

/**
 * preview 渲染结果（与 PreviewSchema 子集对齐）。
 *
 * - `itemCount`：影响 SKU 行数（== `draft.items.length`）。
 * - `totalQty`：所有 SKU finalSuggestQty 之和（用于卡片摘要）。
 * - `markdown`：完整 markdown（含影响列表）。
 */
export interface PoPreviewRenderResult {
  itemCount: number;
  totalQty: number;
  markdown: string;
}

/**
 * 把 DraftView 渲染为采购单 preview markdown。
 *
 * 输出结构（任务卡 §7 MUST DO §7）：
 *
 * ```markdown
 * # 采购单确认
 *
 * - 草稿 ID：drf_xxxx
 * - 影响 SKU 数：N
 * - 总数量：M
 * - 单位品类数：K
 *
 * ## 影响的 SKU
 *
 * | SKU | 名称 | 数量 | 单位 | reason |
 * | --- | --- | ---: | --- | --- |
 * | SKU001 | 矿泉水 550ml | 24 | 瓶 | ... |
 * | ... | ... | ... | ... | ... |
 *
 * 请回复"确认"以创建采购单，或"取消"以放弃。
 * ```
 *
 * 注意：
 *   - 本函数对 reason 内的 `|` 字符做转义（避免破坏 markdown 表格）。
 *   - 不引入 LLM（任务卡 §7 MUST NOT §2 / R-PO-003：从 draftItems 取数）。
 *   - 数量 / 品类数取自结构化字段；不通过 markdown 反解析。
 *
 * @param draft 已通过 assertDraftCanCreatePo 校验的合法草稿
 * @returns markdown / itemCount / totalQty 三件套
 */
export function composePoPreview(draft: DraftView): PoPreviewRenderResult {
  const itemCount = draft.items.length;
  const totalQty = draft.items.reduce((sum, it) => sum + it.finalSuggestQty, 0);

  // 单位品类数（unique unit）—— 用于让老板快速判断采购包装组合
  const uniqueUnits = new Set(draft.items.map((it) => it.unit));

  const headerLines = [
    `# 采购单确认`,
    ``,
    `- 草稿 ID：${draft.draftId}`,
    `- 影响 SKU 数：${itemCount}`,
    `- 总数量：${totalQty}`,
    `- 单位品类数：${uniqueUnits.size}`,
    ``,
    `## 影响的 SKU`,
    ``,
    `| SKU | 名称 | 数量 | 单位 | reason |`,
    `| --- | --- | ---: | --- | --- |`,
  ];

  // 完整列影响 SKU（任务卡 §7 MUST DO §7：不省略；50/100/2000 行均完整列出）
  const tableLines = draft.items.map((it) => {
    const safeName = escapeMarkdownCell(it.skuName);
    const safeReason = escapeMarkdownCell(it.reason);
    const safeUnit = escapeMarkdownCell(it.unit);
    return `| ${it.skuId} | ${safeName} | ${it.finalSuggestQty} | ${safeUnit} | ${safeReason} |`;
  });

  const footerLines = [``, `请回复"确认"以创建采购单，或"取消"以放弃。`];

  const markdown = [...headerLines, ...tableLines, ...footerLines].join('\n');
  return { itemCount, totalQty, markdown };
}

/**
 * 转义 markdown 表格单元格内的特殊字符。
 *
 * - `|` → `\|`：避免破坏列分隔。
 * - `\n` → 空格：折叠多行 reason，保持表格行完整。
 *
 * 注：本切片故意不做更激进的 HTML escape；表格内容仅做必要的 markdown 字符兼容，
 * 由桥接层 OutputGuard（切片 10）做最终输出过滤。
 */
function escapeMarkdownCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
