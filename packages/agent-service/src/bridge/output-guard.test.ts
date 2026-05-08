/**
 * 切片 10 §9 验收 step 9-11 + §10 测试场景 7-9 — output-guard.ts 单测
 *
 * 覆盖（§9 13 步中 OutputGuard 路径）：
 *   - 6 项禁用 token 全拦截（§9 step 10）
 *   - 命中抛 BizError TOOL_CALLS_LEAK + httpStatus=502（§9 step 9）
 *   - logToolCallsLeak：只记 outputHash（前 16 字符 sha256），不记 finalText 原文（§9 step 11）
 *   - metrics.increment('p0.tool_calls_leak') 必须被调用（§9 step 9）
 *
 * 测试基础设施：
 *   - SpyMetricsAdapter：捕获 increment 调用，验证 P0 计数器命中。
 *   - vi.spyOn(logger, 'error')：捕获日志字段，验证日志中无 finalText 原文。
 *   - 注入由 setMetricsAdapter（DI）完成；afterEach reset 防止泄漏。
 */
import { BizError } from '@storepilot/shared-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../observability/logger.js';
import {
  resetMetricsAdapterForTest,
  setMetricsAdapter,
  type MetricsAdapter,
} from '../observability/metrics.js';

import {
  FORBIDDEN_TOKENS,
  ensureNoToolCallsLeak,
  hashOutputForAudit,
  logToolCallsLeak,
} from './output-guard.js';

/* ============================================================================
 * SpyMetrics — 捕获 increment 调用
 * ========================================================================== */
class SpyMetrics implements MetricsAdapter {
  public readonly calls: Array<{
    name: string;
    value?: number;
    tags?: Record<string, string>;
  }> = [];

  increment(name: string, value?: number, tags?: Record<string, string>): void {
    const call: { name: string; value?: number; tags?: Record<string, string> } = { name };
    if (value !== undefined) call.value = value;
    if (tags !== undefined) call.tags = tags;
    this.calls.push(call);
  }
}

/* ============================================================================
 * 1) FORBIDDEN_TOKENS 锁定
 * ========================================================================== */

describe('切片 10 — FORBIDDEN_TOKENS（任务卡 §5 单源锁定）', () => {
  it('必须严格 6 项，与任务卡 §5 顺序一致', () => {
    expect([...FORBIDDEN_TOKENS]).toEqual([
      'tool_calls',
      'tool_call_id',
      'function_call',
      '<tool>',
      '</tool>',
      '"function":{"name"',
    ]);
  });

  it('数组必须 frozen（防下游切片误改）', () => {
    expect(Object.isFrozen(FORBIDDEN_TOKENS)).toBe(true);
  });
});

/* ============================================================================
 * 2) ensureNoToolCallsLeak — 6 token 全拦截 + httpStatus=502
 * ========================================================================== */

describe('切片 10 — ensureNoToolCallsLeak（§9 step 9 / step 10）', () => {
  it('纯 markdown 文本不抛错', () => {
    expect(() =>
      ensureNoToolCallsLeak('# 今日日报\n销售 1200 元，毛利 35%，新客 8 人。'),
    ).not.toThrow();
  });

  it.each(FORBIDDEN_TOKENS)('token "%s" 命中即抛 BizError(TOOL_CALLS_LEAK)', (token) => {
    const text = `prefix ${token} suffix`;
    expect(() => ensureNoToolCallsLeak(text)).toThrow(BizError);
    try {
      ensureNoToolCallsLeak(text);
    } catch (err) {
      expect(err).toBeInstanceOf(BizError);
      const e = err as BizError;
      expect(e.code).toBe('TOOL_CALLS_LEAK');
      expect(e.httpStatus).toBe(502);
      expect(e.meta).toMatchObject({ token });
      // friendlyMessage 不直接产生于此（由调用方包装）；这里只验 message 含 token 字面值
      expect(e.message).toContain(token);
    }
  });

  it('命中后抛错的 BizError httpStatus 必须固定 502（任务卡 §6 MUST DO §9）', () => {
    try {
      ensureNoToolCallsLeak('this leaks tool_calls');
    } catch (err) {
      expect((err as BizError).httpStatus).toBe(502);
    }
  });

  it('命中**第一个** token 即停（短路 + meta.token 为命中那个）', () => {
    // 同时含 tool_calls 与 function_call；FORBIDDEN_TOKENS 顺序保证 tool_calls 先命中
    try {
      ensureNoToolCallsLeak('mix tool_calls and function_call');
    } catch (err) {
      expect((err as BizError).meta).toMatchObject({ token: 'tool_calls' });
    }
  });

  it('部分匹配（如 tool_callsXY）也算命中（includes 语义）', () => {
    expect(() => ensureNoToolCallsLeak('weird tool_callsXYZ inside')).toThrow(BizError);
  });

  it('OpenAI tools schema 片段 `"function":{"name"` 也命中（含特殊字符 token）', () => {
    expect(() => ensureNoToolCallsLeak('{"function":{"name":"calc"}}')).toThrow(BizError);
  });
});

