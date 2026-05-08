/**
 * 切片 10 §9 验收 step 1-8 + §10 测试场景 1-6 — sse.ts 单测
 *
 * 覆盖（§9 13 步中纯协议路径）：
 *   - chunk object 名 = 'chat.completion.chunk'（§9 step 2）
 *   - 终止顺序：finish_reason='stop' chunk → data: [DONE]（§9 step 3）
 *   - 长 markdown grapheme 切分（§9 step 8）：5000 字符 + emoji 🎉 → 16 段，每段 ≤ 320 不切到半个 emoji
 *   - chunkByGrapheme 边界：空串 / size > MAX / size <= 0
 *
 * 测试基础设施：
 *   - FakeSSEStream：捕获 writeSSE 入参，模拟 hono SSEStreamingApi 最小接口；
 *     不 mock 整个 hono streaming，避免与 hono 内部 TransformStream 耦合。
 */
import { describe, expect, it } from 'vitest';

import {
  CHAT_COMPLETION_CHUNK_OBJECT,
  CHAT_COMPLETION_ID_PREFIX,
  CHAT_COMPLETION_MODEL,
  DEFAULT_CHUNK_GRAPHEMES,
  MAX_CHUNK_GRAPHEMES,
  chunkByGrapheme,
  writeDone,
  writeOpenAiChunk,
} from './sse.js';

/**
 * Hono SSEStreamingApi 的最小子集（仅 writeSSE）；
 * 测试不需要触达 abort / sleep 等扩展能力。
 */
interface FakeSSEMessage {
  data: string | Promise<string>;
  event?: string;
  id?: string;
  retry?: number;
}

class FakeSSEStream {
  public readonly writes: FakeSSEMessage[] = [];

  writeSSE(message: FakeSSEMessage): Promise<void> {
    this.writes.push(message);
    return Promise.resolve();
  }
}

/**
 * 解析一条 chunk 的 `data:` 字段为 JSON（writeOpenAiChunk 写出的均为 OpenAI chunk JSON）。
 */
function parseChunk(message: FakeSSEMessage): {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { content?: string };
    finish_reason: 'stop' | 'length' | null;
  }>;
} {
  expect(typeof message.data).toBe('string');
  const data = message.data as string;
  return JSON.parse(data) as ReturnType<typeof parseChunk>;
}

describe('切片 10 — writeOpenAiChunk', () => {
  it('chunk object 必须等于 "chat.completion.chunk"（§9 step 2）', async () => {
    const stream = new FakeSSEStream();
    await writeOpenAiChunk(stream as never, {
      id: 'trace_xyz',
      content: '今天 S001 销售 1200 元',
    });
    expect(stream.writes).toHaveLength(1);
    const payload = parseChunk(stream.writes[0]!);
    expect(payload.object).toBe(CHAT_COMPLETION_CHUNK_OBJECT);
    expect(payload.object).toBe('chat.completion.chunk');
  });

  it('chunk id 必须为 chatcmpl-<traceId> + model 固定 store-agent-v1', async () => {
    const stream = new FakeSSEStream();
    await writeOpenAiChunk(stream as never, { id: 'trace_abc', content: 'hi' });
    const payload = parseChunk(stream.writes[0]!);
    expect(payload.id).toBe(`${CHAT_COMPLETION_ID_PREFIX}trace_abc`);
    expect(payload.model).toBe(CHAT_COMPLETION_MODEL);
  });

  it('进行中 chunk：delta.content = content，finish_reason 为 null', async () => {
    const stream = new FakeSSEStream();
    await writeOpenAiChunk(stream as never, { id: 't1', content: 'hello' });
    const payload = parseChunk(stream.writes[0]!);
    expect(payload.choices[0]?.delta).toEqual({ content: 'hello' });
    expect(payload.choices[0]?.finish_reason).toBeNull();
    expect(payload.choices[0]?.index).toBe(0);
  });

  it('终止 chunk：finishReason="stop" → delta = {}，finish_reason="stop"', async () => {
    const stream = new FakeSSEStream();
    await writeOpenAiChunk(stream as never, { id: 't2', finishReason: 'stop' });
    const payload = parseChunk(stream.writes[0]!);
    expect(payload.choices[0]?.delta).toEqual({});
    expect(payload.choices[0]?.finish_reason).toBe('stop');
  });

  it('content="" 不应误判为 undefined（仍走 content 分支）', async () => {
    const stream = new FakeSSEStream();
    await writeOpenAiChunk(stream as never, { id: 't3', content: '' });
    const payload = parseChunk(stream.writes[0]!);
    expect(payload.choices[0]?.delta).toEqual({ content: '' });
    expect(payload.choices[0]?.finish_reason).toBeNull();
  });

  it('created 字段必须是秒级 Unix 时间戳（与 Date.now/1000 接近）', async () => {
    const stream = new FakeSSEStream();
    const before = Math.floor(Date.now() / 1000);
    await writeOpenAiChunk(stream as never, { id: 't4', content: 'x' });
    const after = Math.floor(Date.now() / 1000);
    const payload = parseChunk(stream.writes[0]!);
    expect(payload.created).toBeGreaterThanOrEqual(before);
    expect(payload.created).toBeLessThanOrEqual(after);
  });
});

