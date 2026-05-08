/**
 * 切片 19 — T-16 MCP 白名单（缺工具启动失败）
 *
 * 严格按 docs/tanks/19-test-e2e-20-cases.md §8.1 §T-16 + 切片 08 §9.7 落地：
 *   - 启动 in-process MCP mock 时关闭写工具（enableWriteTools: false → 仅 6 个读工具）
 *   - verifyMcpToolsAtStartup() 应抛 McpWhitelistError（missing=['createPurchaseOrder']）
 *   - 期望：BizError / McpWhitelistError + 启动时进程应 process.exit(1)；
 *          E2E 等价断言：verifyMcpToolsAtStartup() throws
 *
 * @since 切片 19
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { logCommand } from './_helpers/chat-client.js';
import { ensureBaseEnv } from './_helpers/env.js';

ensureBaseEnv();

let mcpHandle: { close: () => Promise<void>; url: string } | null = null;
let resetMcpClientForTest: () => void = () => undefined;

beforeAll(async () => {
  const mcpInProcMod = await import('../../src/test-helpers/mcp-in-process.js');
  mcpHandle = await mcpInProcMod.startMcpMock({
    fixtures: 'happy-path',
    enableWriteTools: false, // 关闭 createPurchaseOrder → 只有 6 个工具
  });
  vi.stubEnv('ERP_MCP_SERVER_URL', `${mcpHandle.url}/mcp`);
  const envMod = await import('../../src/config/env.js');
  envMod.resetEnvForTest();
  const mcpClientMod = await import('../../src/mastra/mcp/client.js');
  resetMcpClientForTest = mcpClientMod.__resetMcpClientForTest;
  resetMcpClientForTest();
}, 30_000);

afterAll(async () => {
  await mcpHandle?.close().catch(() => undefined);
  resetMcpClientForTest();
  vi.unstubAllEnvs();
});

describe('T-16 MCP 白名单：缺工具启动失败（任务卡 §8.1 §T-16）', () => {
  it('verifyMcpToolsAtStartup → McpWhitelistError(missing=createPurchaseOrder)', async () => {
    logCommand(
      'T-16',
      'startMcpMock({enableWriteTools:false}) + verifyMcpToolsAtStartup',
      'throws McpWhitelistError; missing=[createPurchaseOrder]',
    );

    const mcpClientMod = await import('../../src/mastra/mcp/client.js');
    let caught: unknown = null;
    try {
      await mcpClientMod.verifyMcpToolsAtStartup();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(mcpClientMod.McpWhitelistError);
    const err = caught as InstanceType<typeof mcpClientMod.McpWhitelistError>;
    expect(err.missing).toContain('createPurchaseOrder');
    // 错误信息含 missing / extra（任务卡 §7 MUST DO §2）
    expect(err.message).toMatch(/missing.*createPurchaseOrder/);
  });
});
