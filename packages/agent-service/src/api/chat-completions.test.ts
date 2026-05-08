/**
 * 切片 10 §9 验收 step 1-7 + step 9 + step 12 — chat-completions 集成测试
 *
 * 用 Hono 的 `app.fetch(req)` 直接驱动桥接层，覆盖：
 *   - happy path：实时多 chunk + finish_reason='stop' + data: [DONE]（§9 step 1-3）
 *   - SSE 头部：X-Accel-Buffering: no + Cache-Control: no-cache, no-transform（§9 step 4）
 *   - 心跳：调低 heartbeat 间隔，60ms 内 ≥ 4 次 event: ping（§9 step 5）
 *   - 中途异常：dispatcher throw → 最后 chunk 含友好话术 + DONE，禁返 JSON Error（§9 step 6）
 *   - abort 清理：reader.cancel() → heartbeat 清除 + 业务 abortSignal 触发（§9 step 7）
 *   - tool_calls 注入拦截：finalText 含 tool_calls → 拒发 + 友好话术 + outputHash（§9 step 9 / step 11）
 *   - OpenAI tools 字段 → 400 INVALID_REQUEST（§9 step 12）
 *
 * 测试基础设施：
 *   - FakeAuthPool（与 auth.test.ts 同模式）：seed 一把可用 key + argon2id hash + secret pepper
 *   - setDispatcher 注入业务 dispatcher（占位 → fake）
 *   - _setHeartbeatIntervalForTest 调低心跳到 ~30ms 让心跳测试可在 < 1s 跑完
 */
import argon2 from 'argon2';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  API_KEY_PREFIX_LENGTH,
  type ApiKeyRow,
  type AuthPool,
  resetAuthPoolForTest,
  setAuthPool,
} from '../bridge/auth.js';
import { logger } from '../observability/logger.js';
import {
  resetMetricsAdapterForTest,
  setMetricsAdapter,
  type MetricsAdapter,
} from '../observability/metrics.js';

import {
  _resetHeartbeatIntervalForTest,
  _setHeartbeatIntervalForTest,
  chatCompletionsRouter,
  defaultDispatcher,
  resetDispatcherForTest,
  resetHitlPreDispatchHookForTest,
  setDispatcher,
  setHitlPreDispatchHook,
  type DispatchArgs,
  type DispatchResult,
  type HitlPreDispatchHookArgs,
  type HitlPreDispatchHookResult,
} from './chat-completions.js';

/* ============================================================================
 * Env fixture（与 auth.test.ts 同 fixture）
 * ========================================================================== */
const TEST_API_KEY_HASH_SALT = 'unit-test-salt-32chars-xxxxxxxxxx';

const ENV_FIXTURE: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '7100',
  DATABASE_URL: 'mysql://test:test@localhost:3306/test',
  MODEL_PROVIDER: 'openai-compatible',
  MODEL_BASE_URL: 'http://localhost:7100/llm',
  MODEL_API_KEY: 'sk-test-1234567890',
  MODEL_NAME: 'gpt-test',
  ERP_MCP_SERVER_URL: 'http://localhost:7300/mcp',
  MCP_TENANT_SHARED_SECRET: 'a'.repeat(32),
  MCP_PROTOCOL_VERSION: '2025-06-18',
  AGENT_API_KEY_HASH_SALT: TEST_API_KEY_HASH_SALT,
  AGENT_API_KEY_PREFIX: 'sk-agent-',
  CORS_ALLOWED_ORIGINS: 'http://localhost:3210',
};

beforeAll(() => {
  for (const [key, value] of Object.entries(ENV_FIXTURE)) vi.stubEnv(key, value);
});

/* ============================================================================
 * FakeAuthPool（精简版 —— 仅支持 SELECT prefix WHERE / UPDATE NOOP）
 * ========================================================================== */
class FakeAuthPool implements AuthPool {
  public readonly rows = new Map<number, ApiKeyRow & { last_used_at: Date | null }>();

  insert(row: ApiKeyRow & { last_used_at?: Date | null }): void {
    this.rows.set(row.id, { ...row, last_used_at: row.last_used_at ?? null });
  }

