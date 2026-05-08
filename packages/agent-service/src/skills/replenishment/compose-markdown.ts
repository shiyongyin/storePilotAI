/**
 * 切片 14 — 补货预测 markdown 渲染（compose-markdown.ts）
 *
 * 严格按 docs/tanks/14-skill-replenishment-forecast.md §6 / §7 落地。
 *
 * 职责：
 *   - 接受 calculator 已计算好的 `draftItems`，调用 LLM 生成中文 markdown 摘要。
 *   - **不得让 LLM 修改任何数字**：finalSuggestQty / baseSuggestQty / reason 来自 calculator，
 *     compose-markdown 仅做"展示层渲染"。
 *   - 强约束由 prompt + Zod schema 双向把关；最终一致性由切片 11 的 `validateOutput`
 *     在 workflow 内做 Zod + 数字一致性校验（含 ## 数据来源 派生白名单解析）。
 *
 * 强约束（违反即拒收，与任务卡 §7 一一对应）：
 *   - **MUST NOT 让 LLM 输出 finalSuggestQty**：本文件 prompt 明确告知 SSOT 在 draftItems；
 *     output schema 仅保留 markdown / cards / abnormal 三段，**不**含 items 字段，
 *     避免任何旁路修改空间。
 *   - **MUST NOT 调用 createPurchaseOrder**：本文件不 import / 不引用任何写工具。
 *   - **MUST 数字一致性**：返回结果会被 workflow 的 `validateOutput` 校验，markdown 中
 *     非白名单数字会触发 BizError(NUMBER_INCONSISTENT)，由 workflow 重试 1 次。
 *
 * 与 `skills/reports/compose-markdown.ts` 关系：
 *   - 报告（日报 / 月报）的 composeMarkdown 用同一 LLM 模型 + generateObject 抽象；
 *     本文件复用相同模式，但 prompt template 与 inputJson 形态不同。
 *   - 不复用 `skills/reports/compose-markdown.ts` 的 `composeMarkdown` 是因为：
 *     1) reportPolicy 的 maxSummaryChars / maxCards 含义在两个 Skill 一致，但补货 prompt
 *        额外强调"draftItems 不可改"。
 *     2) abnormal 字段语义不同（报告：经营异常；补货：兜底 SKU 占比异常）。
 *
 * 引用：
 *   - 任务卡 §6 §7 §8.2
 *   - prompts/replenishment-forecast.prompt.ts（system prompt 全文）
 *   - safety/output-validator.ts（数字一致性校验入口）
 *
 * @since 2026-05-07（切片 14 落地）
 */
import { generateObject } from 'ai';
import { z } from 'zod';

import { getEnv } from '../../config/env.js';
import { getModel } from '../../mastra/llm-provider.js';
import {
  type ReplenishmentForecastPromptInput,
  replenishmentForecastPrompt,
} from '../../prompts/replenishment-forecast.prompt.js';

import type { ComputedSku } from './calculator.js';

/**
 * compose 输出形态（仅 markdown / cards / abnormal —— 不允许 LLM 输出 items / finalSuggestQty）。
 *
 * 设计原因：
 *   - LLM 不应输出"结构化 items 数组"——一旦输出，存在改写 finalSuggestQty 的旁路风险。
 *   - draftItems SSOT 由 workflow.persistDraftStep 直接从 calculator 结果转换并落库，
 *     compose-markdown 只触达 markdown / cards / abnormal 三段。
 *   - cards 的 value 限定为 string | number；不允许复杂对象，避免数字泄漏路径。
 */
const ComposeOutputSchema = z.object({
  markdown: z.string().min(1),
  cards: z
    .array(
      z.object({
        key: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/, 'card.key 必须 lower_snake_case'),
        value: z.union([z.string(), z.number()]),
      }),
    )
    .max(50),
  abnormal: z.array(z.string()).default([]),
});

export type ReplenishmentForecastComposeResult = z.infer<typeof ComposeOutputSchema>;

/**
 * compose 入参形态。
 *
 * - `draftItems`：calculator 已算好的结构化数组；prompt 会把它原样 JSON 序列化喂给 LLM，
 *   要求 LLM 仅做展示层渲染（数字 / SKU 行不可改）。
 * - `prompt`：来自 {@link replenishmentForecastPrompt}，含 forecastDays / strategyVersion /
 *   maxSummaryChars / maxCards 等上下文。
 */
export interface ComposeReplenishmentMarkdownInput {
  draftId: string;
  status: string;
  prompt: ReplenishmentForecastPromptInput;
  draftItems: ReadonlyArray<ComputedSku>;
}

/**
 * 调用 LLM 渲染补货预测 markdown。
 *
 * 流程：
 *   1. 用 `replenishmentForecastPrompt` 构造 system prompt（含强约束 11 条）。
 *   2. 用 `generateObject({ schema, system, prompt })` 让 LLM 输出结构化 JSON
 *      （schema = `ComposeOutputSchema`：仅 markdown / cards / abnormal）。
 *   3. 把 draftItems 完整 JSON 化作为 `prompt`，明确告知 LLM "数字以此为准，不得修改"。
 *   4. 严格 Zod parse；workflow 在外层再做数字一致性校验（含 ## 数据来源 派生白名单）。
 *
 * @param input 含 draftId / status / prompt 上下文 / draftItems 结构化数据
 * @returns markdown / cards / abnormal 三段 LLM 输出（数字一致性由 workflow 外层校验）
 */
export async function composeReplenishmentMarkdown(
  input: ComposeReplenishmentMarkdownInput,
): Promise<ReplenishmentForecastComposeResult> {
  const env = getEnv();

  const userPayload = JSON.stringify(
    {
      draftId: input.draftId,
      status: input.status,
      forecastDays: input.prompt.forecastDays,
      strategyVersion: input.prompt.strategyVersion,
      // SSOT：LLM 必须以此为准；任何数字改写都会被 OutputValidator 拒绝
      draftItems: input.draftItems.map((it) => ({
        skuId: it.skuId,
        skuName: it.skuName,
        unit: it.unit,
        baseSuggestQty: it.baseSuggestQty,
        finalSuggestQty: it.finalSuggestQty,
        reason: it.reason,
        riskLevel: it.riskLevel,
      })),
    },
    null,
    2,
  );

  // 用 prompt schema 做"输出上限"动态收紧（避免长度超过策略 reportPolicy.maxSummaryChars）
  const schema = z.object({
    markdown: z.string().min(1).max(input.prompt.maxSummaryChars),
    cards: z
      .array(
        z.object({
          key: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/, 'card.key 必须 lower_snake_case'),
          value: z.union([z.string(), z.number()]),
        }),
      )
      .max(input.prompt.maxCards),
    abnormal: z.array(z.string()).default([]),
  });

  const result = await generateObject({
    model: getModel(),
    schema,
    system: replenishmentForecastPrompt(input.prompt),
    prompt: `task=replenishment_forecast\n\nssot_json:\n${userPayload}`,
    maxOutputTokens: env.MAX_OUTPUT_TOKENS,
    // DeepSeek / 通义 / 自建网关不支持 OpenAI structured outputs；走 JSON mode + zod parse 兜底。
    providerOptions: { openai: { structuredOutputs: false } },
  });

  return ComposeOutputSchema.parse(result.object);
}
