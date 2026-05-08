/**
 * 切片 06 §9.6-§9.9 — server trace / request logging 静态门禁。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pino from 'pino';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { buildHttpRequestLogFields } from './logger.js';
import { isValidTraceId } from './trace.js';

// 以本测试文件位置定位 src/server.ts，避免 vitest workspace（root cwd）下解析失败
const here = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(join(here, '..', 'server.ts'), 'utf8');

describe('切片 06 — OTel 顶部启动与 traceId 透传', () => {
  it('server.ts 第一行必须是 OTel side-effect import', () => {
    expect(serverSource.split(/\r?\n/)[0]).toBe("import './observability/otel.js';");
  });

  it('任务卡 §9 示例 trace_test123 必须作为入站 traceId 被接受', () => {
    expect(isValidTraceId('trace_test123')).toBe(true);
  });

  it('请求日志字段必须走 pino redact 兼容形状，Authorization 不得明文输出', () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer | string, _enc, cb) {
        lines.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        cb();
      },
    });
    const logger = pino(
      {
        redact: {
          paths: ['req.headers.authorization'],
          remove: false,
          censor: '[REDACTED]',
        },
      },
      stream,
    );

    logger.info(
      buildHttpRequestLogFields({
        method: 'GET',
        path: '/health',
        authorization: 'Bearer sk-agent-leak',
        status: 200,
      }),
      '[http] request',
    );

    const out = lines.join('');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('/health');
    expect(out).not.toContain('sk-agent-leak');
  });

  it('server.ts 必须在 traceId 中间件中输出请求日志', () => {
    expect(serverSource).toContain('buildHttpRequestLogFields');
    expect(serverSource).toContain('[http] request');
  });

  it('server.ts 必须把共享 MySQL Pool 注入 DraftManager 后再启动 expire-drafts cron', () => {
    expect(serverSource).toContain('getOrCreateMysqlStoragePool');
    expect(serverSource).toContain('setDraftPool');
    expect(serverSource).toMatch(
      /const\s+storagePool\s*=\s*getOrCreateMysqlStoragePool\(env\)[\s\S]*setDraftPool\(storagePool\)[\s\S]*startExpireDraftsCron\(\)/,
    );
  });

  it('server.ts 必须把 ConfirmManagerPool / MastraResolver 注入后再启动 expire-suspended-runs cron', () => {
    expect(serverSource).toContain('setConfirmManagerPool');
    expect(serverSource).toContain('setMastraResolver');
    expect(serverSource).toMatch(
      /createMastra\(\)[\s\S]*setConfirmManagerPool\(asConfirmManagerPool\(storagePool\)\)[\s\S]*setMastraResolver\([\s\S]*createPurchaseOrderWorkflowHandle\(storagePool\)[\s\S]*\)[\s\S]*startExpireSuspendedRunsCron\(\)/,
    );
  });
});
