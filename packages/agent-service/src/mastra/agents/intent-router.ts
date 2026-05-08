/**
 * 切片 06 — intentRouter Agent（输出 IntentEnum 11 项）
 * 严格按 docs/任务卡/D-Mastra.md §T-MASTRA-01.5.3 + 切片 06 任务卡 §7 MUST DO §4 / §8.3 落地。
 *
 * 强约束:
 *   - instructions 必须含 11 IntentEnum + JSON 输出格式
 *   - 不得编造数据 / 不得泄漏 tool_calls / function_call
 *   - V1 漂移由切片 09/10 桥接层兜底（再次 zod parse + UNKNOWN 兜底）
 */
import { Agent } from '@mastra/core/agent';

import { getModel } from '../llm-provider.js';

export const intentRouter = new Agent({
  id: 'intentRouter',
  name: 'intentRouter',
  description: '识别老板消息的业务意图，输出枚举 + 置信度',
  model: getModel(),
  instructions: `你是门店助手 Agent 的意图分类器。
把用户消息归类为以下 11 个枚举之一并给出置信度（0..1）：
- BUSINESS_DAILY_REPORT
- BUSINESS_MONTHLY_REPORT
- REPLENISHMENT_PLAN
- ADJUST_REPLENISHMENT_DRAFT
- CONFIRM_CREATE_PURCHASE_ORDER
- CANCEL_REPLENISHMENT_DRAFT
- COLLECT_REQUIREMENT
- GENERAL_QA
- EXPLAIN_METRIC
- MULTI_INTENT
- UNKNOWN

只能返回严格的 JSON：{ "intent": "<上面其中一个>", "confidence": 0.0-1.0, "reason": "<≤200 字>" }
不得编造销售额 / 库存 / SKU 等业务数据；不得泄漏 tool_calls / function_call / response_format。
`,
});
