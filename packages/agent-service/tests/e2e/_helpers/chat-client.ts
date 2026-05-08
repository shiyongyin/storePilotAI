/**
 * 切片 19 — Chat Completions 客户端（supertest 风格薄封装）
 *
 * 严格按 docs/tanks/19-test-e2e-20-cases.md §5 / §7 落地：
 *   - 不依赖外网（任务卡 §7 MUST NOT §2）；
 *   - 与 src/test-helpers/sse-collect.ts 行为兼容（OpenAI chunk 解析）。
 *
 * 提供：
 *   - `postChat`：发起一次 SSE chat，返回 Response（用于 status / header 断言）；
 *   - `streamChat`：发起 chat 并按业务 chunk 拼接 finalText（用于 markdown 内容断言）；
 *   - `logCommand`：在测试 log 打印 supertest 等价的 curl + 断言摘要（任务卡 §7 MUST DO §5）。
 *
 * @since 切片 19
 */
import type { Hono } from 'hono';

/** chat-completions 请求 body 形态 */
export interface ChatBody {
  model?: string;
  stream?: boolean;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
}

/** postChat 入参 */
export interface PostChatArgs {
  app: Hono;
  apiKey?: string | null;
  traceId?: string;
  body: ChatBody;
}

/**
 * 发起一次 chat-completions 请求；返回原始 Response（caller 自行读 SSE 流）。
 */
export async function postChat(args: PostChatArgs): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (args.apiKey) headers['Authorization'] = `Bearer ${args.apiKey}`;
  if (args.traceId) headers['X-Trace-Id'] = args.traceId;

  const fullBody: ChatBody = {
    model: args.body.model ?? 'store-agent-v1',
    stream: args.body.stream ?? true,
    messages: args.body.messages,
  };

  const req = new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(fullBody),
  });
  return await args.app.fetch(req);
}

/**
 * SSE chunk 解析 —— 取所有业务 `delta.content` 串联（与 src/test-helpers/sse-collect 行为同形）。
 */
export async function streamChat(args: PostChatArgs): Promise<{
  status: number;
  finalText: string;
  events: Array<{ event: string | null; data: string }>;
  res: Response;
}> {
  const res = await postChat(args);
  const events = await readSseEvents(res);
  const finalText = events
    .filter((e) => e.event === null && e.data.startsWith('{'))
    .map((e) => {
      try {
        const j = JSON.parse(e.data) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        return j.choices?.[0]?.delta?.content ?? '';
      } catch {
        return '';
      }
    })
    .join('');
  return { status: res.status, finalText, events, res };
}

/**
 * 读取整个 SSE 流，按 `\n\n` 切分；自动捕捉 [DONE]。
 */
export async function readSseEvents(
  res: Response,
): Promise<Array<{ event: string | null; data: string }>> {
  if (!res.body) return [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events: Array<{ event: string | null; data: string }> = [];

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        events.push(parseSseBlock(block));
      }
    }
    if (buf.trim().length > 0) events.push(parseSseBlock(buf));
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
  return events;
}

function parseSseBlock(block: string): { event: string | null; data: string } {
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
  }
  return { event, data: dataLines.join('\n') };
}

/* ============================================================================
 * 测试 log helpers —— 任务卡 §7 MUST DO §5
 * ========================================================================== */

/**
 * 输出 supertest / curl 等价命令到 stdout，便于 reporter=verbose 下追溯：
 *   `[T-xx] curl -N -H 'Authorization: ***' -d '{...}' /v1/chat/completions → expect: ...`
 *
 * 真实 secret（apiKey）一律掩码 `Bearer ***`，避免明文出现在 CI log。
 */
// eslint-disable-next-line no-console
export function logCommand(label: string, command: string, expect: string): void {
  // 用 console.info 而非 logger（pino），避免 vitest reporter 把日志吞掉。
  // eslint-disable-next-line no-console
  console.info(`[${label}] cmd: ${command}\n[${label}] expect: ${expect}`);
}
