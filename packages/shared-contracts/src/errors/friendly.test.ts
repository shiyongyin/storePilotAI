/**
 * 切片 04 — friendlyMessage 单测
 * 行为断言:
 *   - 27 个 ErrorCode 全部触发 friendlyMessage 不抛错
 *   - 输出全为非空中文(简单 contains 中文检测)
 *   - 不暴露 err.meta / err.stack / SQL / 表名
 *   - 非 BizError 输入返回兜底中文
 */
import { describe, expect, it } from 'vitest';

import { BizError, ErrorCode } from './index.js';
import { friendlyMessage } from './friendly.js';

const allCodes = Object.values(ErrorCode);

describe('friendlyMessage 27 项 + default', () => {
  it.each(allCodes)('%s 输出非空中文且不含英文 Error', (code) => {
    const msg = friendlyMessage(new BizError(code, 'internal'));
    expect(msg).toBeTruthy();
    expect(msg.length).toBeGreaterThan(0);
    expect(/[一-龥]/.test(msg)).toBe(true);
    expect(msg).not.toContain('Error:');
    expect(msg).not.toContain('stack');
  });

  it('default(非 BizError 输入)返回兜底中文', () => {
    expect(friendlyMessage(new Error('raw'))).toBe('系统忙，请稍后再试。');
    expect(friendlyMessage(undefined)).toBe('系统忙，请稍后再试。');
    expect(friendlyMessage('string err')).toBe('系统忙，请稍后再试。');
  });

  it('不暴露 err.meta / err.stack / SQL / 表名', () => {
    const err = new BizError('SCHEMA_FAIL', 'mysql column missing', {
      meta: { sql: 'SELECT * FROM secret_table', column: 'password' },
    });
    const msg = friendlyMessage(err);
    expect(msg).not.toContain('mysql');
    expect(msg).not.toContain('SELECT');
    expect(msg).not.toContain('secret_table');
    expect(msg).not.toContain('password');
    expect(msg).not.toContain('column');
  });

  it('UNAUTHORIZED / DRAFT_EXPIRED / MCP_UNAVAILABLE 关键词检查(SSOT 话术)', () => {
    expect(friendlyMessage(new BizError('UNAUTHORIZED', 'x'))).toContain('登录');
    expect(friendlyMessage(new BizError('DRAFT_EXPIRED', 'x'))).toContain('过期');
    expect(friendlyMessage(new BizError('MCP_UNAVAILABLE', 'x'))).toContain('ERP');
    expect(friendlyMessage(new BizError('PROMPT_INJECTION', 'x'))).toContain('请求被拒绝');
  });
});
