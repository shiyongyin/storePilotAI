/**
 * 切片 18 §9 — SSE 协议补充集成测试（与 sse-collect.integration.test.ts 互补）
 *
 * 关注协议层细节，避免与基础解析重复：
 *   - 半 chunk 字节切片（多次 read 单字节）
 *   - chunked transfer encoding 兜底（Uint8Array vs string）
 *   - 大 chunk（> 64KB）解析不溢出
 *   - 多 ping 之间夹杂业务 chunk
 *   - 终止信号字面量变体（"data: [DONE]\n\n" / "data: [DONE]\n\n\n"）
 *   - reader.cancel 异常被吞没
 *
 * 严格不引入 fetch 真实请求；统一用 ReadableStream 注入字节，方便单测稳定性。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  collectOpenAiSse,
  type SseResponse,
} from '../../src/test-helpers/sse-collect.js';

const ENC = new TextEncoder();

function streamFrom(str: string, splitAt: number[] = []): ReadableStream<Uint8Array> {
  // splitAt 例：[5, 12] → 把 str 切成 [0..5)、[5..12)、[12..end) 三段 enqueue
  const positions = [0, ...splitAt, str.length];
  const segments: string[] = [];
  for (let i = 0; i < positions.length - 1; i += 1) {
    const start = positions[i] ?? 0;
    const end = positions[i + 1] ?? str.length;
    segments.push(str.slice(start, end));
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const seg of segments) controller.enqueue(ENC.encode(seg));
      controller.close();
    },
  });
}

function buildChunk(content: string, finishReason: 'stop' | null = null): string {
  const payload = {
    choices: [
      {
        index: 0,
        delta: finishReason ? {} : { content },
        finish_reason: finishReason,
      },
    ],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

describe('collectOpenAiSse — 协议字节级边界', () => {
  it('单字节切分（每个字节单独 enqueue）→ 仍能完整解析', async () => {
    const full = buildChunk('hi') + buildChunk('', 'stop') + 'data: [DONE]\n\n';
    const splits = Array.from({ length: full.length - 1 }, (_, i) => i + 1);
    const stream = streamFrom(full, splits);
    const result = await collectOpenAiSse({ body: stream });
    expect(result).toEqual(['hi', '']);
  });

  it('完整 chunk 跨 5 个网络包 → buf 拼接正确', async () => {
    const full = buildChunk('A') + buildChunk('B') + buildChunk('C') + 'data: [DONE]\n\n';
    const stream = streamFrom(full, [10, 25, 50, 80]);
    const result = await collectOpenAiSse({ body: stream });
    expect(result).toEqual(['A', 'B', 'C']);
  });

  it('大 chunk（content 长度 ~80KB）→ 一次性解析不溢出', async () => {
    const big = 'X'.repeat(80 * 1024);
    const full = buildChunk(big) + buildChunk('', 'stop') + 'data: [DONE]\n\n';
    const stream = streamFrom(full);
    const result = await collectOpenAiSse({ body: stream });
    expect(result[0]).toBe(big);
    expect(result[1]).toBe('');
  });

  it('多 ping 与业务 chunk 交错 → 仅业务 chunk 被收集', async () => {
    const ping = 'event: ping\ndata: ts=1\n\n';
    const full = ping + buildChunk('p1') + ping + ping + buildChunk('p2') + ping + 'data: [DONE]\n\n';
    const stream = streamFrom(full);
    const result = await collectOpenAiSse({ body: stream });
    expect(result).toEqual(['p1', 'p2']);
  });

  it('终止信号 "data: [DONE]\\n\\n\\n" 多换行变体 → 仍正确停止', async () => {
    const full = buildChunk('x') + 'data: [DONE]\n\n\n';
    const stream = streamFrom(full);
    const result = await collectOpenAiSse({ body: stream });
    expect(result).toEqual(['x']);
  });

  it('reader.cancel 抛错 → 静默吞没（不影响返回值）', async () => {
    const full = buildChunk('x') + buildChunk('', 'stop') + 'data: [DONE]\n\n';
    const stream = streamFrom(full);
    const reader = stream.getReader();
    const cancelSpy = vi.fn(() => Promise.reject(new Error('cancel boom')));
    Object.defineProperty(reader, 'cancel', { value: cancelSpy });
    const fakeRes: SseResponse = {
      body: {
        getReader: () => reader,
      } as unknown as ReadableStream<Uint8Array>,
    };
    const result = await collectOpenAiSse(fakeRes);
    expect(result).toEqual(['x', '']);
  });
});
