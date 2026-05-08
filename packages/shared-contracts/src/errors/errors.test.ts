/**
 * 切片 04 — ErrorCode 27 + BizError + 派生 单测
 * 行为断言:
 *   - ErrorCode 27 项快照
 *   - BizError httpStatus 派生表覆盖(401/429/400/503/502/500)
 *   - retryable 默认表覆盖
 *   - toOpenAiError 形状 { error: { code, message, type: 'invalid_request_error' } }
 */
import { describe, expect, it } from 'vitest';

import { BizError, ErrorCode, defaultHttpStatus, defaultRetryable } from './index.js';

describe('ErrorCode 27 项', () => {
  it('Object.keys(ErrorCode).length === 27', () => {
    expect(Object.keys(ErrorCode)).toHaveLength(27);
  });

  it('6 类分组完整(snapshot)', () => {
    const codes = Object.values(ErrorCode).sort();
    expect(codes).toMatchInlineSnapshot(`
      [
        "ADJUSTMENT_SKU_UNMATCHED",
        "ADJUSTMENT_TOO_MANY",
        "DB_UNAVAILABLE",
        "DRAFT_ALREADY_SUBMITTED",
        "DRAFT_EXPIRED",
        "DRAFT_NOT_FOUND",
        "INTENT_LOW_CONFIDENCE",
        "INTERNAL_ERROR",
        "INVALID_REQUEST",
        "MCP_TIMEOUT",
        "MCP_TOOL_NOT_WHITELISTED",
        "MCP_UNAVAILABLE",
        "MODEL_TIMEOUT",
        "MODEL_UNAVAILABLE",
        "MULTI_INTENT_TOO_MANY",
        "NOT_IMPLEMENTED_IN_V1",
        "NUMBER_INCONSISTENT",
        "PROMPT_INJECTION",
        "RATE_LIMITED",
        "RESUME_RACE",
        "SCHEMA_FAIL",
        "SKILL_NOT_AVAILABLE",
        "SUSPEND_EXPIRED",
        "SUSPEND_NOT_FOUND",
        "TOOL_CALLS_LEAK",
        "UNAUTHORIZED",
        "USER_CANCELLED",
      ]
    `);
  });
});

describe('defaultHttpStatus 派生表', () => {
  it.each<[ErrorCode, number]>([
    ['UNAUTHORIZED', 401],
    ['RATE_LIMITED', 429],
    ['INVALID_REQUEST', 400],
    ['INTENT_LOW_CONFIDENCE', 400],
    ['MCP_UNAVAILABLE', 503],
    ['MCP_TIMEOUT', 503],
    ['MCP_TOOL_NOT_WHITELISTED', 503],
    ['MODEL_UNAVAILABLE', 503],
    ['DB_UNAVAILABLE', 503],
    ['TOOL_CALLS_LEAK', 502],
    ['PROMPT_INJECTION', 502],
    ['SCHEMA_FAIL', 500],
    ['DRAFT_NOT_FOUND', 500],
    ['INTERNAL_ERROR', 500],
  ])('%s → %d', (code, expected) => {
    expect(defaultHttpStatus(code)).toBe(expected);
  });
});

describe('defaultRetryable 派生表', () => {
  it.each<[ErrorCode, boolean]>([
    ['MCP_UNAVAILABLE', true],
    ['MCP_TIMEOUT', true],
    ['MODEL_UNAVAILABLE', true],
    ['MODEL_TIMEOUT', true],
    ['DB_UNAVAILABLE', true],
    ['SCHEMA_FAIL', true],
    ['NUMBER_INCONSISTENT', true],
    ['UNAUTHORIZED', false],
    ['INVALID_REQUEST', false],
    ['DRAFT_NOT_FOUND', false],
    ['USER_CANCELLED', false],
    ['INTERNAL_ERROR', false],
    ['TOOL_CALLS_LEAK', false],
  ])('%s → %s', (code, expected) => {
    expect(defaultRetryable(code)).toBe(expected);
  });
});

describe('BizError 实例', () => {
  it('UNAUTHORIZED 默认 httpStatus 401 + retryable false', () => {
    const err = new BizError('UNAUTHORIZED', '无效 API Key');
    expect(err.httpStatus).toBe(401);
    expect(err.retryable).toBe(false);
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.name).toBe('BizError');
    expect(err instanceof Error).toBe(true);
    expect(err instanceof BizError).toBe(true);
  });

  it('MCP_TIMEOUT 默认 httpStatus 503 + retryable true', () => {
    const err = new BizError('MCP_TIMEOUT', 'ERP 超时');
    expect(err.httpStatus).toBe(503);
    expect(err.retryable).toBe(true);
  });

  it('TOOL_CALLS_LEAK 默认 httpStatus 502', () => {
    expect(new BizError('TOOL_CALLS_LEAK', 'leaked').httpStatus).toBe(502);
  });

  it('ctx 覆盖 retryable / httpStatus / meta / traceId', () => {
    const err = new BizError('SCHEMA_FAIL', 'bad output', {
      retryable: false,
      httpStatus: 422,
      meta: { sql: 'SELECT *' },
      traceId: 'trace-001',
    });
    expect(err.retryable).toBe(false);
    expect(err.httpStatus).toBe(422);
    expect(err.meta).toEqual({ sql: 'SELECT *' });
    expect(err.traceId).toBe('trace-001');
  });

  it('cause 透传给 Error.cause', () => {
    const root = new Error('mysql ECONNREFUSED');
    const err = new BizError('DB_UNAVAILABLE', 'db down', { cause: root });
    expect(err.cause).toBe(root);
  });

  it('toOpenAiError 形状 { error: { code, message, type } }', () => {
    const out = new BizError('UNAUTHORIZED', '无效的 API Key').toOpenAiError();
    expect(out).toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: '无效的 API Key',
        type: 'invalid_request_error',
      },
    });
  });

  it('toOpenAiError 不暴露 stack / meta / traceId', () => {
    const err = new BizError('SCHEMA_FAIL', 'fail', {
      meta: { sql: 'SELECT * FROM secret' },
      traceId: 'abc',
    });
    const body = err.toOpenAiError();
    const json = JSON.stringify(body);
    expect(json).not.toContain('SELECT');
    expect(json).not.toContain('abc');
    expect(json).not.toContain('stack');
    expect(json).not.toContain('meta');
  });
});
