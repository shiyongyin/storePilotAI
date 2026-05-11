/**
 * 切片 18 — MCP in-process 启动器（封装 mcp-mock-server/test-utils）
 *
 * 严格按 docs/tanks/18-test-unit-integration.md §8.3 + 任务卡 H-测试 §T-TEST-01.5 §3 落地。
 *
 * 用途：
 *   - 集成测试在同进程随机端口启动 mock，避免依赖外部 docker（任务卡 §6 MUST DO §6）。
 *   - 配合 `vi.stubEnv('ERP_MCP_SERVER_URL', `${url}/mcp`)` 让 client.ts 单例
 *     `verifyMcpToolsAtStartup()` 走真实 HTTP 链路（任务卡 §T-MASTRA-03）。
 *
 * 强约束（切片 18 §7 MUST NOT §1 / §2）：
 *   - 不直接写 env（`vi.stubEnv` / `vi.unstubAllEnvs` 是唯一推荐路径）。
 *   - 不 mock 数据库；本启动器只起 MCP HTTP 端，不涉及 MySQL。
 *
 * @example
 *   import { startMcpMock } from '../../src/test-helpers/mcp-in-process.js';
 *
 *   const mcp = await startMcpMock({ fixtures: 'happy-path' });
 *   try {
 *     vi.stubEnv('ERP_MCP_SERVER_URL', `${mcp.url}/mcp`);
 *     await verifyMcpToolsAtStartup(); // 真实握手完整工具白名单
 *   } finally {
 *     vi.unstubAllEnvs();
 *     await mcp.close();
 *   }
 *
 * @since 切片 18
 */
import {
  createMcpApp,
  type CreateMcpAppArgs,
  type McpAppHandle,
} from '@storepilot/mcp-mock-server/test-utils';

export type StartMcpMockArgs = CreateMcpAppArgs;
export type McpMockHandle = McpAppHandle;

/**
 * 启动 in-process mock MCP server。
 *
 * @param args fixture profile / port=0(random) / 工具开关；省略时为 `happy-path` + 完整工具白名单。
 * @returns `{ url, port, fixtures, close }`；调用方负责 `await close()` 释放端口。
 */
export async function startMcpMock(args: StartMcpMockArgs = {}): Promise<McpMockHandle> {
  return createMcpApp(args);
}
