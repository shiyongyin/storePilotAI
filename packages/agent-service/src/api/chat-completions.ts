/**
 * 切片 10 — POST /v1/chat/completions（桥接层入口，T-BRIDGE-03 + T-BRIDGE-04 合并）
 *
 * 严格按 docs/tanks/10-bridge-sse-output-guard.md §8.3 + 任务卡 C-桥接层.md §T-BRIDGE-03/04 落地。
 *
 * 请求处理链路（顺序固定，不可换层）：
 *   1. {@link authenticate} — Bearer API Key 鉴权 + 派生 merchantId/storeId/userId/apiKeyPrefix（切片 09）。
 *   2. `OpenAiRequest.safeParse` — 显式拒绝 `tools/tool_choice/functions/function_call/response_format`（切片 04 落地的 `z.never()`）。
 *   3. {@link inferSessionId} + traceId helper — sessionId 推断 + traceId 5 层贯穿（切片 09 / 06）。
 *   4. SSE 头：`Content-Type: text/event-stream; charset=utf-8` + `Cache-Control: no-cache, no-transform`
 *      + `Connection: keep-alive` + `X-Accel-Buffering: no`（任务卡 §6 MUST DO §3）。
 *   5. {@link streamSSE}：
 *      - 注册 15s `event: ping` 心跳（任务卡 §6 MUST DO §4）；
 *      - `stream.onAbort` 清理 heartbeat + flag 取消业务（任务卡 §7 MUST NOT §4）；
 *      - 调用 {@link dispatchByIntent} 占位（真业务路由由阶段 5/6 切片落地）；
 *      - {@link ensureNoToolCallsLeak} 命中拒发 + {@link logToolCallsLeak} P0 告警；
 *      - {@link chunkByGrapheme} 默认 320 grapheme 切分；
 *      - 终止顺序 `finish_reason='stop'` chunk → `data: [DONE]`；
 *      - 中途异常用 `delta.content = '\n\n⚠️ ' + friendlyMessage(err)` + `[DONE]` 包装（V2.1 红线 5）。
 *
 * 强约束（违反即拒收 / 任务卡 §7 MUST NOT）：
 *   - 不得用 Vercel AI SDK 的 `toTextStream*` helper（V2.1 红线 4，仓级 grep 0 命中；本仓不直接出现该字面量）。
 *   - 不得在 SSE 流中途返 OpenAI Error JSON 体（破坏 LobeChat 协议）。
 *   - 不得让 chunk > 800 字符（{@link chunkByGrapheme} 默认 320，单段最大 800）。
 *   - 不得在错误日志或响应中回显 finalText 原文（仅 outputHash）。
 *
 * @since 切片 10
 */
import { Hono } from 'hono';
import type { SSEStreamingApi } from 'hono/streaming';
import { streamSSE } from 'hono/streaming';
import { ZodError } from 'zod';

import {
  BizError,
  OpenAiRequest,
  friendlyMessage,
  type OpenAiRequest as OpenAiRequestType,
} from '@storepilot/shared-contracts';

import { authenticate, type AuthResult } from '../bridge/auth.js';
import {
  ensureNoToolCallsLeak,
  logToolCallsLeak,
  type LogToolCallsLeakArgs,
} from '../bridge/output-guard.js';
import { inferSessionId } from '../bridge/session.js';
import {
  chunkByGrapheme,
  DEFAULT_CHUNK_GRAPHEMES,
  writeDone,
  writeOpenAiChunk,
} from '../bridge/sse.js';
import { logger, withTraceLogger } from '../observability/logger.js';
import { createTraceId, isValidTraceId } from '../observability/trace.js';
import {
  registerActiveStream,
  unregisterActiveStream,
} from '../safety/active-streams.js';

/* ============================================================================
 * 1) Dispatcher（占位 + DI）
 * ========================================================================== */

/**
 * Dispatcher 入参 —— 与切片 06 RuntimeContext 7 字段对齐；仅本切片消费 sessionId / traceId / merchant /
 * authResult.body 等元数据，业务参数完整透传给阶段 5/6 切片实现的 dispatch。
 */
