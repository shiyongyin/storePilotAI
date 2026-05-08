/**
 * 切片 14 — 补货预测确定性公式（calculator.ts，纯函数）
 *
 * 严格按 docs/tanks/14-skill-replenishment-forecast.md §7-§8 + 任务卡 E-Skill.md §T-SKILL-03.5 落地。
 *
 * 公开能力：
 *   - {@link computeSku}：单 SKU 建议数计算（纯函数；输入 → 输出确定）。
 *   - {@link roundToOrderRules}：起订量 / 倍数取整（R-REP-004）。
 *   - {@link makeReason}：拼接非空 reason 字符串（s7 / s14 / s30 / demandFactor / finalSuggestQty）。
 *   - {@link weightedAvgDailySales}：R-REP-001 加权日均（0.5 / 0.3 / 0.2 三段权重）。
 *
 * 强约束（违反即拒收，与任务卡 §7 一一对应）：
 *   - **MUST 纯函数**：本文件不得 import / 调用任何 await / fetch / mcp / openai / db / random
 *     —— 50 案例单测必须可在毫秒内重放，CI 通过 grep 守门（任务卡 §9 步骤 8）。
 *   - **R-REP-001 加权日均**：固定权重 `0.5 / 0.3 / 0.2`（不许改）。
 *   - **R-REP-002 兜底**：销售历史不足（`salesAvg7d` undefined/0 且 `recentSalesByDay.length < 7`）
 *     → `finalSuggestQty=0` + `reason="销售历史不足，无法计算"` + `riskLevel='MEDIUM'`。
 *   - **R-REP-004 起订量 / 倍数**：必须经 {@link roundToOrderRules}，不得跳过。
 *   - **`reason` 非空率 ≥ 95%**：本文件保证除"销售历史不足"分支外任意路径 reason 均非空，
 *     由集成测试采样统计落地（任务卡 §9 步骤 5）。
 *   - **不得让 LLM 直接输出 `finalSuggestQty`**：本文件计算结果是 SSOT，
 *     compose-markdown 仅渲染 markdown，不得改数字（R-PO-003）。
 *
 * 引用：
 *   - 任务卡 §5 / §7 / §8.1 / §10
 *   - E-Skill.md §T-SKILL-03.5
 *   - 本体 R-REP-001 / R-REP-002 / R-REP-003 / R-REP-004
 *   - shared-contracts/mcp/queryReplenishmentBaseData.ts（ReplenishmentBaseItem SSOT）
 */
import type { ReplenishmentBaseItem } from '@storepilot/shared-contracts/mcp';

/**
 * 单 SKU 计算结果（calculator → workflow → DraftItem 的中间形态）。
 *
 * - 与 `shared-contracts/drafts.ts` 的 {@link DraftItem} 字段对齐，但额外携带 `riskLevel` /
 *   `adjustmentTrace`。`adjustmentTrace` 在切片 14 仅返回空数组（占位），切片 15 调整 Skill
 *   会向其追加 trace 行。
 * - `finalSuggestQty` 是采购单的唯一数据源（R-PO-003）；任何下游不得从 markdown 反解析数字。
 */
export interface ComputedSku {
  /** SKU 唯一编码（来自 ERP 基础数据） */
  skuId: string;
  /** SKU 名称（中文） */
  skuName: string;
  /** 计量单位（瓶/箱/包...） */
  unit: string;
  /** 公式直接计算结果（未经起订量 / 倍数取整） */
  baseSuggestQty: number;
  /** 经 {@link roundToOrderRules} 取整后的最终建议数（采购单写工具读取此字段） */
  finalSuggestQty: number;
  /** 非空 reason（含 s7 / s14 / s30 实际数 + demandFactor + finalSuggestQty）；
   *  R-REP-002 兜底分支固定为 "销售历史不足，无法计算"。 */
  reason: string;
  /** 风险等级：finalSuggestQty 是否超过 avgDailySales × 14（默认 LOW；超过 MEDIUM） */
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  /** 调整追踪（切片 14 占位空数组；切片 15 调整 Skill 写入 trace） */
  adjustmentTrace: string[];
}

