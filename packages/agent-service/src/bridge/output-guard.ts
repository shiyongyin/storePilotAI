/**
 * 切片 10 — OutputGuard（tool_calls 防泄漏，T-BRIDGE-04）
 *
 * 严格按 docs/tanks/10-bridge-sse-output-guard.md §8.2 + 任务卡 C-桥接层.md §T-BRIDGE-04 落地。
 *
 * 主要交付：
 *   1. {@link FORBIDDEN_TOKENS}：6 项禁用 token 单源（与任务卡 §5 锁死）。
 *   2. {@link ensureNoToolCallsLeak}：SSE 写入前的 happy-path 校验；命中即抛 `BizError('TOOL_CALLS_LEAK', ..., { httpStatus: 502 })`。
 *   3. {@link logToolCallsLeak}：拦截后的 P0 告警通道 —— 仅记 `outputHash`（前 16 字符 sha256），
 *      绝不打印 `finalText` 原文，并 `metrics.increment('p0.tool_calls_leak')` 上报。
 *
 * 红线（任务卡 §6 MUST DO + §7 MUST NOT）：
 *   - SSE 写入前必须调用 {@link ensureNoToolCallsLeak}；命中必须**拒发**（不允许 regex 替换后继续发回）。
 *   - 命中时 httpStatus 固定 502（与 BizError defaultHttpStatus('TOOL_CALLS_LEAK') 一致）。
 *   - 错误日志或响应中不得回显 `finalText` 原文（`outputHash` 仅 16 字符，足以串联告警和原始请求）。
 *   - `function_call`（即使已 deprecated）仍属拦截清单，避免 LobeChat 插件协议响应。
 *
 * @since 切片 10
 */
import { createHash } from 'node:crypto';

import { BizError } from '@storepilot/shared-contracts';

import { logger } from '../observability/logger.js';
import { metrics } from '../observability/metrics.js';

/* ============================================================================
 * 1) 禁用 token 清单
 * ========================================================================== */

/**
 * 6 项禁用 token —— 与任务卡 §5 / §8.2 1:1 对齐，**禁止下游切片改动顺序或子集**。
 *
 * | token                  | 防什么                                                 |
 * | ---------------------- | ------------------------------------------------------ |
 * | `tool_calls`           | OpenAI 新版 function calling 协议主键                   |
 * | `tool_call_id`         | OpenAI 新版 function calling 子键                       |
 * | `function_call`        | OpenAI 旧版 function calling（已 deprecated 仍要拦）    |
 * | `<tool>` / `</tool>`   | LobeChat 插件协议 XML 标记                              |
 * | `"function":{"name"`   | OpenAI tools schema 的特征片段（兜底防输出 JSON）       |
 *
 * 任意改动必须先回填本切片 + 任务卡 §5 + README §6 一致性矩阵。
 */
export const FORBIDDEN_TOKENS: readonly string[] = Object.freeze([
  'tool_calls',
  'tool_call_id',
  'function_call',
  '<tool>',
  '</tool>',
  '"function":{"name"',
]);

/** outputHash 截断长度（前 16 字符 sha256，与任务卡 §8.2 / §T-BRIDGE-04 §5.3 一致） */
export const OUTPUT_HASH_LENGTH = 16;

/* ============================================================================
 * 2) ensureNoToolCallsLeak
 * ========================================================================== */

/**
 * 校验 SSE 即将写出的最终文本不包含 6 项 OpenAI / LobeChat 工具协议禁用 token。
 *
 * 命中即**立即抛 BizError**（httpStatus=502），由调用方在 SSE catch 分支：
 *   1. 调用 {@link logToolCallsLeak} 落 P0 告警 + outputHash；
 *   2. 用 `friendlyMessage(err)` 包装最后一条 chunk + `[DONE]`；
 *   3. 不得 regex 清洗后继续发回（任务卡 §7 MUST NOT §8）。
 *
 * 设计权衡：
 *   - 使用 `String.prototype.includes`（O(n*m)，m=token 长度，最长 19）；finalText 上限 8000 字符（StrategySchema），
 *     最坏 6 * 8000 ≈ 50k 次 char 比较，远低于 1ms。
 *   - 不使用 regex 是为了避免 ReDoS 与 token 含元字符时的转义噪音。
 *   - meta 仅记命中的 token 字面值（白名单内已知值），不会泄漏 finalText 上下文。
 *
 * @param text 即将写出的 finalText
 * @throws BizError 命中即抛 `code='TOOL_CALLS_LEAK'`、`httpStatus=502`、`meta.token=<命中字面值>`。
 */
export function ensureNoToolCallsLeak(text: string): void {
  for (const token of FORBIDDEN_TOKENS) {
    if (text.includes(token)) {
      throw new BizError('TOOL_CALLS_LEAK', `响应包含禁止字段：${token}`, {
        meta: { token },
        httpStatus: 502,
      });
    }
  }
}

/* ============================================================================
 * 3) logToolCallsLeak
 * ========================================================================== */

/** {@link logToolCallsLeak} 入参 —— 用于 P0 告警上下文串联（traceId / sessionId / merchantId） */
export interface LogToolCallsLeakArgs {
  /** 当前请求 traceId（X-Trace-Id 或桥接层生成） */
  traceId: string;
  /** sessionId（由 {@link inferSessionId} 推断，21 字符） */
  sessionId: string;
  /** 当前租户 merchantId（来自 authenticate 派生，不含明文 API Key） */
  merchantId: string;
  /** finalText 原文 —— 仅用于计算 sha256 outputHash，**不会写入日志** */
  finalText: string;
  /**
   * 命中的 token 字面值（来自 `BizError.meta.token`）。可选；
   * 不传时只记 outputHash 不记 token，仍能定位告警（运维通过 outputHash 联动 RunLog）。
   */
  token?: string;
}

/**
 * 计算 finalText 的 sha256 outputHash 截断（前 16 字符）。
 *
 * 单独导出方便单测断言、以及日志聚合脚本复算（任务卡 §11 自检 §10 验证日志隐私）。
 *
 * @param finalText 原始文本（不限编码 / 长度）
 * @returns 16 字符 hex 字符串
 */
export function hashOutputForAudit(finalText: string): string {
  return createHash('sha256').update(finalText).digest('hex').slice(0, OUTPUT_HASH_LENGTH);
}

/**
 * 拦截后落 P0 告警 + 累加 metrics。
 *
 * 强约束：
 *   - 日志字段固定为 `errorCode='TOOL_CALLS_LEAK'` + `outputHash`，绝不放 `finalText` 原文。
 *   - `metrics.increment('p0.tool_calls_leak')` 失败 / 抛错被适配器吞掉（fail-soft），
 *     不会让告警链路反过来阻塞 SSE。
 *
 * @param args 见 {@link LogToolCallsLeakArgs}
 */
export function logToolCallsLeak(args: LogToolCallsLeakArgs): void {
  const outputHash = hashOutputForAudit(args.finalText);
  logger.error(
    {
      traceId: args.traceId,
      sessionId: args.sessionId,
      merchantId: args.merchantId,
      errorCode: 'TOOL_CALLS_LEAK',
      outputHash,
      token: args.token ?? null,
    },
    '[P0] tool_calls leak blocked',
  );
  metrics.increment('p0.tool_calls_leak');
}
