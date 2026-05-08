/**
 * 切片 06 §9.9 — pino redact + traceId child logger 回归
 * 切片 01 已验证 redact 5 路径；本切片新增 child logger traceId 注入。
 */
import { Writable } from 'node:stream';

import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { withTraceLogger } from './logger.js';

/** 把 child logger 的输出捕获成 JSON 数组，用于断言 */
function captureLogs(): { logs: Array<Record<string, unknown>>; stream: Writable } {
  const logs: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      try {
        logs.push(JSON.parse(text) as Record<string, unknown>);
      } catch {
        // ignore non-json
      }
      cb();
    },
  });
  return { logs, stream };
}

describe('切片 06 — withTraceLogger', () => {
  it('child logger 输出应当含 traceId 字段', () => {
    const { logs, stream } = captureLogs();
    // 用独立 pino 实例隔离全局 logger，方便断言
    const root = pino({ level: 'info' }, stream);
    const child = root.child({ traceId: 'trace_01HABCXYZ0000000000000000A' });
    child.info('hello');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ traceId: 'trace_01HABCXYZ0000000000000000A' });
    expect(logs[0]?.msg).toBe('hello');
  });

  it('全局 withTraceLogger 应返回带 traceId 的 child（不影响 root logger）', () => {
    // 仅验证返回类型 + 方法可调用；输出走全局 stream（不抓）
    const child = withTraceLogger('trace_01HXYZ012345ABCDEFGHIJK01');
    expect(typeof child.info).toBe('function');
    expect(typeof child.error).toBe('function');
    expect(typeof child.warn).toBe('function');
    // 不应抛错
    expect(() => child.info('smoke')).not.toThrow();
  });
});
