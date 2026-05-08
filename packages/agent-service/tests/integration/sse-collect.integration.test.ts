/**
 * 切片 18 §9 step 6 — SSE 断言 helper 集成测试
 *
 * 用 Node 内置 ReadableStream 直接构造 OpenAI Chat Completions chunk 流，
 * 验证 collectOpenAiSse(res) 严格按协议解析 chunk + `[DONE]` 收尾。
 *
 * 覆盖：
 *   - I-13(集成 §8.6)：finish_reason='stop' → [DONE] 顺序，最终返回正确 chunks
 *   - 心跳 chunk 被忽略（event: ping 行 + data: ts=...）
 *   - 中途异常 chunk（友好话术 delta.content）仍被收集（红线 5）
 *   - 流提前结束（reader done）也允许返回（abort 路径）
 *   - body=null 返回空数组（防御性）
 */
import { describe, expect, it } from 'vitest';

import { collectOpenAiSse } from '../../src/test-helpers/sse-collect.js';

const ENC = new TextEncoder();

/**
 * 构造一个 ReadableStream<Uint8Array>，把传入的字符串切成多个 chunk 推送，
 * 模拟真实网络场景下的拆包（buf 拼接逻辑必须能正确处理跨包的 `\n\n`）。
 */
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(ENC.encode(c));
      controller.close();
    },
  });
}

function chunk(content: string, finishReason: 'stop' | null = null): string {
  const payload = {
    id: 'chatcmpl-trace-001',
    object: 'chat.completion.chunk',
    created: 1735812345,
    model: 'store-agent-v1',
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

describe('collectOpenAiSse — OpenAI Chat Completions SSE 协议解析', () => {
  it('happy path: 多 chunk + finish_reason=stop + [DONE] 收尾', async () => {
    const stream = streamFromChunks([
      chunk('您好，'),
      chunk('门店 M001 / S001 '),
      chunk('今天表现良好。'),
      chunk('', 'stop'),
      'data: [DONE]\n\n',
    ]);
    const result = await collectOpenAiSse({ body: stream });
    expect(result).toEqual(['您好，', '门店 M001 / S001 ', '今天表现良好。', '']);
    expect(result.join('')).toBe('您好，门店 M001 / S001 今天表现良好。');
  });

  it('心跳 chunk（event: ping）被忽略', async () => {
    const ping = 'event: ping\ndata: ts=1735812345000\n\n';
    const stream = streamFromChunks([
      ping,
      chunk('Hi'),
      ping,
      ping,
      chunk('', 'stop'),
      'data: [DONE]\n\n',
    ]);
    const result = await collectOpenAiSse({ body: stream });
    expect(result).toEqual(['Hi', '']);
  });

  it('跨网络包的 `\\n\\n` 边界正确拼接', async () => {
    // 故意把一个完整 chunk 拆到两个网络包里，验证 buf 残留逻辑
    const full = chunk('A') + chunk('B') + chunk('', 'stop') + 'data: [DONE]\n\n';
    const split = [full.slice(0, 30), full.slice(30, 80), full.slice(80)];
    const stream = streamFromChunks(split);
    const result = await collectOpenAiSse({ body: stream });
    expect(result).toEqual(['A', 'B', '']);
  });

  it('中途异常的友好话术 chunk 仍被收集（红线 5：禁返 OpenAI Error JSON）', async () => {
    const stream = streamFromChunks([
      chunk('首段正常输出。'),
      chunk('\n\n⚠️ AI 服务暂时繁忙，请稍后再试。'),
      chunk('', 'stop'),
      'data: [DONE]\n\n',
    ]);
    const result = await collectOpenAiSse({ body: stream });
    expect(result.some((c) => c.includes('⚠️'))).toBe(true);
  });

  it('遇到 [DONE] 立即停止，不解析后续字节', async () => {
    const stream = streamFromChunks([
      chunk('前段'),
      'data: [DONE]\n\n',
      // 后面的字节本不该出现，验证 [DONE] 后立即返回
      chunk('污染数据，应被忽略'),
    ]);
    const result = await collectOpenAiSse({ body: stream });
    expect(result).toEqual(['前段']);
  });

  it('reader done 提前结束（abort 场景）也允许返回', async () => {
    // 没有 [DONE]，但流自然结束（模拟 abort）
    const stream = streamFromChunks([chunk('部分')]);
    const result = await collectOpenAiSse({ body: stream });
    expect(result).toEqual(['部分']);
  });

  it('body=null 返回空数组（防御性）', async () => {
    const result = await collectOpenAiSse({ body: null });
    expect(result).toEqual([]);
  });

  it('非法 JSON 不抛错（兼容未来字段 / 损坏帧）', async () => {
    const stream = streamFromChunks([
      'data: {not valid json}\n\n',
      chunk('正常'),
      chunk('', 'stop'),
      'data: [DONE]\n\n',
    ]);
    const result = await collectOpenAiSse({ body: stream });
    expect(result).toEqual(['正常', '']);
  });
});
