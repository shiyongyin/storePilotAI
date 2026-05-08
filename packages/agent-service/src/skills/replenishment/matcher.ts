/**
 * 切片 15 — 调整 Skill 4 级匹配 + 6 种 op 应用（matcher.ts，纯函数）
 *
 * 严格按 docs/tanks/15-skill-replenishment-adjustment.md §6 / §7 / §8 落地。
 *
 * 职责（任务卡 §6 / §8）：
 *   - {@link matchTargets}：按 R-ADJ-002 4 级匹配优先级（**短路**）查找受影响的 SKU。
 *     SKU_ID 精确 > skuName 精确 > skuName 关键词（contains）> CATEGORY_CODE > ALL。
 *   - {@link applyAdjustment}：6 种 adjustmentType 全覆盖 +
 *     负数保护（DECREASE_QTY / DECREASE_RATE 不出负），追加 adjustmentTrace。
 *
 * 强约束（违反即拒收，与任务卡 §7 一一对应）：
 *   - **MUST 纯函数**：本文件不得 await / fetch / mcp / openai / db / Math.random，
 *     便于 12 步验收的"短路 / 6 op / 负数保护 / 累加 trace"全部以毫秒级单测覆盖；
 *     CI 通过 grep 守门（任务卡 §7 MUST NOT §1 + matcher.test.ts 守门）。
 *   - **MUST 4 级匹配短路**：高优先级匹配命中后**立即返回**，不再尝试低优先级；
 *     `targetType` 决定起点：SKU_ID 不会回退到 SKU_KEYWORD；
 *     SKU_KEYWORD 内部先精确再 contains 仍属同级（同 R-ADJ-002）。
 *   - **MUST 6 种 op 全覆盖**：INCREASE_RATE / DECREASE_RATE / INCREASE_QTY /
 *     DECREASE_QTY / SET_QTY / EXCLUDE 各有正确算式；不得新增第 7 种。
 *   - **MUST 负数保护**：DECREASE_QTY / DECREASE_RATE / SET_QTY / EXCLUDE 结果均
 *     `Math.max(0, ...)`；finalSuggestQty 永远 >= 0 整数（DraftItem.finalSuggestQty
 *     的 Zod 守门为 `nonnegative()`，本函数提前兜底）。
 *   - **MUST adjustmentTrace 累加**：每次返回的 DraftItem 都在原 trace 末尾追加一行，
 *     不得替换 / 重置；trace 行格式见下文 {@link buildTraceLine}。
 *   - **MUST NOT 让 LLM 直接产出 finalSuggestQty**：本文件计算结果是 SSOT，
 *     instruction-extractor 仅负责把"自然语言 → AdjustmentInstruction"，
 *     最终数字由本文件按 op 公式确定。
 *
 * 引用：
 *   - 任务卡 docs/tanks/15-skill-replenishment-adjustment.md §5 / §7 / §8.1 / §8.2
 *   - shared-contracts/drafts.ts（AdjustmentInstruction / DraftItem SSOT）
 *
 * @since 2026-05-07（切片 15 落地）
 */
import type { AdjustmentInstruction, DraftItem } from '@storepilot/shared-contracts';

/* ============================================================================
 * 1) 4 级匹配（纯函数）
 * ========================================================================== */

/**
 * SKU 与品类的映射。Key=skuId，Value=categoryCode。
 *
 * 由 base data Workflow（切片 14 / 18）从 ERP 取出后传入，
 * 本文件不直接 query DB / MCP（保持纯函数）。
 */
export type SkuCategoryMap = ReadonlyMap<string, string>;

/**
 * matchTargets 入参（任务卡 §8.1）。
 *
 * - `items`：当前 draft 的全部 DraftItem 数组（可能为空）。
 * - `instruction`：LLM 抽取的 AdjustmentInstruction（targetType + targetValue）。
 * - `skuCategoryMap`：SKU → 品类映射（仅 CATEGORY_CODE 路径需要）。
 */
export interface MatchTargetsArgs {
  items: ReadonlyArray<DraftItem>;
  instruction: Pick<AdjustmentInstruction, 'targetType' | 'targetValue'>;
  skuCategoryMap?: SkuCategoryMap;
}

