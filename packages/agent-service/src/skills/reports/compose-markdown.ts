import { generateObject } from 'ai';
import { z } from 'zod';

import { getEnv } from '../../config/env.js';
import { getModel } from '../../mastra/llm-provider.js';

const ComposeOutputSchema = z.object({
  markdown: z.string().min(1),
  cards: z.array(z.object({ key: z.string(), value: z.union([z.string(), z.number()]) })),
  abnormal: z.array(z.string()),
});

export type ComposeMarkdownResult = z.infer<typeof ComposeOutputSchema>;

interface ComposeMarkdownInput {
  promptName: 'daily' | 'monthly';
  template: string;
  inputJson: unknown;
  maxSummaryChars: number;
  maxCards: number;
}

export async function composeMarkdown(input: ComposeMarkdownInput): Promise<ComposeMarkdownResult> {
  const env = getEnv();
  const userPayload = JSON.stringify(input.inputJson, null, 2);
  const schema = z.object({
    markdown: z.string().min(1).max(input.maxSummaryChars),
    cards: z
      .array(
        z.object({
          key: z.string().min(1),
          value: z.union([z.string(), z.number()]),
        }),
      )
      .max(input.maxCards),
    abnormal: z.array(z.string()),
  });

  const result = await generateObject({
    model: getModel(),
    schema,
    system: input.template,
    prompt: `report_type=${input.promptName}\n\ntool_json:\n${userPayload}`,
    maxOutputTokens: env.MAX_OUTPUT_TOKENS,
    // DeepSeek / 通义 / 自建网关不支持 OpenAI structured outputs (json_schema) 协议；
    // 关掉后 ai-sdk 走基础 JSON mode（response_format=json_object，由 llm-provider fetch
    // middleware 降级），并由本地 zod schema parse 兜底。
    providerOptions: { openai: { structuredOutputs: false } },
  });

  return ComposeOutputSchema.parse(result.object);
}