describe('切片 10 — writeDone（终止顺序 §9 step 3）', () => {
  it('writeDone 必须先发 finish_reason=stop chunk，再发 data: [DONE]（顺序严格）', async () => {
    const stream = new FakeSSEStream();
    await writeDone(stream as never, { id: 'trace_done' });
    expect(stream.writes).toHaveLength(2);

    // 第一条：finish_reason='stop' chunk
    const finishChunk = parseChunk(stream.writes[0]!);
    expect(finishChunk.object).toBe('chat.completion.chunk');
    expect(finishChunk.choices[0]?.finish_reason).toBe('stop');
    expect(finishChunk.choices[0]?.delta).toEqual({});

    // 第二条：data: [DONE]
    expect(stream.writes[1]?.data).toBe('[DONE]');
  });
});

describe('切片 10 — chunkByGrapheme（§9 step 8 / §10.5-6）', () => {
  it('空字符串返回空数组', () => {
    expect(chunkByGrapheme('', 320)).toEqual([]);
  });

  it('短文本（< size）返回单段', () => {
    const out = chunkByGrapheme('短消息', 320);
    expect(out).toEqual(['短消息']);
  });

  it('5000 字符 ascii 文本默认 320 切分 → 16 段，每段 ≤ 320', () => {
    const text = 'a'.repeat(5000);
    const out = chunkByGrapheme(text, DEFAULT_CHUNK_GRAPHEMES);
    expect(out.length).toBe(Math.ceil(5000 / 320)); // 16
    for (const c of out) expect(c.length).toBeLessThanOrEqual(320);
    expect(out.join('')).toBe(text);
  });

  it('emoji 🎉 不被切到半个（grapheme 边界）', () => {
    // 32 个 🎉（每个 emoji = 1 grapheme = 2 UTF-16 code unit）
    const text = '🎉'.repeat(32);
    // 要求每段 4 grapheme（=4 emoji），共 8 段；切分后每段 8 UTF-16 char
    const out = chunkByGrapheme(text, 4);
    expect(out).toHaveLength(8);
    for (const segment of out) {
      // 拆分后每段应当能被无损解析回 emoji（不包含半个 surrogate pair）
      expect([...segment].length).toBe(4);
      // 不应出现孤立 high surrogate（0xD800-0xDBFF）末尾
      const last = segment.charCodeAt(segment.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
    expect(out.join('')).toBe(text);
  });

  it('混合 ascii + emoji + CJK 不丢字符', () => {
    const text = '【日报】今天卖了 12 单 🎉，毛利 3500 元。' + 'a'.repeat(100);
    const out = chunkByGrapheme(text, 8);
    expect(out.join('')).toBe(text);
  });

  it('size <= 0 抛 RangeError（编程错误）', () => {
    expect(() => chunkByGrapheme('x', 0)).toThrow(RangeError);
    expect(() => chunkByGrapheme('x', -1)).toThrow(RangeError);
  });

  it('size > MAX_CHUNK_GRAPHEMES (800) 抛 RangeError（保护 WAF / 渲染）', () => {
    expect(() => chunkByGrapheme('x', MAX_CHUNK_GRAPHEMES + 1)).toThrow(RangeError);
  });

  it('size = MAX_CHUNK_GRAPHEMES (800) 不抛错（边界包含）', () => {
    expect(() => chunkByGrapheme('x', MAX_CHUNK_GRAPHEMES)).not.toThrow();
  });

  it('非整数 size 抛 RangeError（避免误用浮点）', () => {
    expect(() => chunkByGrapheme('x', 32.5)).toThrow(RangeError);
  });
});
