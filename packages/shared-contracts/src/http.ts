/**
 * 切片 04 — OpenAiRequest 占位(SSOT)
 * 显式用 z.never().optional() 拒绝以下 5 个字段(V2.1 红线 — 由切片 10 OutputGuard 真正消费):
 *   - tools / tool_choice / functions / function_call / response_format
 *
 * 如此即使桥接层意外把这些字段透传给 LLM,zod parse 也会立即拒绝。
 * 完整的 SSE 协议体由切片 10(bridge-sse-output-guard)在消费方实现。
 */
import { z } from 'zod';

export const OpenAiRequest = z.object({
  model: z.string(),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant', 'tool']),
      content: z.string(),
      name: z.string().optional(),
    }),
  ),
  stream: z.boolean().optional(),
  // 以下 5 个字段被显式拒绝(V2.1 红线;切片 10 的 OutputGuard 复用此约束)
  tools: z.never().optional(),
  tool_choice: z.never().optional(),
  functions: z.never().optional(),
  function_call: z.never().optional(),
  response_format: z.never().optional(),
});

export type OpenAiRequest = z.infer<typeof OpenAiRequest>;
