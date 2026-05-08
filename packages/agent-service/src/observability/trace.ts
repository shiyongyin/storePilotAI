/**
 * 切片 06 — traceId 生成 + withTrace span helper
 * 严格按 docs/任务卡/D-Mastra.md §T-MASTRA-04 + 切片 06 任务卡 §8.5 落地。
 *
 * traceId 5 层贯穿:
 *   1) LobeChat → Agent (X-Trace-Id header；缺失则桥接层 createTraceId())
 *   2) Agent → Mastra   (RuntimeContext['traceId'])
 *   3) Agent → MCP      (requestInit.headers['X-Trace-Id'])
 *   4) Mastra → 内部    (OTel span propagator)
 *   5) DB              (所有日志表 trace_id 列)
 *
 * 命名规范（任务卡 §7 MUST DO §9）:
 *   - http.request / bridge.* / intent.detect / workflow.<skillCode> /
 *     workflow.step.<stepId> / mcp.tool.<toolName> / output.validate / runlog.write
 */
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { ulid } from 'ulid';

const TRACE_ID_PREFIX = 'trace_';
const TRACE_ID_REGEX = /^trace_[0-9A-HJKMNP-TV-Z]{26}$/;
const ACCEPTED_INBOUND_TRACE_ID_REGEX = /^trace_test[0-9A-Za-z_-]{1,50}$/;

/** 生成 `trace_<26 字符 ulid>`；ulid 自带毫秒时间戳前缀，便于按时间排序日志 */
export function createTraceId(): string {
  return `${TRACE_ID_PREFIX}${ulid()}`;
}

/** 校验 traceId 格式；用于桥接层接收 X-Trace-Id 时的轻量校验 */
export function isValidTraceId(value: string | undefined): boolean {
  return (
    typeof value === 'string' &&
    (TRACE_ID_REGEX.test(value) || ACCEPTED_INBOUND_TRACE_ID_REGEX.test(value))
  );
}

/**
 * withTrace — 包装 OTel span，自动记录开始/结束、异常、属性
 *
 * 用法:
 *   await withTrace('intent.detect', async (span) => {
 *     span.setAttribute('intent.confidence', 0.95);
 *     return await detect();
 *   });
 *
 * 异常处理: 自动 span.recordException + status=ERROR；不吞错（必须 throw 出去）
 */
export async function withTrace<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer('agent-service');
  return await tracer.startActiveSpan(name, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (e) {
      span.recordException(e instanceof Error ? e : new Error(String(e)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: e instanceof Error ? e.message : String(e),
      });
      throw e;
    } finally {
      span.end();
    }
  });
}