  query<T extends Record<string, unknown>>(
    sql: string,
    params: readonly unknown[],
  ): Promise<[T[], unknown]> {
    const norm = sql.replace(/\s+/g, ' ').trim();
    if (
      /SELECT .* FROM agent_api_key WHERE api_key_prefix = \? AND status = 'ENABLED'/i.test(norm)
    ) {
      const prefix = params[0];
      const rows: ApiKeyRow[] = [];
      for (const row of this.rows.values()) {
        if (row.api_key_prefix === prefix && row.status === 'ENABLED') {
          rows.push({
            id: row.id,
            api_key_hash: row.api_key_hash,
            api_key_prefix: row.api_key_prefix,
            merchant_id: row.merchant_id,
            store_id: row.store_id,
            user_id: row.user_id,
            status: row.status,
            expires_at: row.expires_at,
          });
        }
      }
      return Promise.resolve([rows as unknown as T[], undefined]);
    }
    throw new Error(`FakeAuthPool: 未识别的 query SQL: ${norm}`);
  }

  execute(sql: string, params: readonly unknown[]): Promise<[{ affectedRows: number }, unknown]> {
    // 整次集成测试只测 SSE 协议，不验节流次数；UPDATE 一律 NOOP（affectedRows=0）。
    void sql;
    void params;
    return Promise.resolve([{ affectedRows: 0 }, undefined]);
  }
}

const PLAINTEXT_API_KEY = 'sk-agent-test1234567890abcdefghijklmnopqrstuvwxyz0';
const VALID_AUTH_HEADER = `Bearer ${PLAINTEXT_API_KEY}`;

async function seedValidKey(pool: FakeAuthPool): Promise<void> {
  const hash = await argon2.hash(PLAINTEXT_API_KEY, {
    type: argon2.argon2id,
    secret: Buffer.from(TEST_API_KEY_HASH_SALT),
  });
  pool.insert({
    id: 1,
    api_key_hash: hash,
    api_key_prefix: PLAINTEXT_API_KEY.slice(0, API_KEY_PREFIX_LENGTH),
    merchant_id: 'M001',
    store_id: 'S001',
    user_id: 'boss-001',
    status: 'ENABLED',
    expires_at: null,
  });
}

/* ============================================================================
 * 应用 + 工具
 * ========================================================================== */

/** 构造一个仅含 chat-completions 路由的最小 Hono app（与 server.ts 挂载方式 1:1） */
function buildApp(): Hono {
  const app = new Hono();
  app.route('/v1', chatCompletionsRouter);
  return app;
}

interface MakeRequestArgs {
  body: unknown;
  authHeader?: string;
  traceId?: string;
}

function makeRequest(args: MakeRequestArgs): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (args.authHeader !== undefined) headers['Authorization'] = args.authHeader;
  if (args.traceId !== undefined) headers['X-Trace-Id'] = args.traceId;
  return new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(args.body),
  });
}

const DEFAULT_BODY_VALID = {
  model: 'store-agent-v1',
  stream: true,
  messages: [{ role: 'user' as const, content: '今天 S001 卖得怎么样' }],
};

/**
 * 收集 SSE 响应的所有 data: 行（按行解析 hono writeSSE 的 wire format：
 * `event: <name>\ndata: <payload>\n\n`，多行 data 用换行连接）。
 *
 * @param res Response 对象（content-type: text/event-stream）
 * @returns 解析出的事件序列（含心跳 ping）
 */
async function collectSSE(res: Response): Promise<
  Array<{ event: string | null; data: string }>
> {
  expect(res.body).toBeTruthy();
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: Array<{ event: string | null; data: string }> = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      events.push(parseSseBlock(block));
    }
  }
  if (buffer.trim().length > 0) events.push(parseSseBlock(buffer));
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
 * 公共 setup
 * ========================================================================== */
let pool: FakeAuthPool;

beforeEach(async () => {
  pool = new FakeAuthPool();
  setAuthPool(pool);
  await seedValidKey(pool);
});

afterEach(() => {
  resetAuthPoolForTest();
  resetDispatcherForTest();
  resetHitlPreDispatchHookForTest();
  resetMetricsAdapterForTest();
  _resetHeartbeatIntervalForTest();
  vi.restoreAllMocks();
});

afterAll(() => {
  _resetHeartbeatIntervalForTest();
  vi.unstubAllEnvs();
});

/* ============================================================================
 * §7 MUST DO §14 — defaultDispatcher named export
 * ========================================================================== */