export interface DispatchArgs {
  /** 经 zod 校验的 OpenAI 请求体；下游可信任 schema 已通过 */
  body: OpenAiRequestType;
  /** authenticate 命中的租户身份（含 merchantId/storeId/userId/apiKeyPrefix） */
  auth: Extract<AuthResult, { ok: true }>;
  /** sessionId（21 字符，sess_ 前缀） */
  sessionId: string;
  /** traceId（trace_<26 char ulid>） */
  traceId: string;
  /**
   * 客户端 abort signal —— 业务可订阅 `signal.aborted` 提前结束 long-running 工具调用，
   * 避免连接断开后仍空跑业务 / DB 写。
   */
  abortSignal: AbortSignal;
}

/** Dispatcher 返回值 —— 仅 `finalText`（已经过业务格式化的 markdown，未经 OutputGuard 校验） */
export interface DispatchResult {
  finalText: string;
}

/**
 * Dispatcher 函数签名。占位实现见 {@link defaultDispatcher}；阶段 5/6 切片在 mastra workflows 注册后
 * 通过 {@link setDispatcher} 注入完整版（包含 ConfirmManager.tickAtUserMessage / IntentRouter / 11 IntentEnum 路由）。
 */
export type DispatchFn = (args: DispatchArgs) => Promise<DispatchResult>;

/**
 * 默认 dispatcher：仅返回占位 markdown，告知调用方真实业务路由由阶段 5/6 切片接管。
 *
 * 设计权衡：占位文本中故意不包含 6 项禁用 token，保证 happy path 测试与切片 10 验收第 1 / 2 / 3 步绿灯；
 * 切片 11 起会替换为基于 IntentRouter + 11 IntentEnum 的 switch 实现。
 */
const PLACEHOLDER_TEXT =
  '【占位回答】当前为切片 10（桥接层 SSE + OutputGuard）骨架；' +
  '完整业务路由（IntentRouter + 11 IntentEnum + Workflow dispatch）由阶段 5/6 切片接管。';

export const defaultDispatcher: DispatchFn = async () => {
  return Promise.resolve({ finalText: PLACEHOLDER_TEXT });
};

let registeredDispatcher: DispatchFn = defaultDispatcher;

/**
 * 注入业务 dispatcher（生产由阶段 5/6 切片调用一次；测试由 beforeEach 注入 fake）。
 */
export function setDispatcher(fn: DispatchFn): void {
  registeredDispatcher = fn;
}

/** 测试辅助：恢复占位 dispatcher，避免用例间互相污染。 */
export function resetDispatcherForTest(): void {
  registeredDispatcher = defaultDispatcher;
}

/* ============================================================================
 * 1.5) HITL pre-dispatch hook —— 切片 16（ConfirmManager.tickAtUserMessage 网关）
 * ========================================================================== */

/**
 * Pre-dispatch hook 入参 —— 提供给 hook 实现进行 intent 分类 / runtimeContext 构造 /
 * ConfirmManager.tickAtUserMessage 调用。
 *
 * @since 切片 16
 */
export interface HitlPreDispatchHookArgs {
  /** 经 zod 校验的 OpenAI 请求体；hook 内部按需读取 messages / model 等 */
  body: OpenAiRequestType;
  /** authenticate 命中的租户身份（含 merchantId/storeId/userId/apiKeyPrefix） */
  auth: Extract<AuthResult, { ok: true }>;
  /** sessionId（21 字符，sess_ 前缀） */
  sessionId: string;
  /** traceId（trace_<26 char ulid>） */
  traceId: string;
}

/**
 * Pre-dispatch hook 返回值。
 *
 * - {@link prependMarkdown}：抢占（PREEMPT）场景下要在最终 markdown 顶部追加的提示
 *   （如"已为您取消上一次的待确认采购单"）；其它场景为空字符串 / undefined。
 *
 * @since 切片 16
 */
