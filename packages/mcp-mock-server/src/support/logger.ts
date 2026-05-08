/**
 * 切片 05 — mcp-mock-server pino logger
 * redact:Authorization / 任意 *.MCP_TENANT_SHARED_SECRET / X-MCP-Tenant-Secret(切片 18 安全 round 完整化)
 */
import pino from 'pino';

export const logger = pino({
  level: 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-mcp-tenant-secret"]',
      '*.MCP_TENANT_SHARED_SECRET',
      '*.MODEL_API_KEY',
    ],
    remove: false,
    censor: '[REDACTED]',
  },
});

export type Logger = typeof logger;