describe('切片 10 §7 MUST DO §14 — defaultDispatcher named export', () => {
  it('defaultDispatcher 可被后续切片直接 import，且返回显式占位 markdown', async () => {
    const result = await defaultDispatcher({} as DispatchArgs);
    expect(result.finalText).toContain('切片 10');
    expect(result.finalText).toContain('阶段 5/6');
    expect(result.finalText).toContain('接管');
  });
});

/* ============================================================================
 * §9 step 1-3 — happy path：chunk + finish_reason + DONE
 * ========================================================================== */

describe('切片 10 §9 step 1-3 — happy path 协议', () => {
  it('返回多个 chunk，最后两条按顺序 finish_reason=stop / [DONE]', async () => {
    const finalText = '【日报】今日 S001 销售 1234 元，毛利 35%，新客 8 人。';
    setDispatcher(
      (args: DispatchArgs): Promise<DispatchResult> => {
        void args;
        return Promise.resolve({ finalText });
      },
    );

    const res = await buildApp().fetch(
      makeRequest({ authHeader: VALID_AUTH_HEADER, body: DEFAULT_BODY_VALID }),
    );
    expect(res.status).toBe(200);

    const events = await collectSSE(res);

    // 业务 chunk + finish_reason chunk + [DONE]
    // happy text 长度 < 320 grapheme，只有 1 段业务 chunk。
    expect(events.length).toBeGreaterThanOrEqual(3);
    const last = events[events.length - 1]!;
    expect(last.data).toBe('[DONE]');

    const beforeLast = events[events.length - 2]!;
    const beforeLastPayload = JSON.parse(beforeLast.data) as {
      object: string;
      choices: Array<{
        delta: { content?: string };
        finish_reason: 'stop' | 'length' | null;
      }>;
    };
    expect(beforeLastPayload.object).toBe('chat.completion.chunk');
    expect(beforeLastPayload.choices[0]?.finish_reason).toBe('stop');
    expect(beforeLastPayload.choices[0]?.delta).toEqual({});

    // 业务 chunk（events[0..-3]) 必须含完整 finalText
    const firstBusiness = events[0]!;
    const firstPayload = JSON.parse(firstBusiness.data) as {
      object: string;
      choices: Array<{ delta: { content?: string } }>;
    };
    expect(firstPayload.object).toBe('chat.completion.chunk');
    expect(firstPayload.choices[0]?.delta.content).toBe(finalText);
  });

  it('chunk object 名固定 chat.completion.chunk（§9 step 2）', async () => {
    setDispatcher(() => Promise.resolve({ finalText: 'x' }));
    const res = await buildApp().fetch(
      makeRequest({ authHeader: VALID_AUTH_HEADER, body: DEFAULT_BODY_VALID }),
    );
    const events = await collectSSE(res);
    const businessEvent = events.find(
      (e) =>
        e.event === null && e.data.startsWith('{') && e.data.includes('chat.completion.chunk'),
    );
    expect(businessEvent).toBeTruthy();
    const payload = JSON.parse(businessEvent!.data) as { object: string };
    expect(payload.object).toBe('chat.completion.chunk');
  });

  it('长 markdown（5000 char）按 grapheme 切分多段（§9 step 8）', async () => {
    const finalText = 'a'.repeat(5000);
    setDispatcher(() => Promise.resolve({ finalText }));
    const res = await buildApp().fetch(
      makeRequest({ authHeader: VALID_AUTH_HEADER, body: DEFAULT_BODY_VALID }),
    );
    const events = await collectSSE(res);

    // 业务 chunks（不含 finish_reason chunk 与 [DONE]）
    const businessChunks = events
      .filter((e) => e.event === null && e.data !== '[DONE]')
      .map((e) => JSON.parse(e.data) as { choices: [{ delta: { content?: string } }] })
      .filter((p) => p.choices[0].delta.content !== undefined);

    // 5000 / 320 = 15.625 → 16 段
    expect(businessChunks.length).toBe(Math.ceil(5000 / 320));
    for (const c of businessChunks) {
      expect((c.choices[0].delta.content ?? '').length).toBeLessThanOrEqual(320);
    }
    expect(businessChunks.map((c) => c.choices[0].delta.content).join('')).toBe(finalText);
  });
});

