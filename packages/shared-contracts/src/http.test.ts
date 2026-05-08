/**
 * 切片 04 — OpenAiRequest 占位单测
 * 行为断言:5 个被禁字段(tools/tool_choice/functions/function_call/response_format)被 z.never 拒绝
 */
import { describe, expect, it } from 'vitest';

import { OpenAiRequest } from './http.js';

describe('OpenAiRequest 占位 — V2.1 红线 5 字段拒绝', () => {
  const baseHappy = {
    model: 'store-agent-v1',
    messages: [{ role: 'user' as const, content: '今天 S001 卖得怎么样' }],
    stream: true,
  };

  it('happy(无禁用字段)', () => {
    expect(OpenAiRequest.parse(baseHappy)).toBeDefined();
  });

  it.each(['tools', 'tool_choice', 'functions', 'function_call', 'response_format'])(
    '%s 字段被 z.never() 拒绝',
    (forbidden) => {
      expect(() =>
        OpenAiRequest.parse({ ...baseHappy, [forbidden]: 'anything' }),
      ).toThrow();
    },
  );
});
