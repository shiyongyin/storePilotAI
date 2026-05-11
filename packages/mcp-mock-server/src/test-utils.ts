/**
 * 切片 18 — mcp-mock-server in-process 启动器（test-utils）
 *
 * 严格按 docs/tanks/18-test-unit-integration.md §8.3 + 任务卡 H-测试 §T-TEST-01.5 §3 落地。
 *
 * 用途：
 *   - 让 agent-service 集成测试在**同进程**启一个完整的 mcp-mock-server 实例
 *     （随机端口 + 6 fixture profile），避免依赖外部 docker compose；CI 单进程跑通。
 *   - 不读 `process.env`：env 由调用方显式传入（默认走 happy-path + 32 char 兜底 secret），
 *     保证测试可用 `vi.stubEnv` 注入而不污染本启动器（切片 18 §7 MUST NOT §2）。
 *
 * @since 切片 18
 */
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createMcpMockApp } from './app.js';
import type { Env, FixtureProfile } from './config/env.js';

/** {@link createMcpApp} 入参 */
export interface CreateMcpAppArgs {
  /**
   * fixture profile 名，对应 `src/fixtures/<name>` 子目录。
   * 默认 `happy-path`（任务卡 §T-TEST-01.5 §3）。
   */
  fixtures?: FixtureProfile;
  /**
   * 监听端口；`0` 表示让 OS 随机分配（推荐，避免并发测试端口冲突）。
   * 默认 `0`（任务卡 §6 MUST DO §6）。
   */
  port?: number;
  /**
   * 是否注册写工具 `createPurchaseOrder`；`false` 时仅注册读工具，
   * 用于覆盖"缺工具启动失败"集成用例（I-02 期望 process.exit(1)）。
   * 默认 `true`（完整工具白名单）。
   */
  enableWriteTools?: boolean;
  /**
   * 自定义 X-Tenant-Key 共享 secret；默认 32 char 占位
   * （E2E 由切片 19 注入真实 secret，本启动器仅满足 zod min(32) 校验）。
   */
  tenantSharedSecret?: string;
  /**
   * 协议版本；默认 `2025-06-18`，与 shared-contracts MCP_PROTOCOL_VERSION 1:1。
   */
  protocolVersion?: string;
  /** 工具调用超时；默认 15s（与 client 侧 `TOOL_CALL_TIMEOUT_MS` 对齐）。 */
  toolTimeoutMs?: number;
  /**
   * MCP_TEST_EXTRA_TOOL_NAME / MCP_TEST_SCHEMA_MISSING_*
   * 用于 I-02 集成测试模拟"白名单不一致"。
   */
  testExtraToolName?: string;
  testSchemaMissingTool?: Env['MCP_TEST_SCHEMA_MISSING_TOOL'];
  testSchemaMissingSide?: Env['MCP_TEST_SCHEMA_MISSING_SIDE'];
}

/** {@link createMcpApp} 返回值 */
export interface McpAppHandle {
  /** 完整 base URL，已含端口（不含 `/mcp` 后缀）；调用方拼 `${url}/mcp` 即可。 */
  readonly url: string;
  /** 实际监听的端口（port=0 时由 OS 分配）。 */
  readonly port: number;
  /** 调用方使用的 fixture profile（便于断言）。 */
  readonly fixtures: FixtureProfile;
  /** 优雅关闭：close http server + 释放端口；幂等。 */
  close: () => Promise<void>;
}

/**
 * 启动一个 in-process mcp-mock-server。
 *
 * 与 `startMcpMockServer(env)` 的差异：
 *   - 不直接 `server.listen()` 同步返回；而是 await listen 完成后返回 `{ url, close }`。
 *   - 监听失败抛错（不 `process.exit(1)`），便于测试 catch 后断言。
 *   - 不读取 process.env / 不调 getEnv()；env 全部由参数构造（任务卡 §7 MUST NOT §2）。
 *
 * @returns Promise<McpAppHandle>；await 即拿到 `url` / `port` / `close`。
 */
export async function createMcpApp(args: CreateMcpAppArgs = {}): Promise<McpAppHandle> {
  const env: Env = {
    NODE_ENV: 'test',
    PORT: args.port ?? 0,
    MCP_PROTOCOL_VERSION: args.protocolVersion ?? '2025-06-18',
    MCP_TOOL_TIMEOUT_MS: args.toolTimeoutMs ?? 15_000,
    MCP_ENABLE_WRITE_TOOLS: args.enableWriteTools ?? true,
    FIXTURE_PROFILE: args.fixtures ?? 'happy-path',
    MCP_TENANT_SHARED_SECRET: args.tenantSharedSecret ?? 'a'.repeat(32),
    // allowedHosts 含 localhost / 127.0.0.1 + 任意端口（DNS rebinding 防护对 localhost 较宽容）。
    MCP_ALLOWED_HOSTS: 'localhost,127.0.0.1',
    MCP_CORS_ORIGIN: '*',
    MCP_TEST_EXTRA_TOOL_NAME: args.testExtraToolName,
    MCP_TEST_SCHEMA_MISSING_TOOL: args.testSchemaMissingTool,
    MCP_TEST_SCHEMA_MISSING_SIDE: args.testSchemaMissingSide,
  };

  const app = createMcpMockApp(env);
  const server: HttpServer = createServer(app);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    // listen 到 127.0.0.1，避免 IPv6 / 全网卡监听污染端口
    server.listen(env.PORT, '127.0.0.1');
  });

  const address: AddressInfo | string | null = server.address();
  const port = typeof address === 'object' && address ? address.port : env.PORT;
  const url = `http://127.0.0.1:${port}`;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  return { url, port, fixtures: env.FIXTURE_PROFILE, close };
}
