/**
 * 切片 18 §9 step 5 — MCP in-process 启动集成测试
 *
 * 严格按 docs/tanks/18-test-unit-integration.md §8.6 I-01 / I-02 落地。
 *
 * 覆盖：
 *   - I-01：随机端口启动 mock + tools/list = shared-contracts 全量工具
 *   - I-02：关 createPurchaseOrder（enableWriteTools=false）→ 列表缺唯一写工具
 *   - 端口隔离：两个并发 mock 不冲突（port: 0 + 127.0.0.1）
 *   - close 后端口可被释放（再起一个相同端口不冲突）
 *
 * 注意：本套测试只验 in-process 启动器本身；agent-service 的 verifyMcpToolsAtStartup
 * 单测在 src/mastra/mcp/client.test.ts，已通过 mock 覆盖；端到端校验属切片 19 E2E。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { TOOL_NAMES } from '@storepilot/shared-contracts';
import { startMcpMock, type McpMockHandle } from '../../src/test-helpers/mcp-in-process.js';

let handles: McpMockHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.map((h) => h.close().catch(() => undefined)));
  handles = [];
});

/**
 * 通过 raw HTTP 调 mock 的 /mcp 端点，列工具数。
 * 不引入 @modelcontextprotocol/sdk client 依赖，避免与 mock-server 端形成耦合环。
 */
async function listToolsCount(url: string, tenantSecret = 'a'.repeat(32)): Promise<number> {
  const res = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-Tenant-Key': tenantSecret,
      'X-Mcp-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }),
  });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { result?: { tools?: Array<{ name: string }> } };
  return json.result?.tools?.length ?? 0;
}

describe('startMcpMock — in-process 启动器（任务卡 §T-TEST-01.5 §3）', () => {
  it('I-01：随机端口启动 + tools/list = shared-contracts 全量工具（happy-path）', async () => {
    const mcp = await startMcpMock({ fixtures: 'happy-path' });
    handles.push(mcp);

    expect(mcp.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(mcp.port).toBeGreaterThan(0);
    expect(mcp.fixtures).toBe('happy-path');

    const count = await listToolsCount(mcp.url);
    expect(count).toBe(TOOL_NAMES.length);
  });

  it('I-02：enableWriteTools=false → 缺唯一写工具 createPurchaseOrder', async () => {
    const mcp = await startMcpMock({ enableWriteTools: false });
    handles.push(mcp);

    const count = await listToolsCount(mcp.url);
    expect(count).toBe(TOOL_NAMES.length - 1);
  });

  it('两个并发 mock 不冲突（port: 0 各自独立）', async () => {
    const a = await startMcpMock();
    const b = await startMcpMock();
    handles.push(a, b);

    expect(a.port).not.toBe(b.port);
    expect(await listToolsCount(a.url)).toBe(TOOL_NAMES.length);
    expect(await listToolsCount(b.url)).toBe(TOOL_NAMES.length);
  });

  it('close 幂等：同一 handle close 两次不抛错', async () => {
    const mcp = await startMcpMock();
    await mcp.close();
    await expect(mcp.close()).resolves.toBeUndefined();
  });

  it('close 后端口被释放（短时不会被 EADDRINUSE）', async () => {
    const a = await startMcpMock();
    const port = a.port;
    await a.close();

    // 立即再起一个 mock 到同一端口，不应冲突（OS 通常 grace 释放）
    const b = await startMcpMock({ port });
    handles.push(b);
    expect(b.port).toBe(port);
  });
});