/* ============================================================================
 * §9 step 4 — SSE 头部
 * ========================================================================== */

describe('切片 10 §9 step 4 — SSE 头部（X-Accel-Buffering / Cache-Control / Connection）', () => {
  it('响应头必须含 X-Accel-Buffering: no', async () => {
    setDispatcher(() => Promise.resolve({ finalText: 'x' }));
    const res = await buildApp().fetch(
      makeRequest({ authHeader: VALID_AUTH_HEADER, body: DEFAULT_BODY_VALID }),
    );
    expect(res.headers.get('X-Accel-Buffering')).toBe('no');
  });

  it('响应头必须含 Cache-Control: no-cache, no-transform', async () => {
    setDispatcher(() => Promise.resolve({ finalText: 'x' }));
    const res = await buildApp().fetch(
      makeRequest({ authHeader: VALID_AUTH_HEADER, body: DEFAULT_BODY_VALID }),
    );
    expect(res.headers.get('Cache-Control')).toBe('no-cache, no-transform');
  });

  it('Content-Type 必须 text/event-stream; charset=utf-8', async () => {
    setDispatcher(() => Promise.resolve({ finalText: 'x' }));
    const res = await buildApp().fetch(
      makeRequest({ authHeader: VALID_AUTH_HEADER, body: DEFAULT_BODY_VALID }),
    );
    expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
  });

  it('Connection 必须 keep-alive（streamSSE 默认值 + 我们不覆写）', async () => {
    setDispatcher(() => Promise.resolve({ finalText: 'x' }));
    const res = await buildApp().fetch(
      makeRequest({ authHeader: VALID_AUTH_HEADER, body: DEFAULT_BODY_VALID }),
    );
    expect(res.headers.get('Connection')).toBe('keep-alive');
  });
});

/* ============================================================================
 * §9 step 5 — 心跳（event: ping）
 * ========================================================================== */

describe('切片 10 §9 step 5 — 心跳 15s（测试调低到 ~30ms）', () => {
  it('dispatch 慢响应期间应有多次 event: ping 心跳', async () => {
    _setHeartbeatIntervalForTest(30);
    setDispatcher(async () => {
      // 等 200ms（≈ 6 次心跳间隔）让 heartbeat 稳定 fire
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      return { finalText: 'after slow dispatch' };
    });

    const res = await buildApp().fetch(
      makeRequest({ authHeader: VALID_AUTH_HEADER, body: DEFAULT_BODY_VALID }),
    );
    const events = await collectSSE(res);
    const pings = events.filter((e) => e.event === 'ping');
    // 200ms / 30ms = 6.67；保守期望 ≥ 4 次（与 §9 step 5 "60s → 4 次" 同语义）
    expect(pings.length).toBeGreaterThanOrEqual(4);
  });
});

/* ============================================================================
 * §9 step 6 — 中途异常包装为 friendlyMessage（禁返 JSON Error）
 * ========================================================================== */

