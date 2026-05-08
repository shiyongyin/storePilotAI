/**
 * 切片 01 — pino logger + redact 5 路径
 * 切片 06 — 增 withTraceLogger(traceId) child logger 注入
 *
 * 严格按:
 *   - 切片 01 §7 MUST DO §7（redact 5 路径，censor=[REDACTED]，remove=false）
 *   - 切片 06 §7 MUST DO §10（traceId 自动注入 child logger）
 */
import pino from 'pino';

export const logger = pino({
  level: 'info',
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
});

export type Logger = typeof logger;

export interface HttpRequestLogFieldsInput {
  method: string;
  path: string;
  authorization: string | undefined;
  status: number;
  durationMs?: number;
}

export interface HttpRequestLogFields {
  req: {
    method: string;
    path: string;
    headers: {
      authorization?: string;
    };
  };
  status: number;
  durationMs?: number;
}

export function buildHttpRequestLogFields(input: HttpRequestLogFieldsInput): HttpRequestLogFields {
  const headers: HttpRequestLogFields['req']['headers'] = {};
  if (input.authorization !== undefined) headers.authorization = input.authorization;
  const fields: HttpRequestLogFields = {
    req: {
      method: input.method,
      path: input.path,
      headers,
    },
    status: input.status,
  };
  if (input.durationMs !== undefined) fields.durationMs = input.durationMs;
  return fields;
}

/**
 * 切片 06 §8.5 — 把 traceId 自动注入到 child logger 上下文。
 * 桥接层（切片 09 / 10）每次请求 build 一次 child；Skill 把 child 传入 RuntimeContext。
 */
export function withTraceLogger(traceId: string): Logger {
  return logger.child({ traceId });
}
