/**
 * 切片 19 + 切片 20 — T-01 健康检查 5 接口冒烟（in-process）
 *
 * 严格按 docs/tanks/19-test-e2e-20-cases.md §8.1 + 切片 20 §9 step 1 / §10.1 落地：
 *   - GET /health             → 200 + status='UP'
 *   - GET /health/db          → 503 + status='DOWN'（pool 未注入；任务卡 §7 MUST DO §1 子项 b）
 *                               or 200 + status='UP'（pool + ≥ 11 表）
 *   - GET /health/mcp         → 200 + tools=16（in-process MCP mock；任务卡 §7 MUST DO §1 子项 c）
 *   - GET /health/model       → 503 + status='DOWN'（modelPingFn 未注入；任务卡 §7 MUST DO §1 子项 d）
 *                               注意：本端到端测试不依赖真实 LLM 网关，仅冒烟接口形态
 *   - GET /health/ready       → 503 + status='DOWN'（db 未就绪；任务卡 §7 MUST DO §2）
 *
 * 不依赖外网（任务卡 §7 MUST NOT §2）；不写 process.env（§7 MUST NOT §6）。
 *
 * @since 切片 19；切片 20 扩到 5 接口
 */
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  health,
  resetHealthDepsForTest,
  setHealthDeps,
} from '../../src/api/health.js';
import {
  __resetMcpClientForTest,
  type ToolName,
} from '../../src/mastra/mcp/client.js';
import { startMcpMock, type McpMockHandle } from '../../src/test-helpers/mcp-in-process.js';
import { ensureBaseEnv } from './_helpers/env.js';
import { logCommand } from './_helpers/chat-client.js';

let mcp: McpMockHandle | null = null;

beforeAll(async () => {
  ensureBaseEnv();
  mcp = await startMcpMock({ fixtures: 'happy-path' });
  vi.stubEnv('ERP_MCP_SERVER_URL', `${mcp.url}/mcp`);
}, 30_000);

afterAll(async () => {
  await mcp?.close().catch(() => undefined);
  __resetMcpClientForTest();
  resetHealthDepsForTest();
  vi.unstubAllEnvs();
});

function buildApp(): Hono {
  const app = new Hono();
  app.route('/', health);
  return app;
}

describe('T-01 健康检查（任务卡 §8.1 §T-01；切片 20 扩到 5 接口）', () => {
  it('GET /health → 200 + status=UP（liveness 不依赖任何 DI）', async () => {
    logCommand('T-01.a', 'curl http://localhost:7100/health', 'status=200, body.status=UP');
    resetHealthDepsForTest();
    const res = await buildApp().fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('UP');
  });

  it('GET /health/db → 503 + status=DOWN（pool 未注入；切片 20 不再返回 NOT_READY 占位）', async () => {
    logCommand(
      'T-01.b',
      'curl -i http://localhost:7100/health/db',
      'status=503, body.status=DOWN',
    );
    resetHealthDepsForTest();
    const res = await buildApp().fetch(new Request('http://localhost/health/db'));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; reason: string };
    expect(body.status).toBe('DOWN');
    expect(body.reason).toContain('pool not injected');
  });

  it('GET /health/mcp → 200 + tools 数组含 16 个（in-process MCP mock；DI mcpToolsFn）', async () => {
    logCommand(
      'T-01.c',
      'curl http://localhost:7100/health/mcp',
      'status=200, tools.length=16',
    );
    const { mcpTools } = await import('../../src/mastra/mcp/client.js');
    setHealthDeps({ mcpToolsFn: () => mcpTools() });
    const res = await buildApp().fetch(new Request('http://localhost/health/mcp'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      tools: ToolName[];
      whitelist: ToolName[];
    };
    expect(body.status).toBe('UP');
    expect(body.tools.length).toBe(16);
    expect(body.whitelist.length).toBe(16);
  });

  it('GET /health/model → 503 + reason="model ping not injected"（任务卡 §7 MUST NOT §4：不进 readiness）', async () => {
    logCommand(
      'T-01.d',
      'curl http://localhost:7100/health/model',
      'status=503, body.reason=model ping not injected',
    );
    resetHealthDepsForTest();
    const res = await buildApp().fetch(new Request('http://localhost/health/model'));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; reason: string };
    expect(body.status).toBe('DOWN');
    expect(body.reason).toBe('model ping not injected');
  });

  it('GET /health/ready → 503（db 未注入；任务卡 §7 MUST DO §2 聚合 db + mcp）', async () => {
    logCommand(
      'T-01.e',
      'curl http://localhost:7100/health/ready',
      'status=503, body.status=DOWN, db.reason 含 pool not injected',
    );
    resetHealthDepsForTest();
    const res = await buildApp().fetch(new Request('http://localhost/health/ready'));
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      status: string;
      db: { status: string; reason?: string };
      mcp: { status: string };
    };
    expect(body.status).toBe('DOWN');
    expect(body.db.status).toBe('DOWN');
    expect(body.db.reason).toContain('pool not injected');
  });
});
