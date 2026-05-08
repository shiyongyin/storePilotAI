/**
 * 切片 10 — OpenAI Chat Completions SSE chunk 协议（T-BRIDGE-03）
 *
 * 严格按 docs/tanks/10-bridge-sse-output-guard.md §8.1 + 任务卡 C-桥接层.md §T-BRIDGE-03 落地。
 *
 * 主要交付：
 *   1. {@link writeOpenAiChunk}：手写一条 OpenAI Chat Completions chunk（object='chat.completion.chunk'），
 *      并由 {@link SSEStreamingApi.writeSSE} 串行 flush；保证 LobeChat 实时收到 markdown 流。
 *   2. {@link writeDone}：终止顺序 `finish_reason='stop'` chunk → `data: [DONE]`（V2.1 红线 5 严格顺序）。
 *   3. {@link chunkByGrapheme}：按 grapheme cluster 切长 markdown，避免切到半个 emoji / 半个汉字。
 *
 * 协议红线（任务卡 §6 MUST DO + §7 MUST NOT）：
 *   - chunk object 名固定 `chat.completion.chunk`，model 固定 `store-agent-v1`，
 *     created 取秒级 unix 时间戳（与 OpenAI 官方协议 1:1）。
 *   - 终止顺序严格：先 `finish_reason='stop'` chunk → `data: [DONE]`；中途异常仍走此顺序，
 *     但内容用 `delta.content = '\n\n⚠️ ' + friendlyMessage(err)` 包装（禁返 OpenAI Error JSON 体）。
 *   - 长 markdown 默认按 320 字符（grapheme）切分，单 chunk 上限 800（任务卡 §7 MUST NOT §3）；
 *     由 {@link MAX_CHUNK_GRAPHEMES} 强守门，超过抛错（避免 WAF / 浏览器渲染塌陷）。
 *
 * @since 切片 10
 */
import type { SSEStreamingApi } from 'hono/streaming';

import { getGraphemeSplitter } from './grapheme.js';

/* ============================================================================
 * 1) 常量
 * ========================================================================== */

/**
 * chunk 的 object 名（OpenAI Chat Completions 协议固定值）。
 * 任意改动都会让 LobeChat 收不到流式响应（任务卡 §6 MUST DO §1）。
 */
export const CHAT_COMPLETION_CHUNK_OBJECT = 'chat.completion.chunk';

/** chunk 中固定的 model 字段（与 LobeChat 注册的 store-agent-v1 对齐） */
export const CHAT_COMPLETION_MODEL = 'store-agent-v1';

/** chunk id 前缀（OpenAI 兼容；后接 traceId） */
export const CHAT_COMPLETION_ID_PREFIX = 'chatcmpl-';

/** 默认每段 chunk 的 grapheme 数量（任务卡 §6 MUST DO §6） */
export const DEFAULT_CHUNK_GRAPHEMES = 320;

/** 单 chunk 上限（任务卡 §7 MUST NOT §3：超过对 WAF / 浏览器渲染不友好） */
export const MAX_CHUNK_GRAPHEMES = 800;

/* ============================================================================
 * 2) 协议类型
 * ========================================================================== */

/**
 * OpenAI Chat Completions chunk choice.delta 字段：
 *   - 进行中 chunk：`{ content: '...' }`
 *   - 终止 chunk：`{}`（finish_reason 由外层 choice 决定，非 delta）
 */
type ChoiceDelta = { content?: string };

/**
 * OpenAI Chat Completions chunk choice 对象（仅 V1 必需字段）。
 *
 * `finish_reason` 在进行中 chunk 必须为 `null`；终止 chunk 必须为 `'stop'`。
 */
interface ChunkChoice {
  index: 0;
  delta: ChoiceDelta;
  finish_reason: 'stop' | 'length' | null;
}

/**
 * OpenAI Chat Completions chunk 顶层 payload（与 OpenAI 官方协议 1:1，含必需字段）。
 *
 * 序列化后写入 `data: <json>`，由 LobeChat / curl -N 解析渲染。
 */
interface ChatCompletionChunkPayload {
  id: string;
  object: typeof CHAT_COMPLETION_CHUNK_OBJECT;
  created: number;
  model: string;
  choices: [ChunkChoice];
}

/* ============================================================================
 * 3) writeOpenAiChunk / writeDone
 * ========================================================================== */