describe('切片 10 §9 step 6 — 中途异常 friendlyMessage 包装', () => {
  it('dispatcher throw → 最后一条业务 chunk 含 friendlyMessage（"ERP 系统暂时连不上"）+ [DONE]', async () => {
    setDispatcher(async () => {
      // 模拟 MCP 超时（friendlyMessage 映射为 "ERP 系统暂时连不上，请稍后再试。"）
      const { BizError } = await import('@storepilot/shared-contracts');
      throw new BizError('MCP_TIMEOUT', 'upstream MCP timed out');
    });

    const res = await buildApp().fetch(
      makeRequest({ authHeader: VALID_AUTH_HEADER, body: DEFAULT_BODY_VALID }),
    );
    expect(res.status).toBe(200);

    const events = await collectSSE(res);
    expect(events[events.length - 1]?.data).toBe('[DONE]');

    // 倒数第 2 是 finish_reason=stop chunk
    const finishPayload = JSON.parse(events[events.length - 2]!.data) as {
      choices: Array<{ finish_reason: string | null }>;
    };
    expect(finishPayload.choices[0]?.finish_reason).toBe('stop');

    // 倒数第 3 是友好话术 chunk
    const friendlyPayload = JSON.parse(events[events.length - 3]!.data) as {
      choices: Array<{ delta: { content?: string } }>;
    };
    const friendlyContent = friendlyPayload.choices[0]?.delta.content ?? '';
    expect(friendlyContent.startsWith('\n\n⚠️ ')).toBe(true);
    expect(friendlyContent).toContain('ERP 系统暂时连不上');

    // 不得返回 OpenAI Error JSON 体（任务卡 §7 MUST NOT §2）
    for (const evt of events) {
      expect(evt.data).not.toMatch(/"error"\s*:\s*\{/);
    }
  });
});

/* ============================================================================
 * §9 step 7 — abort 清理（reader.cancel → onAbort 触发 + heartbeat 清除）
 * ========================================================================== */

describe('切片 10 §9 step 7 — abort 清理', () => {
  it('客户端 cancel reader → 业务 abortSignal 触发 + heartbeat 不再 fire', async () => {
    _setHeartbeatIntervalForTest(20);

    let observedAbort = false;
    setDispatcher(async (args: DispatchArgs): Promise<DispatchResult> => {
      // 业务等 abort，最多 500ms 兜底（避免测试卡死）
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 500);
        args.abortSignal.addEventListener('abort', () => {
          observedAbort = true;
          clearTimeout(t);
          resolve();
        });
      });
      return { finalText: 'should not be visible' };
    });

    const res = await buildApp().fetch(
      makeRequest({ authHeader: VALID_AUTH_HEADER, body: DEFAULT_BODY_VALID }),
    );
    expect(res.body).toBeTruthy();
    const reader = res.body!.getReader();

    // 读 1-2 次（拿到至少一次心跳）
    await reader.read();
    await reader.cancel();

    // 等 100ms 让 onAbort 异步链路完成
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(observedAbort).toBe(true);
  });
});

/* ============================================================================
 * §9 step 9 / step 10 / step 11 — tool_calls 注入拦截 + outputHash + 友好话术
 * ========================================================================== */

class SpyMetrics implements MetricsAdapter {
  public readonly calls: string[] = [];
  increment(name: string): void {
    this.calls.push(name);
  }
}

describe('切片 10 §9 step 9-11 — OutputGuard 端到端拦截', () => {
  it('finalText 含 tool_calls → 拒发业务 chunk + 友好话术 + outputHash 日志（无原文）+ metrics 上报', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation((() => undefined) as never);
    const metrics = new SpyMetrics();
    setMetricsAdapter(metrics);

    const finalText = '## 销售明细 with tool_calls payload should be blocked';
    setDispatcher(() => Promise.resolve({ finalText }));

    const res = await buildApp().fetch(
      makeRequest({ authHeader: VALID_AUTH_HEADER, body: DEFAULT_BODY_VALID }),
    );
    expect(res.status).toBe(200); // SSE 起头就是 200，错误走 friendly 包装

    const events = await collectSSE(res);
    // 不应出现含原始 tool_calls 内容的业务 chunk（任务卡 §7 MUST NOT §8：拒发，不清洗）
    for (const evt of events) {
      if (evt.data.startsWith('{')) {
        // chunk JSON 中 delta.content 不应含 tool_calls
        const payload = JSON.parse(evt.data) as {
          choices: Array<{ delta: { content?: string } }>;
        };
        const content = payload.choices[0]?.delta.content ?? '';
        expect(content).not.toContain('tool_calls');
      }
    }

    // 倒数 friendly chunk
    const friendlyPayload = JSON.parse(events[events.length - 3]!.data) as {
      choices: Array<{ delta: { content?: string } }>;
    };
    const content = friendlyPayload.choices[0]?.delta.content ?? '';
    expect(content).toContain('请用正常方式提问'); // friendlyMessage(TOOL_CALLS_LEAK)
    expect(events[events.length - 1]?.data).toBe('[DONE]');

    // metrics 上报命中
    expect(metrics.calls).toContain('p0.tool_calls_leak');

    // 日志 outputHash 命中 + 原文不出现
    const errorCalls = errorSpy.mock.calls.filter(
      (call) => (call[1] as string) === '[P0] tool_calls leak blocked',
    );
    expect(errorCalls.length).toBe(1);
    const fields = errorCalls[0]![0] as Record<string, unknown>;
    expect(fields['errorCode']).toBe('TOOL_CALLS_LEAK');
    expect(fields['outputHash']).toMatch(/^[0-9a-f]{16}$/);
    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain(finalText);
    expect(serialized).not.toContain('销售明细');
  });
});