/**
 * 4 级匹配优先级（R-ADJ-002）。
 *
 * 路径选择（**严格依据 instruction.targetType；不得跨级别下钻**）：
 *   - `SKU_ID`        ：仅做 `it.skuId === targetValue` 精确匹配。
 *   - `SKU_KEYWORD`   ：先尝试 `it.skuName === targetValue`（精确），
 *                       命中即返回；否则尝试 `it.skuName.includes(targetValue)`（contains）。
 *                       —— 二者同属 R-ADJ-002 第 2、3 级；任务卡 §8.1 写法把它们放在 SKU_KEYWORD
 *                       一个分支内，先精确再模糊符合"短路"语义。
 *   - `CATEGORY_CODE` ：按 `skuCategoryMap.get(it.skuId) === targetValue` 过滤。
 *   - `ALL`           ：全量返回 items 拷贝（避免上层 mutate 原数组）。
 *
 * 约束：
 *   - **不会**在 SKU_ID 失败后回退到 SKU_KEYWORD / CATEGORY_CODE / ALL（短路 — 任务卡 §7 MUST DO §2）。
 *   - 0 命中由调用方判断（不在本函数抛错；保持纯函数语义）。
 *
 * @returns 受影响的 DraftItem 子数组（可能为空；保留原 items 中的对象引用，便于 applyAdjustment 进一步处理）
 */
export function matchTargets(args: MatchTargetsArgs): DraftItem[] {
  const { items, instruction } = args;
  const targetType = instruction.targetType;
  const targetValue = instruction.targetValue;

  switch (targetType) {
    case 'SKU_ID': {
      return items.filter((it) => it.skuId === targetValue);
    }
    case 'SKU_KEYWORD': {
      // 同级：先 skuName 精确，再 skuName contains（R-ADJ-002 第 2、3 级，仍属 SKU_KEYWORD 分支）
      const exact = items.filter((it) => it.skuName === targetValue);
      if (exact.length > 0) return exact;
      // 空 targetValue 拒绝模糊匹配（避免命中所有 SKU）
      if (targetValue.length === 0) return [];
      return items.filter((it) => it.skuName.includes(targetValue));
    }
    case 'CATEGORY_CODE': {
      const map = args.skuCategoryMap;
      if (!map || map.size === 0) return [];
      return items.filter((it) => map.get(it.skuId) === targetValue);
    }
    case 'ALL': {
      // 复制一层，避免上层 mutate 原数组导致 draft.items 被破坏
      return items.slice();
    }
    /* c8 ignore next 2 */
    default:
      return [];
  }
}

/* ============================================================================
 * 2) 6 种 op 应用（纯函数）
 * ========================================================================== */

/**
 * applyAdjustment 入参（任务卡 §8.2）。
 *
 * - `matched`：matchTargets 返回的子数组（**已经按 4 级匹配筛选过**）。
 * - `instruction`：完整的 AdjustmentInstruction（含 adjustmentType / rate / qty / createdAt / 等）。
 *
 * 注：本函数不再做 4 级匹配；调用顺序是 matchTargets → applyAdjustment。
 */
export interface ApplyAdjustmentArgs {
  matched: ReadonlyArray<DraftItem>;
  instruction: AdjustmentInstruction;
}

/**
 * 应用调整指令到匹配出的 DraftItem。
 *
 * 6 种 adjustmentType 公式（任务卡 §8.2）：
 *   - INCREASE_RATE  : `newQty = ceil(finalSuggestQty * (1 + rate))`
 *   - DECREASE_RATE  : `newQty = max(0, floor(finalSuggestQty * (1 - rate)))`
 *   - INCREASE_QTY   : `newQty = finalSuggestQty + qty`
 *   - DECREASE_QTY   : `newQty = max(0, finalSuggestQty - qty)`
 *   - SET_QTY        : `newQty = max(0, qty)`
 *   - EXCLUDE        : `newQty = 0`
 *
 * 负数保护（任务卡 §7 MUST DO §6）：所有路径均确保 newQty >= 0，
 * 即使 LLM 抽出 `adjustmentRate=-2`（"下调 200%"）或 `adjustmentQty=-50` 也不会出负数。
 *
 * 副作用：
 *   - 不修改入参 matched / its element；返回**全新对象数组**（不可变）。
 *   - adjustmentTrace 在原数组末尾追加一行 {@link buildTraceLine}（任务卡 §7 MUST DO §7）。
 *
 * 兜底：
 *   - rate 字段缺失：按 0 处理（不调整）；newQty 与原值一致（trace 仍追加便于审计）。
 *   - qty  字段缺失：按 0 处理（不调整）；同上。
 *   - 非有限数：按 0 处理（防 NaN / Infinity）。
 *
 * @returns 调整后的 DraftItem[]（与 matched 等长，不重排）
 */