/** {@link writeOpenAiChunk} 入参 */
export interface WriteChunkArgs {
  /**
   * chunk 唯一 id（建议传入 traceId）；与 `CHAT_COMPLETION_ID_PREFIX` 拼接为 `chatcmpl-<traceId>`。
   * 整次请求所有 chunk 共享同一 id（OpenAI 协议要求）。
   */
  id: string;
  /**
   * 进行中 chunk 的文本内容；`undefined` 时 `delta` 输出空对象 `{}`（用于终止 chunk）。
   */
  content?: string;
  /**
   * `'stop'` 表示正常终止；`'length'` 表示触发输出长度上限；`undefined` / 不传表示进行中。
   */
  finishReason?: 'stop' | 'length';
}

/**
 * 写一条 OpenAI Chat Completions SSE chunk 到下游。
 *
 * 协议要点：
 *   - 整条 chunk 的 SSE event 名缺省（默认 `message`）；只 `data: <json>`；中途心跳走独立 `event: ping`。
 *   - `created` 取调用时刻的 Unix 秒级时间戳（与 OpenAI 协议一致）。
 *   - 进行中 chunk：`delta = { content }`，`finish_reason = null`。
 *   - 终止 chunk：`delta = {}`，`finish_reason = 'stop' | 'length'`。
 *
 * @param stream Hono SSE 流；调用方需保证流未关闭（写已关闭流会被 Hono 吞掉，此函数不主动校验）。
 * @param args 见 {@link WriteChunkArgs}
 */
export async function writeOpenAiChunk(
  stream: SSEStreamingApi,
  args: WriteChunkArgs,
): Promise<void> {
  const delta: ChoiceDelta = args.content !== undefined ? { content: args.content } : {};
  const payload: ChatCompletionChunkPayload = {
    id: `${CHAT_COMPLETION_ID_PREFIX}${args.id}`,
    object: CHAT_COMPLETION_CHUNK_OBJECT,
    created: Math.floor(Date.now() / 1000),
    model: CHAT_COMPLETION_MODEL,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: args.finishReason ?? null,
      },
    ],
  };
  await stream.writeSSE({ data: JSON.stringify(payload) });
}

/** {@link writeDone} 入参 —— 仅 chunk id（与 writeOpenAiChunk 共享） */
export interface WriteDoneArgs {
  id: string;
}

/**
 * 终止 SSE 流：先发 `finish_reason='stop'` 的最后一条 chunk，再发 `data: [DONE]`。
 *
 * 任务卡 §6 MUST DO §2 严格顺序：缺任一步 LobeChat 都会等到超时（不显示完整回复）。
 * 中途异常的最后 chunk 应**先**写带友好话术的 `delta.content`，**再**调用本函数把 `finish_reason='stop'` + `[DONE]` 串接。
 *
 * @param stream Hono SSE 流
 * @param args 见 {@link WriteDoneArgs}
 */
export async function writeDone(stream: SSEStreamingApi, args: WriteDoneArgs): Promise<void> {
  await writeOpenAiChunk(stream, { id: args.id, finishReason: 'stop' });
  await stream.writeSSE({ data: '[DONE]' });
}

/* ============================================================================
 * 4) chunkByGrapheme
 * ========================================================================== */

/**
 * 按 grapheme cluster 切分长 markdown，避免切到半个 emoji 🎉 / 半个汉字。
 *
 * 任务卡 §6 MUST DO §6：
 *   - 默认 320 grapheme / 段（`size = DEFAULT_CHUNK_GRAPHEMES`）。
 *   - `size > MAX_CHUNK_GRAPHEMES` 抛错，强约束单段不超过 800（WAF / 渲染保护）。
 *   - `size <= 0` 抛错（避免无限循环）。
 *
 * @param text 原始 markdown；空串返回空数组（外层不会发空 chunk）。
 * @param size 单段 grapheme 数量；默认 {@link DEFAULT_CHUNK_GRAPHEMES} = 320。
 * @returns 切分后的字符串数组；每段 `splitGraphemes(...)` 长度 ≤ size。
 *
 * @throws RangeError size 超出 (0, {@link MAX_CHUNK_GRAPHEMES}] 范围时抛出（编程错误）。
 */
export function chunkByGrapheme(text: string, size: number = DEFAULT_CHUNK_GRAPHEMES): string[] {
  if (!Number.isInteger(size) || size <= 0 || size > MAX_CHUNK_GRAPHEMES) {
    throw new RangeError(
      `chunkByGrapheme size 必须是 (0, ${MAX_CHUNK_GRAPHEMES}] 内的整数，收到 ${size}`,
    );
  }
  if (text.length === 0) return [];

  const splitter = getGraphemeSplitter();
  const graphemes = splitter.splitGraphemes(text);
  const out: string[] = [];
  for (let i = 0; i < graphemes.length; i += size) {
    out.push(graphemes.slice(i, i + size).join(''));
  }
  return out;
}
