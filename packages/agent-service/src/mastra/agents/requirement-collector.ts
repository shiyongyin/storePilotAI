/**
 * 切片 06 — requirementCollector Agent（需求收集，V1 不写表）
 * 严格按 docs/任务卡/D-Mastra.md §T-MASTRA-01.5.3 + 切片 06 任务卡 §7 MUST DO §6 / §8.6 落地。
 *
 * V1 红线（违反即拒收）:
 *   - 不写任何数据库表（V1 不建 requirement_inbox 表，V2 自演化能力时再做）
 *   - 绝不可声称已落库 / 已分配 / 已排期
 *   - 仅以 markdown 提案 SSE 流给老板"我会发给运营评审"
 */
import { Agent } from '@mastra/core/agent';

import { getModel } from '../llm-provider.js';

export interface CollectRequirementProposalInput {
  originalText: string;
  merchantId: string;
  storeId: string;
}

function compactLine(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

/**
 * V1 纯转换：把老板原话转成 markdown 提案。
 *
 * 这里故意不接收 DB / repository / storage 参数，保证 V1 不产生 requirement_inbox 或 V2 工单写入路径。
 */
export function collectRequirementProposal(input: CollectRequirementProposalInput): string {
  const original = compactLine(input.originalText, 200);
  const summary = compactLine(input.originalText.replace(/^我希望|^我想要|^建议|^能不能/, ''), 50);
  return `## 需求摘要
${summary || '门店经营能力优化建议'}

## 老板原意
${original}

## 建议的实现要点
- 梳理适用商家与门店范围：${input.merchantId} / ${input.storeId}
- 明确触发条件、展示位置和提醒频率
- 由运营团队评审是否纳入后续版本

## 评估
- **优先级建议**：中（仅建议，最终由运营定）
- **预估影响范围**：门店 / 商家

> 我会把这个建议发给运营团队评审，老板您稍候。`;
}

export const requirementCollector = new Agent({
  id: 'requirementCollector',
  name: 'requirementCollector',
  description: '把"我希望要个 XX"的需求转写为 markdown 提案；V1 不入库，仅 SSE 流出',
  model: getModel(),
  instructions: `你是门店助手 Agent 的需求收集助手。

V1 铁律（违反一律拒收）：
1. **不写任何数据库表**。V1 此能力不入库，永远不可声称"已落库 / 已分配 / 已排期 / 已创建工单"。
2. 你的输出仅以 markdown 提案的形式 SSE 流给老板，并附一句："我会把这个建议发给运营团队评审"。
3. 不得承诺具体落地时间、不得编造工单编号、不得编造"已分配给 X"。

输出格式（严格 markdown）：
\`\`\`
## 需求摘要
<≤ 50 字一句话总结>

## 老板原意
<引用老板原话，≤ 200 字>

## 建议的实现要点
- 要点 1
- 要点 2
- 要点 3

## 评估
- **优先级建议**：低 / 中 / 高（仅建议，最终由运营定）
- **预估影响范围**：<门店 / 商家 / 平台>

> 我会把这个建议发给运营团队评审，老板您稍候。
\`\`\`

不得泄漏 tool_calls / function_call / 内部 sessionId / traceId。
`,
});
