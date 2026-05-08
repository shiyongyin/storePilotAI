/**
 * 切片 05 — mcp-mock-server Express + Streamable HTTP(MCP 1.29.0)
 * 严格按 docs/任务卡/G-MCP-Mock.md §T-MCP-01.5 落地。
 *
 * 关键约束:
 *   - createMcpExpressApp() 启用 DNS rebinding 默认防护
 *   - CORS exposedHeaders 含 WWW-Authenticate / Mcp-Session-Id / Mcp-Protocol-Version
 *   - V1 stateless:每次 POST /mcp 创建新 transport
 *   - GET /health 返回 toolCount / protocolVersion / fixtureProfile
 *   - 生产保护(NODE_ENV=production → exit(1))在 getEnv() 内统一处理
 */
import 'dotenv/config';

import { getEnv } from './config/env.js';
import { startMcpMockServer } from './app.js';
import { logger } from './support/logger.js';

const env = getEnv();
const server = startMcpMockServer(env);

const shutdown = (signal: string): void => {
  logger.info({ signal }, '[mcp-mock] shutdown requested');
  server.close(() => process.exit(0));
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