export interface HitlPreDispatchHookResult {
  /** 抢占提示前缀；hook 决定是否注入 */
  prependMarkdown?: string;
}

/**
 * Pre-dispatch hook 函数签名（任务卡 §7 MUST DO §2：tickAtUserMessage 必须在 dispatch 前调用）。
 *
 * 生产由 server bootstrap 注入：
 *   - intent 分类（classifyIntent / intentRouter）
 *   - 构造 runtimeContext
 *   - 调 {@link ../safety/confirm-manager.tickAtUserMessage}
 *   - 抢占场景返回 `{ prependMarkdown: PREEMPT_MARKDOWN_PREFIX }`
 *
 * 测试可注入 fake hook 验证 prepend 行为。
 *
 * @since 切片 16
 */
export type HitlPreDispatchHook = (
  args: HitlPreDispatchHookArgs,
) => Promise<HitlPreDispatchHookResult>;

let registeredHitlPreDispatchHook: HitlPreDispatchHook | null = null;

/**
 * 注入 pre-dispatch hook（生产由 server bootstrap 调用一次；测试由 beforeEach 注入 fake）。
 *
 * @since 切片 16
 */
export function setHitlPreDispatchHook(fn: HitlPreDispatchHook): void {
  registeredHitlPreDispatchHook = fn;
}

/**
 * 测试辅助：恢复 NULL hook，避免用例间相互污染。
 *
 * @since 切片 16
 */
export function resetHitlPreDispatchHookForTest(): void {
  registeredHitlPreDispatchHook = null;
}

/* ============================================================================
 * 2) 心跳间隔（DI 测试用；生产固定 15_000ms）
 * ========================================================================== */

/** SSE 心跳默认间隔（任务卡 §6 MUST DO §4：15 秒） */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

let heartbeatIntervalMs: number = DEFAULT_HEARTBEAT_INTERVAL_MS;

/**
 * 单测专用：调低心跳间隔，避免 60s 真等。
 *
 * 生产路径**绝不**调用此函数；切片 21 会接入告警面板时也保留 15s 默认值。
 */
export function _setHeartbeatIntervalForTest(ms: number): void {
  if (!Number.isInteger(ms) || ms <= 0) {
    throw new RangeError(`heartbeat 间隔必须正整数毫秒，收到 ${ms}`);
  }
  heartbeatIntervalMs = ms;
}

/** 单测辅助：恢复默认 15_000ms 心跳。 */
export function _resetHeartbeatIntervalForTest(): void {
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS;
}

/* ============================================================================
 * 3) Router
 * ========================================================================== */

/** 渲染 OpenAI 兼容 401（任务卡 §8.3 §1）。统一 message，不暴露具体原因。 */
const UNAUTHORIZED_BODY = {
  error: {
    code: 'UNAUTHORIZED' as const,
    message: '无效的 API Key',
    type: 'invalid_request_error' as const,
  },
};

/** 渲染 OpenAI 兼容 400（任务卡 §8.3 §2）。zod schema 拒绝 tools/... 等字段 → 此响应。 */
const INVALID_REQUEST_BODY = {
  error: {
    code: 'INVALID_REQUEST' as const,
    message: '请求体校验失败',
    type: 'invalid_request_error' as const,
  },
};

/**
 * 桥接层路由 —— 内部仅 `POST /chat/completions` 一条；
 * 由 server.ts 通过 `app.route('/v1', chatCompletionsRouter)` 挂载，
 * 最终对外 path = `POST /v1/chat/completions`（任务卡 §8.4 + 切片 10 prompt §4 一致）。
 *
 * 这样组织的好处：
 *   - 切片 11+ 可以直接复用 chatCompletionsRouter，把更多路径挂在 /v1 下；
 *   - 路由内部 path 与 mount prefix 一一对应，避免 server.ts 写死 /v1/chat/completions 双源不一致。
 */
export const chatCompletionsRouter = new Hono();

