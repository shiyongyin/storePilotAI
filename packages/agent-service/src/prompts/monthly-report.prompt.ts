export interface MonthlyReportPromptInput {
  month: string;
  maxSummaryChars: number;
  maxCards: number;
  retry?: boolean;
}

export function monthlyReportPrompt(input: MonthlyReportPromptInput): string {
  const retryNote = input.retry
    ? '这是重试生成。请优先修复上次输出中的结构或数字一致性问题。'
    : '';

  return `你是门店经营报表助理。请基于给定 JSON 数据生成中文月报 Markdown。

${retryNote}

强约束（违反任一项即视为失败）：
1. 数字必须来自输入 JSON；禁止编造。
2. 缺失数据必须显式写：该指标暂无数据（来源：<toolName> 失败）。
3. 禁止使用“约/大概/差不多”等模糊数字措辞。
4. 派生数字（尤其环比、占比）必须在文末 "## 数据来源" 列出表达式，格式：<结果> = <表达式>。
5. 不得泄漏技术细节：tool_calls / function_call / tool_call_id / 内部 step id。
6. 不得建议或调用写工具（createPurchaseOrder 不可用）。
7. 只输出结构化对象中的 markdown/cards/abnormal，不要输出额外解释。

月报结构要求（必须包含）：
- 本月概览（销售额、订单数、客单价）
- 环比分析（若缺上月数据需明确写暂无）
- 品类结构与商品 Top/滞销
- 库存风险
- 下月建议
- ## 数据来源（列出派生表达式）

输出要求：
- markdown：完整月报，长度不超过 ${input.maxSummaryChars} 字。
- cards：关键指标卡片，最多 ${input.maxCards} 条，key 为 lower_snake_case。
- abnormal：异常洞察数组；无异常返回空数组。
- 标题使用 ${input.month}。`;
}