/**
 * 计算策略（来自 mergeStrategy + 物料级 ERP 数据）。
 *
 * - `forecastDays` / `safetyStockDays`：来自 `strategy.replenishmentPolicy`（mergeStrategy 合并后）；
 *   workflow 必须经 mergeStrategy 取值，禁止 hard-code（任务卡 §7 MUST DO §8）。
 * - `minOrderQty` / `orderMultiple`：来自 `ReplenishmentBaseItem` 的物料级字段；
 *   `orderMultiple` 由 `packSize` 提供（含 default(1)）。`minOrderQty` 当前 contract 未声明，
 *   workflow 透传 `it.minOrderQty`（可能 undefined）保留向前兼容。
 */
export interface ComputeStrategy {
  /** 预测天数（1..30，由 mergeStrategy / 用户输入交集决定） */
  forecastDays: number;
  /** 安全库存天数（来自 strategy.replenishmentPolicy.safetyStockDays） */
  safetyStockDays: number;
  /** 起订量（可选；undefined → 1） */
  minOrderQty?: number | undefined;
  /** 订单倍数（可选；undefined → 1；通常等于 packSize） */
  orderMultiple?: number | undefined;
}

/**
 * 上下文因子（来自 `queryReplenishmentBaseData.contextFactors`）。
 *
 * 当前仅消费 `isHolidayUpcoming`：true → demandFactor=1.1；false → demandFactor=1.0。
 * `weatherTrend` 在 V1 不参与公式计算（保留供 V2 演化）。
 */
export interface ContextFactors {
  /** 是否临近节假日（来自 ERP；true 触发 1.1 倍需求放大） */
  isHolidayUpcoming: boolean;
}

/**
 * `computeSku` 的完整入参类型。`it` 在 `ReplenishmentBaseItem` 基础上扩展三个 sales 平均字段
 * 与可选 `minOrderQty`，便于灰度阶段 ERP 直接预聚合返回，免去 calculator 内反复求平均。
 */
export interface ComputeSkuInput {
  it: ReplenishmentBaseItem & {
    /** 7 日均销（可选；缺失时本函数从 recentSalesByDay 末 7 元素求均） */
    salesAvg7d?: number | undefined;
    /** 14 日均销（可选；同上） */
    salesAvg14d?: number | undefined;
    /** 30 日均销（可选；同上） */
    salesAvg30d?: number | undefined;
    /** 物料级起订量（可选；缺失时 strategy.minOrderQty 兜底；再缺则 1） */
    minOrderQty?: number | undefined;
  };
  strategy: ComputeStrategy;
  contextFactors: ContextFactors;
}

/* ============================================================================
 * 公式辅助：纯算术、无副作用
 * ========================================================================== */

/**
 * 数组算术平均；空数组回退 0。
 *
 * 用于 `recentSalesByDay` 末段切片（slice(-7) / slice(-14) / slice(-30)）的兜底求均。
 *
 * @param xs 销量序列（非空数子集）
 * @returns 平均值（空数组返回 0）
 */
export function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/**
 * R-REP-001 加权日均（固定权重 0.5 / 0.3 / 0.2，不得修改）。
 *
 * 规则（任务卡 §5 / §8.1）：
 *   - `s7 = salesAvg7d ?? avg(recentSalesByDay.slice(-7))`
 *   - `s14 = salesAvg14d ?? avg(recentSalesByDay.slice(-14))`
 *   - `s30 = salesAvg30d ?? avg(recentSalesByDay.slice(-30))`
 *   - `avgDailySales = s7 * 0.5 + s14 * 0.3 + s30 * 0.2`
 *
 * 设计原因：
 *   - 7 日权重高于 14/30 日，反映短期波动主导；
 *   - 30 日提供长期均值，避免短期极端值放大；
 *   - 三段加和 = 1.0，整体仍为日均量纲。
 *
 * @param it `computeSku` 的物料项（含可选 sales 平均字段 + recentSalesByDay）
 * @returns 三段实际数与加权日均，便于 reason 拼接 + 单测断言
 */