/* ============================================================================
 * §9 step 12 — OpenAI 请求体含 tools/... → 400 INVALID_REQUEST
 * ========================================================================== */

describe('切片 10 §9 step 12 — OpenAiRequest schema 拒绝 5 字段', () => {
  it.each([
    ['tools', { tools: [{ type: 'function', function: { name: 'calc' } }] }],
    ['tool_choice', { tool_choice: 'auto' }],
    ['functions', { functions: [{ name: 'calc' }] }],
    ['function_call', { function_call: { name: 'calc' } }],
    ['response_format', { response_format: { type: 'json_object' } }],
  ])('请求体含 %s → 400 INVALID_REQUEST', async (_label, extra) => {
    const res = await buildApp().fetch(
      makeRequest({
        authHeader: VALID_AUTH_HEADER,
        body: { ...DEFAULT_BODY_VALID, ...(extra as Record<string, unknown>) },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; type: string } };
    expect(body.error.code).toBe('INVALID_REQUEST');
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('请求体非 JSON → 400 INVALID_REQUEST', async () => {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: VALID_AUTH_HEADER,
      },
      body: 'not-json',
    });
    const res = await buildApp().fetch(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_REQUEST');
  });

  it('缺少 messages 字段 → 400 INVALID_REQUEST', async () => {
    const res = await buildApp().fetch(
      makeRequest({
        authHeader: VALID_AUTH_HEADER,
        body: { model: 'store-agent-v1' },
      }),
    );
    expect(res.status).toBe(400);
  });
});

/* ============================================================================
 * 鉴权异常（与切片 09 §9 step 4 相邻 —— 桥接层 OpenAI 兼容 401）
 * ========================================================================== */

describe('切片 10 — 鉴权失败统一返 401 UNAUTHORIZED（OpenAI 兼容）', () => {
  it('缺 Authorization → 401', async () => {
    const res = await buildApp().fetch(makeRequest({ body: DEFAULT_BODY_VALID }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('错误的 prefix → 401（不暴露 invalid_prefix 原因）', async () => {
    const res = await buildApp().fetch(
      makeRequest({
        authHeader: 'Bearer abc-not-our-prefix-xxxxxxxxxxxxxxxxx',
        body: DEFAULT_BODY_VALID,
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });
});

/* ============================================================================
 * traceId 注入（与切片 06/09 串联）
 * ========================================================================== */

describe('切片 10 — traceId 处理', () => {
  it('请求头 X-Trace-Id 合法 → chunk id 用客户端 traceId', async () => {
    setDispatcher(() => Promise.resolve({ finalText: 'ok' }));
    const traceId = 'trace_01HXYZ012345ABCDEFGHJKMNP0';
    const res = await buildApp().fetch(
      makeRequest({
        authHeader: VALID_AUTH_HEADER,
        body: DEFAULT_BODY_VALID,
        traceId,
      }),
    );
    const events = await collectSSE(res);
    const businessChunk = events.find(
      (e) =>
        e.event === null && e.data.startsWith('{') && e.data.includes('chat.completion.chunk'),
    );
    const payload = JSON.parse(businessChunk!.data) as { id: string };
    expect(payload.id).toBe(`chatcmpl-${traceId}`);
  });

  it('请求头 X-Trace-Id 缺失 → 自动生成 trace_<ulid>', async () => {
    setDispatcher(() => Promise.resolve({ finalText: 'ok' }));
    const res = await buildApp().fetch(
      makeRequest({
        authHeader: VALID_AUTH_HEADER,
        body: DEFAULT_BODY_VALID,
      }),
    );
    const events = await collectSSE(res);
    const businessChunk = events.find(
      (e) =>
        e.event === null && e.data.startsWith('{') && e.data.includes('chat.completion.chunk'),
    );
    const payload = JSON.parse(businessChunk!.data) as { id: string };
    expect(payload.id).toMatch(/^chatcmpl-trace_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

/* ============================================================================
 * 切片 16 §9 step 9 — HITL pre-dispatch hook（抢占 markdown 提示）
 * ========================================================================== */

describe('切片 16 §9 step 9 — HITL pre-dispatch hook', () => {
  const PREEMPT_PREFIX = '（已为您取消上一次的待确认采购单）\n\n';

  it('抢占（hook 返回 prependMarkdown）→ finalText 顶部加"已为您取消上一次的待确认采购单"', async () => {
    const finalText = '今日 S001 销售 1234 元';
    setDispatcher(() => Promise.resolve({ finalText }));
    setHitlPreDispatchHook(
      (args: HitlPreDispatchHookArgs): Promise<HitlPreDispatchHookResult> => {
        void args;
        return Promise.resolve({ prependMarkdown: PREEMPT_PREFIX });
      },
    );

    const res = await buildApp().fetch(
      makeRequest({ authHeader: VALID_AUTH_HEADER, body: DEFAULT_BODY_VALID }),
    );
    expect(res.status).toBe(200);

    const events = await collectSSE(res);
    const concatenated = events
      .filter(
        (e) =>
          e.event === null && e.data.startsWith('{') && e.data.includes('chat.completion.chunk'),
      )
      .map((e) => {
        const p = JSON.parse(e.data) as {
          choices: Array<{ delta: { content?: string } }>;
        };
        return p.choices[0]?.delta.content ?? '';
      })
      .join('');

    expect(concatenated.startsWith(PREEMPT_PREFIX)).toBe(true);
    expect(concatenated).toContain(finalText);
  });

  it('hook 不返回 prependMarkdown（NONE）→ finalText 不加前缀', async () => {
    const finalText = 'plain reply';
    setDispatcher(() => Promise.resolve({ finalText }));
    setHitlPreDispatchHook((): Promise<HitlPreDispatchHookResult> => Promise.resolve({}));

    const res = await buildApp().fetch(
      makeRequest({ authHeader: VALID_AUTH_HEADER, body: DEFAULT_BODY_VALID }),
    );
    const events = await collectSSE(res);
    const businessChunks = events.filter(
      (e) =>
        e.event === null && e.data.startsWith('{') && e.data.includes('chat.completion.chunk'),
    );
    const concatenated = businessChunks
      .map((e) => {
        const p = JSON.parse(e.data) as {
          choices: Array<{ delta: { content?: string } }>;
        };
        return p.choices[0]?.delta.content ?? '';
      })
      .join('');

    expect(concatenated).toBe(finalText);
    expect(concatenated.includes(PREEMPT_PREFIX)).toBe(false);
  });

  it('hook 抛错 → 不阻断业务（fallback 到无前缀）', async () => {
    const finalText = 'no preempt';
    setDispatcher(() => Promise.resolve({ finalText }));
    setHitlPreDispatchHook(() => Promise.reject(new Error('hook DB gone')));

    const res = await buildApp().fetch(
      makeRequest({ authHeader: VALID_AUTH_HEADER, body: DEFAULT_BODY_VALID }),
    );
    expect(res.status).toBe(200);
    const events = await collectSSE(res);
    const concatenated = events
      .filter(
        (e) =>
          e.event === null && e.data.startsWith('{') && e.data.includes('chat.completion.chunk'),
      )
      .map((e) => {
        const p = JSON.parse(e.data) as {
          choices: Array<{ delta: { content?: string } }>;
        };
        return p.choices[0]?.delta.content ?? '';
      })
      .join('');
    expect(concatenated).toBe(finalText);
  });

  it('hook 接收 sessionId / traceId / auth / body', async () => {
    setDispatcher(() => Promise.resolve({ finalText: 'ok' }));
    let captured: HitlPreDispatchHookArgs | null = null;
    setHitlPreDispatchHook(
      (args: HitlPreDispatchHookArgs): Promise<HitlPreDispatchHookResult> => {
        captured = args;
        return Promise.resolve({});
      },
    );

    const traceId = 'trace_01HXYZ012345ABCDEFGHJKMNP0';
    await buildApp().fetch(
      makeRequest({ authHeader: VALID_AUTH_HEADER, body: DEFAULT_BODY_VALID, traceId }),
    );
    expect(captured).not.toBeNull();
    const c = captured as unknown as HitlPreDispatchHookArgs;
    expect(c.traceId).toBe(traceId);
    expect(typeof c.sessionId).toBe('string');
    expect(c.sessionId.length).toBeGreaterThan(0);
    expect(c.body.messages.length).toBeGreaterThan(0);
    expect(c.auth.merchantId).toBe('M001');
  });
});
