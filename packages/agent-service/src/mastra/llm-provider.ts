/**
 * 切片 06 — LLM provider 单例（OpenAI-Compatible / DeepSeek / 通义 / 自建网关通用）
 *
 * 严格按 docs/tanks/06-mastra-instance-tracing.md §7 MUST DO §11 / §12 +
 * §8.1.1 落地，并满足切片 06 §10 测试场景 §10-§12（DeepSeek baseURL 真实生效 / 单例幂等 /
 * 直 import 兜底）。
 *
 * 强约束（违反一律拒收）：
 *   - 所有 Agent / generateObject / generateText 调用方必须用本文件 {@link getModel}，
 *     不得 `import { openai } from '@ai-sdk/openai'` 直调（默认 `openai` 单例只读
 *     OPENAI_API_KEY 且固定指向 https://api.openai.com/v1，会无视 MODEL_BASE_URL）。
 *   - provider 必须缓存为单例；测试可调 {@link __resetLlmProviderForTest} 重置。
 *
 * @since 切片 06（V2.1 补丁：DeepSeek baseURL 接线）
 */
import { createOpenAI } from '@ai-sdk/openai';

import { getEnv } from '../config/env.js';

let _provider: ReturnType<typeof createOpenAI> | null = null;

/**
 * fetch 中间件：把 OpenAI Chat Completions 出口请求 body 中两类 OpenAI-only 字段降级为
 * 通用 OpenAI-Compatible 网关（DeepSeek / 通义 / 自建）能接住的形态。
 *
 * 1. **`role: 'developer'` → `role: 'system'`**
 *    @ai-sdk/openai@2.x 内部硬编码（dist/index.js:59-61）— modelId 不以 `gpt-3` /
 *    `gpt-4` / `chatgpt-4o` / `gpt-5-chat` 开头时被判为 OpenAI o1/o3 reasoning model，
 *    自动用 `developer` role 替代 `system`。DeepSeek 返回 422
 *    `unknown variant 'developer'`。
 *
 * 2. **`response_format: { type: 'json_schema', ... }` → `response_format: { type: 'json_object' }`**
 *    `generateObject` 默认下发 `json_schema` 模式（OpenAI structured outputs 协议）。
 *    DeepSeek 只支持 `json_object` 基础模式，对 `json_schema` 返回
 *    `This response_format type is unavailable now`。降级到 `json_object` 后由 ai-sdk
 *    的 zod parse 在客户端兜底校验。
 *
 * 仅改写 method=POST 且 body 含命中 token 的请求；其它请求透传。
 */
function createOpenAICompatibleFetch(): typeof fetch {
  return async (input, init) => {
    if (!init || init.method !== 'POST' || typeof init.body !== 'string') {
      return fetch(input, init);
    }
    const original = init.body;
    let patched = original;
    if (patched.includes('"role":"developer"')) {
      patched = patched.replace(/"role":"developer"/g, '"role":"system"');
    }
    if (patched.includes('"json_schema"')) {
      // 把整段 response_format 对象替换成 { "type": "json_object" }；用宽松 regex 跨整个 JSON 子对象。
      // 注意：JSON 嵌套深度由 ai-sdk 控制（schema 在 response_format.json_schema.schema）；用非贪婪
      // 匹配定位结尾的 `}` 不可靠，改用平衡括号扫描。
      patched = patched.replace(
        /"response_format":\s*\{/,
        '"response_format":{"__patch__":1,',
      );
      patched = collapseResponseFormatObject(patched);
    }
    if (patched === original) {
      return fetch(input, init);
    }
    return fetch(input, { ...init, body: patched });
  };
}

/**
 * 把已经被 marker `"__patch__":1` 标记的 `response_format` 对象整段替换为
 * `{"type":"json_object"}`（保留括号平衡，不破坏外层 JSON）。
 */
function collapseResponseFormatObject(body: string): string {
  const marker = '"response_format":{"__patch__":1,';
  const start = body.indexOf(marker);
  if (start < 0) return body;
  // 从 `{` 位置开始扫描平衡括号
  const openBraceAt = body.indexOf('{', start + '"response_format":'.length);
  let depth = 0;
  let i = openBraceAt;
  let inString = false;
  let escape = false;
  for (; i < body.length; i++) {
    const ch = body[i]!;
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        // i 指向 response_format 对象的结尾 `}`
        return (
          body.slice(0, openBraceAt) +
          '{"type":"json_object"}' +
          body.slice(i + 1)
        );
      }
    }
  }
  // 平衡扫描失败 → 退回 marker 移除（保留原对象，让对端拒错也比破坏 JSON 强）
  return body.replace('"__patch__":1,', '');
}

/**
 * 取 provider 单例。多次调用复用同一 OpenAI-Compatible 客户端。
 * 仅本文件内部使用；外部调用方应走 {@link getModel}。
 */
function getProvider(): ReturnType<typeof createOpenAI> {
  if (_provider) return _provider;
  const env = getEnv();
  _provider = createOpenAI({
    baseURL: env.MODEL_BASE_URL,
    apiKey: env.MODEL_API_KEY,
    // ai-sdk @ai-sdk/openai@2.x 内部硬编码：modelId 不以 gpt-3 / gpt-4 / chatgpt-4o /
    // gpt-5-chat 开头时，会把 system message 转成 `developer` role（OpenAI o1/o3 reasoning
    // model 协议）。DeepSeek / 通义 / 自建 OpenAI-Compatible 网关都不认 `developer` role，
    // 会返回 `unknown variant 'developer'` 422。这里用 fetch 拦截把出口 body 里的 developer
    // role 改回 system，让任意 OpenAI-Compatible 后端都能接住。
    fetch: createOpenAICompatibleFetch(),
  });
  return _provider;
}

/**
 * 取语言模型实例。Agent / Skill 必须用本函数，不得绕过。
 *
 * @param name 模型名（默认 `env.MODEL_NAME`，如 `deepseek-chat` / `qwen-plus`）
 * @returns 兼容 ai-sdk v5 generateText / generateObject / streamText 的语言模型实例。
 */
export function getModel(name: string = getEnv().MODEL_NAME): ReturnType<ReturnType<typeof createOpenAI>['chat']> {
  return getProvider().chat(name);
}

/**
 * 测试辅助：重置 provider 单例，避免用例间共享 baseURL/apiKey 缓存。
 * 仅在 vitest 中通过 `import.meta.env` / fake env 切换 baseURL 时调用。
 */
export function __resetLlmProviderForTest(): void {
  _provider = null;
}