chatCompletionsRouter.post('/chat/completions', async (c) => {
  /* -------- step 1: authenticate -------- */
  let auth: AuthResult;
  try {
    auth = await authenticate(c.req.header('Authorization'));
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      '[chat-completions] authenticate threw; treating as unauthorized',
    );
    return c.json(UNAUTHORIZED_BODY, 401);
  }
  if (!auth.ok) {
    return c.json(UNAUTHORIZED_BODY, 401);
  }

  /* -------- step 2: 解析 + zod 校验（拒绝 tools / tool_choice / ...） -------- */
  let bodyRaw: unknown;
  try {
    bodyRaw = await c.req.json();
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '[chat-completions] body json parse failed',
    );
    return c.json(INVALID_REQUEST_BODY, 400);
  }
  const parsed = OpenAiRequest.safeParse(bodyRaw);
  if (!parsed.success) {
    if (parsed.error instanceof ZodError) {
      logger.warn(
        { issues: parsed.error.issues.map((it) => ({ path: it.path, code: it.code })) },
        '[chat-completions] OpenAiRequest schema rejected',
      );
    }
    return c.json(INVALID_REQUEST_BODY, 400);
  }
  const body = parsed.data;

  /* -------- step 3: sessionId + traceId -------- */
  const sessionId = inferSessionId({
    apiKeyPrefix: auth.apiKeyPrefix,
    messages: body.messages,
  });
  const headerTrace = c.req.header('X-Trace-Id');
  const traceId = isValidTraceId(headerTrace) ? (headerTrace as string) : createTraceId();
  const log = withTraceLogger(traceId);

  /* -------- step 4: SSE 头（必须先于 streamSSE 设置 -------- */
  // streamSSE 内部会再 c.header(Cache-Control, 'no-cache')；我们在 streamSSE 返回后通过 res.headers.set
  // 强制覆写为 'no-cache, no-transform' + 追加 X-Accel-Buffering: no（任务卡 §6 MUST DO §3）。

  const response = streamSSE(c, async (stream: SSEStreamingApi) => {
    /* -------- step 5a: 心跳（默认 15s） -------- */
    const heartbeat: ReturnType<typeof setInterval> = setInterval(() => {
      // 心跳写失败仅 debug；不能让 setInterval 回调抛错冒泡到 Node unhandledRejection
      void stream
        .writeSSE({ event: 'ping', data: String(Date.now()) })
        .catch((e: unknown) => {
          log.debug(
            { err: e instanceof Error ? e.message : String(e) },
            '[chat-completions] heartbeat write failed',
          );
        });
    }, heartbeatIntervalMs);

    /* -------- step 5b: abort flag + AbortController 透传给 dispatch -------- */
    const abortController = new AbortController();
    let aborted = false;

    // 切片 20 — 注册活跃流，让 SIGTERM 优雅停机能等所有 SSE 收尾或被强制 abort。
    // finally 阶段必须 unregister，避免内存里保留大量已结束的 controller。
    registerActiveStream(abortController);

    stream.onAbort(() => {
      aborted = true;
      clearInterval(heartbeat);
      abortController.abort(new Error('client aborted'));
      log.info({ traceId, sessionId }, '[chat-completions] client aborted; stream closed');
    });

    try {
      /* -------- step 5c: HITL pre-dispatch hook（切片 16 — ConfirmManager.tickAtUserMessage） -------- */
      // 任务卡 16 §7 MUST DO §2：tickAtUserMessage 必须在 dispatch **之前**调用。
      // hook 内部完成 intent 分类 + runtimeContext 构造 + ConfirmManager.tickAtUserMessage；
      // 抢占（PREEMPT）场景返回 prependMarkdown，桥接层在最终 markdown 顶部注入提示。
      // hook 抛错只走 log.warn 不阻断业务（任务卡 §7 MUST DO §1：tick 不得让聊天链路挂掉）。
      let hitlPrependMarkdown = '';
      if (registeredHitlPreDispatchHook) {
        try {
          const hookResult = await registeredHitlPreDispatchHook({
            body,
            auth,
            sessionId,
            traceId,
          });
          if (hookResult.prependMarkdown) {
            hitlPrependMarkdown = hookResult.prependMarkdown;
          }
        } catch (err) {
          log.warn(
            {
              err: err instanceof Error ? err.message : String(err),
              sessionId,
              traceId,
            },
            '[chat-completions] HITL pre-dispatch hook failed (degrading to NONE)',
          );
        }
      }

      /* -------- step 6: dispatch（占位；阶段 5/6 切片注入完整版） -------- */
      const result = await registeredDispatcher({
        body,
        auth,
        sessionId,
        traceId,
        abortSignal: abortController.signal,
      });

      // 抢占（PREEMPT）markdown 顶部提示 —— 任务卡 16 §8.5
      const finalText = hitlPrependMarkdown + result.finalText;

      /* -------- step 7: OutputGuard（命中拒发 + P0 告警） -------- */
      try {
        ensureNoToolCallsLeak(finalText);
      } catch (err) {
        const leakArgs: LogToolCallsLeakArgs = {
          traceId,
          sessionId,
          merchantId: auth.merchantId,
          finalText,
        };
        if (err instanceof BizError) {
          const tokenMeta = err.meta['token'];
          if (typeof tokenMeta === 'string') {
            leakArgs.token = tokenMeta;
          }
        }
        logToolCallsLeak(leakArgs);
        throw err;
      }

      /* -------- step 8: chunkByGrapheme + 写出 + writeDone -------- */
      const chunks = chunkByGrapheme(finalText, DEFAULT_CHUNK_GRAPHEMES);
      for (const chunk of chunks) {
        if (aborted) break;
        await writeOpenAiChunk(stream, { id: traceId, content: chunk });
      }
      if (!aborted) {
        await writeDone(stream, { id: traceId });
        await stream.close();
      }
    } catch (err) {
      /* -------- step 9: 中途异常（V2.1 红线 5：禁返 JSON Error 体） -------- */
      if (aborted) {
        log.debug(
          { err: err instanceof Error ? err.message : String(err) },
          '[chat-completions] dispatch threw after abort; suppressing write',
        );
      } else {
        log.warn(
          {
            errCode: err instanceof BizError ? err.code : 'INTERNAL_ERROR',
            err: err instanceof Error ? err.message : String(err),
          },
          '[chat-completions] mid-stream exception; wrapping into delta.content',
        );
        try {
          await writeOpenAiChunk(stream, {
            id: traceId,
            content: `\n\n⚠️ ${friendlyMessage(err)}`,
          });
          await writeDone(stream, { id: traceId });
          await stream.close();
        } catch (writeErr) {
          // 写已关闭流不允许冒泡到 Hono `run()` 的 onError 默认 console.error 分支
          log.debug(
            { err: writeErr instanceof Error ? writeErr.message : String(writeErr) },
            '[chat-completions] failed to write friendly final chunk',
          );
        }
      }
    } finally {
      clearInterval(heartbeat);
      // 切片 20 — 解除注册，无论正常 / 异常 / abort 路径都执行
      unregisterActiveStream(abortController);
    }
  });

  /* -------- step 10: 覆写 SSE 头部（streamSSE 内部已设默认值） -------- */
  // streamSSE 默认设置 'Cache-Control: no-cache' / 'Content-Type: text/event-stream' / 'Connection: keep-alive' /
  // 'Transfer-Encoding: chunked'。任务卡 §6 MUST DO §3 要求：
  //   - Cache-Control: no-cache, no-transform
  //   - Content-Type:  text/event-stream; charset=utf-8
  //   - X-Accel-Buffering: no
  // 这里直接 mutate Response.headers 覆写（Headers 在 c.newResponse 后仍可写）。
  response.headers.set('Cache-Control', 'no-cache, no-transform');
  response.headers.set('Content-Type', 'text/event-stream; charset=utf-8');
  response.headers.set('X-Accel-Buffering', 'no');
  // Connection / Transfer-Encoding 已由 streamSSE 设置 'keep-alive' / 'chunked'，无需覆写。
  return response;
});