export function applyAdjustment(args: ApplyAdjustmentArgs): DraftItem[] {
  const { matched, instruction } = args;
  const traceLine = buildTraceLine(instruction);

  return matched.map((it) => {
    const newQty = computeNewQty(it.finalSuggestQty, instruction);
    return {
      ...it,
      finalSuggestQty: newQty,
      adjustmentTrace: [...it.adjustmentTrace, traceLine],
    };
  });
}

/**
 * 单 SKU 应用 op 公式（导出供单测覆盖 6 种 op）。
 *
 * @param current  调整前 finalSuggestQty
 * @param ins      AdjustmentInstruction（adjustmentType / rate / qty）
 * @returns 调整后的非负整数 finalSuggestQty
 */
export function computeNewQty(
  current: number,
  ins: Pick<AdjustmentInstruction, 'adjustmentType' | 'adjustmentRate' | 'adjustmentQty'>,
): number {
  const safeCurrent = Number.isFinite(current) && current >= 0 ? Math.trunc(current) : 0;
  const rate = sanitizeRate(ins.adjustmentRate);
  const qty = sanitizeQty(ins.adjustmentQty);

  switch (ins.adjustmentType) {
    case 'INCREASE_RATE':
      return Math.max(0, Math.ceil(safeCurrent * (1 + rate)));
    case 'DECREASE_RATE':
      // 下调 rate（rate 应当为正数；rate=0.3 表示下调 30%）；负数 / NaN 已 sanitize
      return Math.max(0, Math.floor(safeCurrent * (1 - clampDecreaseRate(rate))));
    case 'INCREASE_QTY':
      return Math.max(0, safeCurrent + qty);
    case 'DECREASE_QTY':
      return Math.max(0, safeCurrent - Math.abs(qty));
    case 'SET_QTY':
      return Math.max(0, qty);
    case 'EXCLUDE':
      return 0;
    /* c8 ignore next 2 */
    default:
      return safeCurrent;
  }
}

/**
 * 拼接 adjustmentTrace 末尾追加的一行（任务卡 §7 MUST DO §7 / §8.2 示例）。
 *
 * 形态（中文）：
 *   `${adjustmentType}(<rate|qty>) by user @ ${createdAt}`
 *
 * 示例：
 *   `INCREASE_RATE(0.2) by user @ 2026-05-07T01:23:45.678+08:00`
 *   `EXCLUDE() by user @ 2026-05-07T01:23:45.678+08:00`
 */
export function buildTraceLine(ins: AdjustmentInstruction): string {
  const arg =
    ins.adjustmentRate !== undefined
      ? String(ins.adjustmentRate)
      : ins.adjustmentQty !== undefined
        ? String(ins.adjustmentQty)
        : '';
  return `${ins.adjustmentType}(${arg}) by user @ ${ins.createdAt}`;
}

/* ============================================================================
 * 3) 内部 helper
 * ========================================================================== */

/**
 * sanitize rate：缺失 / NaN / Infinity / -Infinity 一律视为 0；非数转 Number。
 *
 * 注：上层 Zod 已限定 -1..5（DECREASE 业务语义对应 0..1，但 schema 允许 -1..5 兜底）。
 */
function sanitizeRate(rate: number | undefined): number {
  if (rate === undefined || rate === null) return 0;
  if (!Number.isFinite(rate)) return 0;
  return rate;
}

/**
 * DECREASE_RATE 专用兜底：业务语义"下调 30%"对应 rate=0.3；
 * 若 LLM 抽出负数（误解为"上调 -30%"）也按绝对值处理避免出负。
 */
function clampDecreaseRate(rate: number): number {
  const abs = Math.abs(rate);
  return Math.min(1, abs);
}

/**
 * sanitize qty：缺失 / NaN / Infinity / -Infinity 一律视为 0；非整数取 trunc。
 */
function sanitizeQty(qty: number | undefined): number {
  if (qty === undefined || qty === null) return 0;
  if (!Number.isFinite(qty)) return 0;
  return Math.trunc(qty);
}