export function weightedAvgDailySales(it: ComputeSkuInput['it']): {
  s7: number;
  s14: number;
  s30: number;
  avgDailySales: number;
} {
  const s7 = it.salesAvg7d ?? avg((it.recentSalesByDay ?? []).slice(-7));
  const s14 = it.salesAvg14d ?? avg((it.recentSalesByDay ?? []).slice(-14));
  const s30 = it.salesAvg30d ?? avg((it.recentSalesByDay ?? []).slice(-30));
  const avgDailySales = s7 * 0.5 + s14 * 0.3 + s30 * 0.2;
  return { s7, s14, s30, avgDailySales };
}

/**
 * R-REP-004 起订量 / 倍数取整。
 *
 * 规则（任务卡 §5 / §8.1 / §10 测试场景 3）：
 *   - `qty <= 0` → 0；不补到起订量（语义：本期不下单）。
 *   - 否则 `rounded = max(minOrderQty ?? 1, qty)`；若 `orderMultiple > 1`
 *     再 `Math.ceil(rounded / mul) * mul` 向上对齐到倍数。
 *   - 保证返回值是非负整数。
 *
 * 边界用例：
 *   - `roundToOrderRules(38, { forecastDays:7, safetyStockDays:2, minOrderQty:24, orderMultiple:12 }) === 48`
 *   - `roundToOrderRules(0,  { ... minOrderQty:24, orderMultiple:12 }) === 0`（不下单）
 *   - `roundToOrderRules(10, { ... minOrderQty:24, orderMultiple:12 }) === 24`（拉到起订量）
 *
 * @param qty 公式直接结果（baseSuggestQty）
 * @param strategy 含 minOrderQty / orderMultiple 的策略对象
 * @returns 取整后的最终建议数（>= 0 整数）
 */
export function roundToOrderRules(qty: number, strategy: ComputeStrategy): number {
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  const min = strategy.minOrderQty ?? 1;
  const mul = strategy.orderMultiple ?? 1;
  let rounded = Math.max(min, qty);
  if (mul > 1) rounded = Math.ceil(rounded / mul) * mul;
  return Math.max(0, Math.trunc(rounded));
}

/**
 * 拼接非空 reason 字符串（任务卡 §7 MUST DO §6 / §8.1）。
 *
 * 输出形态（中文，固定结构便于 reason 非空率统计与运维巡检）：
 *   "近 7/14/30 日均销 {s7}/{s14}/{s30}，加权日均 {avgDailySales}，
 *    节假日因子 {demandFactor}，公式建议 {baseSuggestQty}，最终建议 {finalSuggestQty}。"
 *
 * 数字保留 2 位小数（避免 0.30000000000000004 噪音）；整数路径无尾随 .00。
 *
 * @returns 非空 reason 字符串（长度 ≤ 200 命中 DraftItem.reason.max(200)）
 */
export function makeReason(args: {
  s7: number;
  s14: number;
  s30: number;
  avgDailySales: number;
  demandFactor: number;
  baseSuggestQty: number;
  finalSuggestQty: number;
}): string {
  const fmt = (n: number): string => {
    if (Number.isInteger(n)) return String(n);
    return Number(n.toFixed(2)).toString();
  };
  return [
    `近 7/14/30 日均销 ${fmt(args.s7)}/${fmt(args.s14)}/${fmt(args.s30)}`,
    `加权日均 ${fmt(args.avgDailySales)}`,
    `节假日因子 ${fmt(args.demandFactor)}`,
    `公式建议 ${fmt(args.baseSuggestQty)}`,
    `最终建议 ${fmt(args.finalSuggestQty)}`,
  ].join('，') + '。';
}

/* ============================================================================
 * computeSku：单 SKU 完整计算（纯函数）
 * ========================================================================== */

/**
 * R-REP-002 兜底判定（任务卡 §5）：销售历史不足。
 *
 * 条件（**与即**）：
 *   1. `salesAvg7d` 未提供（undefined）**或** 等于 0
 *   2. `recentSalesByDay.length < 7`
 *
 * 命中即返回 `finalSuggestQty=0` + 固定 reason。
 *
 * @returns `true` 表示销售历史不足
 */