/* ============================================================================
 * 3) hashOutputForAudit
 * ========================================================================== */

describe('切片 10 — hashOutputForAudit', () => {
  it('返回前 16 字符 sha256 hex（任务卡 §8.2 §3）', () => {
    const hash = hashOutputForAudit('hello');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('相同输入必须产生相同 hash（确定性）', () => {
    expect(hashOutputForAudit('abc')).toBe(hashOutputForAudit('abc'));
  });

  it('不同输入产生不同 hash（避免冲突）', () => {
    expect(hashOutputForAudit('a')).not.toBe(hashOutputForAudit('b'));
  });
});

/* ============================================================================
 * 4) logToolCallsLeak — 日志隐私 + metrics 上报
 * ========================================================================== */

describe('切片 10 — logToolCallsLeak（§9 step 11 日志隐私）', () => {
  let spyMetrics: SpyMetrics;

  beforeEach(() => {
    spyMetrics = new SpyMetrics();
    setMetricsAdapter(spyMetrics);
  });

  afterEach(() => {
    resetMetricsAdapterForTest();
    vi.restoreAllMocks();
  });

  it('日志字段必须含 errorCode / outputHash / traceId / sessionId / merchantId，绝不含 finalText 原文', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation((() => undefined) as never);

    const finalText = 'leaked content with tool_calls payload that must NOT show up in logs';
    logToolCallsLeak({
      traceId: 'trace_abc123',
      sessionId: 'sess_0123456789abcdef',
      merchantId: 'M001',
      finalText,
      token: 'tool_calls',
    });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [fields, msg] = errorSpy.mock.calls[0]! as [Record<string, unknown>, string];
    expect(msg).toBe('[P0] tool_calls leak blocked');
    expect(fields).toMatchObject({
      traceId: 'trace_abc123',
      sessionId: 'sess_0123456789abcdef',
      merchantId: 'M001',
      errorCode: 'TOOL_CALLS_LEAK',
      token: 'tool_calls',
    });
    expect(fields['outputHash']).toBe(hashOutputForAudit(finalText));
    expect(fields['outputHash']).toMatch(/^[0-9a-f]{16}$/);

    // 关键隐私断言：日志字段中不得出现 finalText 原文（任务卡 §7 MUST NOT §5）
    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain(finalText);
    expect(serialized).not.toContain('leaked content');
    expect(serialized).not.toContain('payload that must NOT');
  });

  it('metrics.increment("p0.tool_calls_leak") 必须被调用一次（§9 step 9）', () => {
    logToolCallsLeak({
      traceId: 'trace_x',
      sessionId: 'sess_0000000000000000',
      merchantId: 'M001',
      finalText: 'with tool_calls token',
    });

    expect(spyMetrics.calls).toEqual([
      { name: 'p0.tool_calls_leak' },
    ]);
  });

  it('未传 token 时日志 token 字段为 null（兜底，仍可定位告警）', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation((() => undefined) as never);

    logToolCallsLeak({
      traceId: 'trace_y',
      sessionId: 'sess_0000000000000000',
      merchantId: 'M002',
      finalText: 'x',
    });

    const [fields] = errorSpy.mock.calls[0]! as [Record<string, unknown>, string];
    expect(fields['token']).toBeNull();
  });
});
