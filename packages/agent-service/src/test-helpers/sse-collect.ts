/**
 * 切片 18 — SSE 断言 helper（设计指南 §31.2 + 任务卡 H-测试 §T-TEST-01.5 §2）
 *
 * 用于集成测试 / E2E：从 supertest / fetch Response 流式收集 OpenAI Chat Completions
 * chunk 中的 `delta.content`，在收到 `data: [DONE]` 时停止并返回累计内容数组。
 *
 * 协议要点（任务卡 §T-BRIDGE-03 + 切片 10）：
 *   - chunk 间用 `\n\n` 分隔；每条 chunk 第一行为 `data: <json>`（或 `data: [DONE]`）。
 *   - 中途异常 chunk 由桥接层包装为 `delta.content = '\n\n⚠️ <friendly>'`，
 *     仍由本 helper 解析（OpenAI Error JSON 体被红线 5 禁止，永远不会到这里）。
 *   - 心跳 chunk 走 `event: ping`，没有 `data: ` 前缀，本 helper 自动忽略。
 *
 * 强约束（切片 18 §7 MUST DO §5）：
 *   - 严格按 OpenAI 协议解析；遇到 `data: [DONE]` 立即返回（不再读后续字节）。
 *   - 流提前结束（reader 返回 done=true）也允许返回，方便测试断言 abort 路径。
 *
 * @since 切片 18
 */

/**
 * 最小化的 Response shape，便于本 helper 同时支持：
 *   - WHATWG `fetch` Response（Node 22 内置）
 *   - supertest 的 SuperAgentRequest（其 body 是可读流）
 *
 * 仅依赖 `body.getReader()`，不依赖框架特化字段。
 */
export interface SseResponse {
  readonly body: ReadableStream<Uint8Array> | null;
}

/**
 * 从 OpenAI 兼容 SSE Response 收集 `delta.content` 文本数组。
 *
 * @param res 必须含 `body` 流（已开始流式响应）；body 为 null 时直接返回空数组。
 * @returns 各 chunk 的 `delta.content` 字符串数组（不含 `[DONE]` 自身）；
 *          中途异常 chunk 的友好话术也会作为最后一项被收集（红线 5：异常仍走 SSE 文本回退）。
 *
 * @example
 *   const res = await app.fetch(req);
 *   const chunks = await collectOpenAiSse(res);
 *   expect(chunks.join('')).toContain('门店');
 */
export async function collectOpenAiSse(res: SseResponse): Promise<string[]> {
  const chunks: string[] = [];
  const body = res.body;
  if (!body) return chunks;

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  // 保险：reader.cancel() 异常被吞，避免影响断言
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE chunk 之间以 `\n\n` 分隔；剩余不完整段保留到下次循环。
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        if (part.length === 0) continue;

        // 终止顺序（红线 5）：先 finish_reason='stop' 的最终 chunk，再 `data: [DONE]`。
        // 这里见到 [DONE] 就退出；外层不再读后续字节，让 reader 自然 GC。
        if (part.startsWith('data: [DONE]')) return chunks;

        // 心跳 chunk：`event: ping\ndata: ts=...`，多行；只取 `data: ` 业务行。
        const dataLine = part.split('\n').find((line) => line.startsWith('data: '));
        if (!dataLine) continue;

        const json = dataLine.slice(6); // strip "data: "
        // 极端情况下中途异常 fallback 仍可能产出 [DONE]（桥接层兜底）；与上面分支一致。
        if (json === '[DONE]') return chunks;

        try {
          const payload = JSON.parse(json) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const content = payload.choices?.[0]?.delta?.content ?? '';
          chunks.push(content);
        } catch {
          // 非法 JSON 不抛错（兼容心跳 / future 字段），断言层判定即可
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
  return chunks;
}