function isInsufficientSalesHistory(it: ComputeSkuInput['it']): boolean {
  const lacksSalesAvg7d = it.salesAvg7d === undefined || it.salesAvg7d === 0;
  const recentLen = it.recentSalesByDay?.length ?? 0;
  return lacksSalesAvg7d && recentLen < 7;
}

/**
 * 单 SKU 建议数计算（纯函数）。
 *
 * 流程：
 *   1. R-REP-002 兜底：销售历史不足 → 直接返回 0 + 固定 reason + MEDIUM 风险；不进入加权日均。
 *   2. R-REP-001 加权日均：`s7/s14/s30` 三段加权（0.5/0.3/0.2）。
 *   3. 节假日因子：`isHolidayUpcoming=true` → 1.1；否则 1.0。
 *   4. 期望需求：`avgDailySales × forecastDays × demandFactor`。
 *   5. 安全库存：`avgDailySales × safetyStockDays`。
 *   6. 基础建议：`max(0, ceil(expectedDemand + safetyStock - onHandQty - inTransitQty))`。
 *   7. R-REP-004 起订量 / 倍数取整：调用 {@link roundToOrderRules}。
 *   8. 风险评级：`finalSuggestQty > avgDailySales * 14` → MEDIUM；否则 LOW。
 *
 * 强约束（任务卡 §7 MUST/MUST NOT）：
 *   - 不在本函数内 await / fetch / mcp / openai / random（保持纯函数）。
 *   - 不让 LLM 改 finalSuggestQty（compose-markdown 只读不写）。
 *   - reason 非空率 ≥ 95%：本函数所有非兜底路径都返回完整 reason。
 *
 * @param args.it              单 SKU 基础数据 + 可选 sales 平均字段
 * @param args.strategy        含 forecastDays / safetyStockDays / minOrderQty / orderMultiple
 * @param args.contextFactors  含 isHolidayUpcoming（其余字段当前不参与计算）
 * @returns 完整 ComputedSku（含 finalSuggestQty / reason / riskLevel）
 */
export function computeSku(args: ComputeSkuInput): ComputedSku {
  const { it, strategy, contextFactors } = args;

  // —— 1) R-REP-002 兜底：销售历史不足
  if (isInsufficientSalesHistory(it)) {
    return {
      skuId: it.skuId,
      skuName: it.skuName,
      unit: it.unit,
      baseSuggestQty: 0,
      finalSuggestQty: 0,
      reason: '销售历史不足，无法计算',
      riskLevel: 'MEDIUM',
      adjustmentTrace: [],
    };
  }

  // —— 2) R-REP-001 加权日均
  const { s7, s14, s30, avgDailySales } = weightedAvgDailySales(it);

  // —— 3) 节假日因子
  const demandFactor = contextFactors.isHolidayUpcoming ? 1.1 : 1.0;

  // —— 4) 期望需求
  const expectedDemand = avgDailySales * strategy.forecastDays * demandFactor;

  // —— 5) 安全库存
  const safetyStock = avgDailySales * strategy.safetyStockDays;

  // —— 6) 基础建议（非负整数）
  const onHandQty = it.onHandQty ?? 0;
  const inTransitQty = it.inTransitQty ?? 0;
  const baseSuggestQty = Math.max(
    0,
    Math.ceil(expectedDemand + safetyStock - onHandQty - inTransitQty),
  );

  // —— 7) R-REP-004 起订量 / 倍数取整
  const finalSuggestQty = roundToOrderRules(baseSuggestQty, strategy);

  // —— 8) 风险评级
  const riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' =
    finalSuggestQty > avgDailySales * 14 ? 'MEDIUM' : 'LOW';

  return {
    skuId: it.skuId,
    skuName: it.skuName,
    unit: it.unit,
    baseSuggestQty,
    finalSuggestQty,
    reason: makeReason({
      s7,
      s14,
      s30,
      avgDailySales,
      demandFactor,
      baseSuggestQty,
      finalSuggestQty,
    }),
    riskLevel,
    adjustmentTrace: [],
  };
}
