import { createServer, type Server as HttpServer } from 'node:http';

import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import cors from 'cors';
import type { Express, RequestHandler } from 'express';

import type { Env } from './config/env.js';
import { createMcpServer } from './mcp-server.js';
import { logger } from './support/logger.js';

export const MCP_ACCEPT_HEADER = 'application/json, text/event-stream';
export const MCP_TRANSPORT_OPTIONS = { enableJsonResponse: true } as const;

export function parseAllowedHosts(value: string): string[] {
  return value
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0)
    .map((host) => new URL(`http://${host}`).hostname);
}

export function normalizeMcpAcceptHeader(accept: string | undefined): string {
  return !accept || accept === '*/*' ? MCP_ACCEPT_HEADER : accept;
}

type AcceptCompatibleRequest = {
  method: string;
  path: string;
  headers: { accept?: string | string[] | undefined };
  rawHeaders?: string[];
};

function upsertRawAcceptHeader(rawHeaders: string[] | undefined, value: string): void {
  if (!rawHeaders) return;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === 'accept') {
      rawHeaders[i + 1] = value;
      return;
    }
  }
  rawHeaders.push('Accept', value);
}

export function applyMcpAcceptCompatibility(req: AcceptCompatibleRequest): void {
  if (req.method !== 'POST' || req.path !== '/mcp') return;
  const current = Array.isArray(req.headers.accept) ? req.headers.accept.join(', ') : req.headers.accept;
  const normalized = normalizeMcpAcceptHeader(current);
  req.headers.accept = normalized;
  upsertRawAcceptHeader(req.rawHeaders, normalized);
}

const acceptCompatibility: RequestHandler = (req, _res, next) => {
  applyMcpAcceptCompatibility(req);
  next();
};

export function isTenantHeaderAuthorized(
  actual: string | string[] | undefined,
  expected: string,
): boolean {
  const values = Array.isArray(actual) ? actual : [actual];
  return values.some((value) => value === expected);
}

function tenantHeaderAuth(env: Env): RequestHandler {
  return (req, res, next) => {
    if (req.method !== 'POST' || req.path !== '/mcp') {
      next();
      return;
    }
    if (!isTenantHeaderAuthorized(req.headers['x-tenant-key'], env.MCP_TENANT_SHARED_SECRET)) {
      logger.warn(
        { tenantHeader: req.headers['x-tenant-key'] ? '[REDACTED]' : 'missing' },
        '[mcp-mock] tenant header rejected',
      );
      res.setHeader('WWW-Authenticate', 'Bearer realm="mcp"');
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'X-Tenant-Key required' } });
      return;
    }
    logger.info({ tenantHeader: '[REDACTED]' }, '[mcp-mock] tenant header verified');
    next();
  };
}

export function createMcpMockApp(env: Env): Express {
  // createMcpExpressApp() 自带 DNS rebinding 防护 + 内置 express.json()(切片 05 §7 MUST DO §8)。
  // Compose 内部访问使用 Host: mcp-mock-server，必须显式加入 allowedHosts。
  const app = createMcpExpressApp({
    host: '0.0.0.0',
    allowedHosts: parseAllowedHosts(env.MCP_ALLOWED_HOSTS),
  });

  app.use(acceptCompatibility);
  app.use(tenantHeaderAuth(env));
  app.use(
    cors({
      origin: env.MCP_CORS_ORIGIN,
      exposedHeaders: ['WWW-Authenticate', 'Mcp-Session-Id', 'Mcp-Protocol-Version'],
    }),
  );

  // V1 stateless:每次请求新 transport + 新 server(SDK 1.x 推荐)
  // enableJsonResponse=true 让任务卡 prompt 中的 curl | jq 验收可直接消费 JSON。
  app.post('/mcp', (req, res) => {
    void (async (): Promise<void> => {
      const transport = new StreamableHTTPServerTransport(MCP_TRANSPORT_OPTIONS);
      const mcpServer = createMcpServer(env);
      try {
        // SDK 内部 Transport 类型与 StreamableHTTPServerTransport.onclose 在 exactOptionalPropertyTypes:true 下不严格等价
        // 此处用 cast 绕过(切片 21 跟 SDK 升级回填)
        await mcpServer.connect(transport as never);
        res.on('close', () => {
          void transport.close().catch((e: unknown) => {
            logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'transport close failed');
          });
        });
        await transport.handleRequest(req, res, req.body as unknown);
      } catch (e) {
        logger.error({ err: e instanceof Error ? e.message : String(e) }, '/mcp request failed');
        if (!res.headersSent) {
          res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'mcp request failed' } });
        }
      }
    })();
  });

  app.get('/health', (_req, res) => {
    res.json({
      status: 'UP',
      service: 'mcp-mock-server',
      version: '1.0.0',
      protocolVersion: env.MCP_PROTOCOL_VERSION,
      fixtureProfile: env.FIXTURE_PROFILE,
      toolCount: env.MCP_ENABLE_WRITE_TOOLS ? 16 : 15,
    });
  });

  return app;
}

export function startMcpMockServer(env: Env): HttpServer {
  const app = createMcpMockApp(env);
  const server = createServer(app);

  server.on('error', (e: NodeJS.ErrnoException) => {
    logger.error(
      { err: e.message, code: e.code, port: env.PORT },
      '[mcp-mock] listen failed',
    );
    process.exit(1);
  });

  server.listen(env.PORT, () => {
    logger.info(
      {
        port: env.PORT,
        protocolVersion: env.MCP_PROTOCOL_VERSION,
        fixtureProfile: env.FIXTURE_PROFILE,
        toolCount: env.MCP_ENABLE_WRITE_TOOLS ? 16 : 15,
      },
      '[mcp-mock] listening',
    );
  });

  return server;
}
