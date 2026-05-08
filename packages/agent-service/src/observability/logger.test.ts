/**
 * 切片 01 — pino redact 5 路径单元测试
 * 行为断言(任务卡 §9):触发含 Authorization 的日志 → 字段值显示 [REDACTED]。
 * 本测试以单测形式落地,因为完整 401 鉴权流程属切片 09。
 */
import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';

function captureLogs(): { logger: pino.Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      lines.push(text);
      cb();
    },
  });
  const logger = pino(
    {
      redact: {
        paths: [
          'req.headers.authorization',
          'env.MODEL_API_KEY',
          '*.DATABASE_URL',
          '*.MCP_TENANT_SHARED_SECRET',
          '*.AGENT_API_KEY_HASH_SALT',
        ],
        remove: false,
        censor: '[REDACTED]',
      },
    },
    stream,
  );
  return { logger, lines };
}

describe('logger redact 5 路径', () => {
  it('Authorization header 被 [REDACTED] 替换', () => {
    const { logger, lines } = captureLogs();
    logger.warn({ req: { headers: { authorization: 'Bearer sk-agent-leak-12345' } } }, '401');
    const out = lines.join('');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk-agent-leak-12345');
    expect(out).not.toContain('Bearer sk-agent');
  });

  it('env.MODEL_API_KEY 被 [REDACTED] 替换', () => {
    const { logger, lines } = captureLogs();
    logger.info({ env: { MODEL_API_KEY: 'sk-real-key-leak' } }, 'startup env');
    const out = lines.join('');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk-real-key-leak');
  });

  it('DATABASE_URL / MCP_TENANT_SHARED_SECRET / AGENT_API_KEY_HASH_SALT 被 [REDACTED] 替换', () => {
    const { logger, lines } = captureLogs();
    logger.info(
      {
        config: {
          DATABASE_URL: 'mysql://leakuser:leakpass@host/db',
          MCP_TENANT_SHARED_SECRET: 'tenant-secret-leak-32-chars-xxxx',
          AGENT_API_KEY_HASH_SALT: 'salt-leak-16char',
        },
      },
      'config snapshot',
    );
    const out = lines.join('');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('leakuser');
    expect(out).not.toContain('leakpass');
    expect(out).not.toContain('tenant-secret-leak');
    expect(out).not.toContain('salt-leak-16char');
  });
});
