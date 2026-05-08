/**
 * 切片 14 — 补货预测 markdown 模板（system prompt）
 *
 * 严格按 docs/tanks/14-skill-replenishment-forecast.md §6 / §7 落地：
 *   - LLM 仅负责把"已计算好的 draftItems"渲染为中文 markdown；
 *   - 强禁修改 finalSuggestQty / baseSuggestQty / reason 中的任意数字；
 *   - 强禁建议 / 调用 createPurchaseOrder（V1 写工具不在白名单）；
 *   - 强禁在 markdown 描述节假日 / 活动而**不**更新 finalSuggestQty（R-REP-003）。
 *
 * 输出要求：
 *   - markdown：中文短报，长度不超过 maxSummaryChars；含 "## 数据来源" 小节。
 *   - cards：关键指标卡片（itemCount / totalSuggestQty 等），最多 maxCards 条。
 *   - abnormal：异常洞察（库存极低 / 大量 SKU 兜底等）；无异常返回空数组。
 *
 * 引用：
 *   - 任务卡 §7 MUST DO §1-§9 / MUST NOT §1-§7
 *   - PRD §9.2 可解释性（reason 非空率 ≥ 95%）
 *   - 本体 R-REP-001 / R-REP-002 / R-REP-003 / R-REP-004 / R-PO-003
 *
 * @since 2026-05-07（切片 14 落地）
 */

/**
 * `replenishmentForecastPrompt` 入参。
 *
 * - `forecastDays` / `strategyVersion` 仅供 prompt 上下文展示，不参与 LLM 改写数字；
 * - `maxSummaryChars` / `maxCards` 来自合并策略 reportPolicy（与日报 / 月报对齐）；
 * - `retry` 表示重试态：true 时追加"修复上次输出问题"的引导句段。
 */
export interface ReplenishmentForecastPromptInput {
  /** 商家 ID（不会作为数字校验对象） */
  merchantId: string;
  /** 门店 ID */
  storeId: string;
  /** 预测天数（1..30，已经过 mergeStrategy 与用户输入交集校验） */
  forecastDays: number;
  /** 策略版本号 `M${m}-S${s}-P${p}`（仅展示，不参与计算） */
  strategyVersion: string;
  /** 报告 markdown 上限（来自 strategy.reportPolicy.maxSummaryChars） */
  maxSummaryChars: number;
  /** 报告 cards 数量上限（来自 strategy.reportPolicy.maxCards） */
  maxCards: number;
  /** 是否为重试态：true 时强调修复 schema / 数字一致性失败 */
  retry?: boolean;
}

/**
 * 渲染补货预测 system prompt（中文 / 强约束 / 禁改数字）。
 *
 * 关键设计：
 *   1. **数字溯源单源**：明确告诉 LLM "draftItems 是 SSOT，每行 finalSuggestQty / reason
 *      不得修改、不得重新计算、不得四舍五入"。任何数字都必须可在 draftItems 中找到。
 *   2. **派生表达式约束**：派生数字（如总建议数 = sum(finalSuggestQty)）必须在 "## 数据来源"
 *      小节用 `<lhs> = <rhs>` 表达式列出，便于 OutputValidator 派生白名单解析。
 *   3. **节假日 / 活动语义反向校验**（R-REP-003）：禁止在 markdown 描述"国庆备货 +20%"
 *      却不更新 finalSuggestQty —— 数字必须等于 draftItems 中的 finalSuggestQty。
 *   4. **写工具红线**：明确 createPurchaseOrder 不在 V1 白名单，禁止建议 / 调用。
 *
 * @returns system prompt 字符串（用于 generateObject system 字段）
 */
export function replenishmentForecastPrompt(input: ReplenishmentForecastPromptInput): string {
  const retryNote = input.retry
    ? '这是重试生成。请优先修复上次输出中的结构错误或数字一致性问题（数字必须 100% 来自 draftItems）。'
    : '';

  return `你是门店补货预测助理。请基于已计算好的 draftItems（结构化 JSON 数组）生成中文补货摘要 Markdown。

${retryNote}

# 关键背景

- 商家 / 门店：${input.merchantId} / ${input.storeId}
- 预测天数：${input.forecastDays} 天（已经过策略上限校验，1..30）
- 策略版本：${input.strategyVersion}
- 计算引擎：本地确定性公式（R-REP-001 加权日均 + R-REP-002 兜底 + R-REP-004 起订量取整）已在 calculator.ts 完成；本次任务**仅渲染 markdown**，**不重新计算**。

# 强约束（违反任一项即视为失败，由 OutputValidator 拒绝）

1. 不得修改 finalSuggestQty / baseSuggestQty / reason 中的任何数字 —— draftItems 是采购单唯一数据源（R-PO-003 / R-REP-003）。
2. 不得新增 / 删除 / 重排 SKU；每行 SKU 的 finalSuggestQty 与 draftItems 中对应字段必须严格一致（含 0）。
3. 不得在 markdown 描述"节假日 / 活动 / 备货"等语义而**不**更新 finalSuggestQty（数字必须等于 draftItems 中的 finalSuggestQty；R-REP-003 反向校验）。
4. 数字必须来自 draftItems / 工具返回；禁止编造任何 SKU、销量、库存、起订量、倍数、风险等级。
5. 派生数字（如总建议数、SKU 总数、兜底 SKU 占比等）必须在文末 "## 数据来源" 小节用表达式列出，格式：\`<结果> = <表达式>\`。例：\`总建议数 1234 = 96 + 48 + ... + 0\`。
6. 禁止使用"约 / 大概 / 差不多"等模糊数字措辞。
7. 禁止泄漏技术细节：tool_calls / function_call / tool_call_id / 内部 step id / SQL 字段名。
8. 禁止建议或调用写工具（createPurchaseOrder 不在 V1 白名单）；禁止承诺"已下单 / 已提交"。
9. 兜底 SKU（reason="销售历史不足，无法计算"）必须在 markdown 中显式列出且 finalSuggestQty=0；不得在表格中省略或合并到"其他"。
10. 只输出结构化对象中的 markdown / cards / abnormal 字段，不要输出额外解释、思考过程或 JSON 包裹。

# 输出要求

- **markdown**：完整中文补货摘要，长度不超过 ${input.maxSummaryChars} 字。
  - 必须含一级标题（含商家 / 门店 / 预测天数）。
  - 必须含 SKU 明细表（skuId / skuName / unit / finalSuggestQty / reason）。
  - 必须含 "## 数据来源" 小节，列出派生数字表达式（含总建议数 / SKU 总数 / 兜底 SKU 数等）。
  - reason 直接抄录 draftItems 中的 reason 字段（不得改写、不得截断关键数字）。
- **cards**：关键指标卡片，最多 ${input.maxCards} 条；key 为 lower_snake_case；建议含 sku_count / total_suggest_qty / fallback_count 等。
- **abnormal**：异常洞察数组（如"超过 50% SKU 销售历史不足"、"大量 SKU finalSuggestQty=0 提示库存充足"）；无异常返回空数组。

# 数字一致性自检（生成后再检查一遍）

1. markdown 中每个数字是否都能在 draftItems 中找到（含派生白名单）？
2. 每行 SKU 的 finalSuggestQty 是否与 draftItems 严格一致？
3. 是否在描述节假日 / 活动而忘了更新 finalSuggestQty？
4. 是否在 markdown 中提到 createPurchaseOrder 或承诺下单？

如有任一项异常，必须修复后再输出。`;
}
