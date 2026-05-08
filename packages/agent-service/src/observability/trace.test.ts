/**
 * 切片 06 §9.7-§9.8 — traceId 生成 + 校验单测
 */
import { describe, expect, it } from 'vitest';

import { createTraceId, isValidTraceId } from './trace.js';

describe('切片 06 — createTraceId', () => {
  it('应返回 trace_<26 字符 ulid> 形式', () => {
    const id = createTraceId();
    expect(id).toMatch(/^trace_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('不同次调用必须返回不同的 traceId（避免重放）', () => {
    const ids = new Set(Array.from({ length: 100 }, () => createTraceId()));
    expect(ids.size).toBe(100);
  });

  it('生成的 traceId 必须通过 isValidTraceId 校验', () => {
    for (let i = 0; i < 50; i++) {
      expect(isValidTraceId(createTraceId())).toBe(true);
    }
  });
});

describe('切片 06 — isValidTraceId', () => {
  it.each([
    ['trace_01HXYZ012345ABCDEFGHJKMNP0', true],
    ['', false],
    [undefined, false],
    ['trace_short', false],
    ['notrace_01HXYZ012345ABCDEFGHIJK01', false],
    ['trace_lowercase01234567890abcdefg', false],
    ['trace_01HXYZ012345ABCDEFGHIJKL!@', false],
  ])('isValidTraceId(%j) -> %s', (input, expected) => {
    expect(isValidTraceId(input)).toBe(expected);
  });
});
