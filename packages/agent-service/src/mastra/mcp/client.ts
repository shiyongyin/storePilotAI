/**
 * 切片 08 — Mastra MCPClient + 启动期 7 工具白名单严格校验
 * 严格按 docs/任务卡/D-Mastra.md §T-MASTRA-03.5 + 切片 08 任务卡 §8 落地。
 *
 * 强约束（MUST，违反即拒收）:
 *   - 必须用 @mastra/mcp.MCPClient（红线 2：禁用 ai 包内的实验性 MCPClient 创建函数；ESLint 守门）
 *   - TOOL_WHITELIST 字典序与 shared-contracts TOOL_NAMES 严格相等（启动期单测守门）
 *   - verifyMcpToolsAtStartup 必须严格 JSON.stringify(found.sort()) === JSON.stringify(expected.sort())
 *   - 7 个工具每个都校验 inputSchema / outputSchema 非空
 *   - 启动期失败必须含具体 missing / extra 工具名（便于运维定位）
 *   - HTTP 服务连接 connectTimeout 5_000（启动期 fail-fast，避免挂死）
 *   - SIGTERM / SIGINT 必须 disposeMcpClient（避免连接泄漏）
 *   - 注入 X-Tenant-Key + X-Mcp-Protocol-Version + User-Agent header（服务间共享 secret 验证）
 *   - MCPClient 必须**单例**（避免每次工具调用都新建连接）
 *   - MCPClient 顶层传稳定 id（Mastra 1.7.0 提供 MCPClientOptions.id，避免相同配置实例缓存误判）
 *
 * !! API drift（mastra 1.0 vs 任务卡 0.x 文本）!!
 *   - 原始 D-Mastra 示例 `connectTimeoutMs: 5_000` 写在顶层 MCPClientOptions；
 *     mastra 1.0 已迁移到 HttpServerDefinition.connectTimeout（毫秒），
 *     语义完全一致（启动期 / 切换 transport 时 fail-fast）。本切片采用 1.0 API：
 *     `servers.erp.connectTimeout: 5_000`。顶层 `timeout` 是工具调用超时（默认 60_000）
 *     —— 工具调用超时 / 重试包装属切片 14 / 15，不在本切片范围。
 *   - 原始 D-Mastra 示例 `getTools()`；mastra 1.0 已迁移为 `listToolsets()`
 *     （返回 `{ serverName: { toolName: Tool } }`，无命名空间前缀，便于本切片做白名单比对），
 *     与 `listTools()`（返回 `serverName_toolName` 命名空间）形成两套读取路径。
 *     本切片采用 `listToolsets()` 取出 `erp` server 的工具表，键即 7 个白名单工具名。
 *
 * 上述 drift 不影响切片 08 任务卡 §9 任一验收步骤（白名单严格相等比对、missing/extra
 * 错误信息、schema 非空、5s fail-fast、X-Tenant-Key 注入、单例、SIGTERM 清理、红线 grep）。
 */
import { MCPClient } from '@mastra/mcp';
import type { ToolContractName } from '@storepilot/shared-contracts';

import { getEnv } from '../../config/env.js';
import { logger } from '../../observability/logger.js';

/**
 * 7 工具白名单（必须与 shared-contracts TOOL_NAMES 字典序严格相等）。
 *
 * 任意增删必须同步：
 *   1. shared-contracts/src/mcp/index.ts 的 ToolContracts barrel + TOOL_NAMES
 *   2. 本文件 TOOL_WHITELIST
 *   3. mcp-mock-server 注册的工具
 *   4. docs/任务卡/README.md §6 一致性矩阵
 *
 * 字典序由本切片 mcp.client.test.ts 单测守门（TOOL_WHITELIST === TOOL_NAMES）。
 */
export const TOOL_WHITELIST: readonly ToolContractName[] = [
  'createPurchaseOrder',
  'getStoreReportConfig',
  'queryCategorySalesRatio',
  'queryInventoryOverview',
  'queryProductSalesRank',
  'queryReplenishmentBaseData',
  'queryStoreSalesSummary',
] as const;

export type ToolName = (typeof TOOL_WHITELIST)[number];

/** Server key 单一约定 —— 与 listToolsets() 的返回 key 一致 */
const ERP_SERVER_KEY = 'erp';

/** HTTP 连接超时（启动期 fail-fast；切片 08 §7 MUST DO §6） */
const MCP_CONNECT_TIMEOUT_MS = 5_000;

/** User-Agent 版本号兜底（env.AGENT_VERSION 在 V1 不在 23 字段集，固定 'dev'） */
const AGENT_USER_AGENT_VERSION = 'dev';

/** 单例引用 —— 多次 getMcpClient() 必须返回同一实例（切片 08 §7 MUST DO §8） */
let _client: MCPClient | null = null;

/**
 * 获取 MCPClient 单例。
 *
 * 关键决策：
 *   - 注入 X-Tenant-Key（`MCP_TENANT_SHARED_SECRET`）作为服务间共享 secret —— mock-server
 *     端 / 未来 V2 Spring AI 端在中间件校验该 header；该值已被 pino redact 守门（切片 01）。
 *   - 注入 X-Mcp-Protocol-Version 让握手期协议版本不一致直接失败（切片 05 mock 端 health
 *     回显该值，便于排障）。
 *   - 注入 User-Agent 便于上游日志归因。
 *   - HTTP `connectTimeout: 5_000` —— 启动期 fail-fast，避免 ERP/mock 不可达时挂死阻塞
 *     `verifyMcpToolsAtStartup`（切片 08 §9.7 验收：`ERP_MCP_SERVER_URL=http://nowhere:9999/mcp`
 *     必须 5s 内退出码 1）。
 *   - 不传顶层 `timeout` —— 工具调用超时 / 重试包装属切片 14 / 15 各自的
 *     `runWithTimeoutAndRetry`，本切片不混入。
 *
 * @returns 进程内单例 MCPClient；多次调用返回同一引用（验收 §9.10）。
 */
export function getMcpClient(): MCPClient {
  if (_client) return _client;
  const env = getEnv();
  _client = new MCPClient({
    id: 'storepilot-erp-mcp-client',
    servers: {
      [ERP_SERVER_KEY]: {
        url: new URL(env.ERP_MCP_SERVER_URL),
        connectTimeout: MCP_CONNECT_TIMEOUT_MS,
        requestInit: {
          headers: {
            'X-Tenant-Key': env.MCP_TENANT_SHARED_SECRET,
            'X-Mcp-Protocol-Version': env.MCP_PROTOCOL_VERSION,
            'User-Agent': `agent-service/${AGENT_USER_AGENT_VERSION}`,
          },
        },
      },
    },
  });
  return _client;
}

/**
 * 取出 ERP server 的所有工具表（无命名空间前缀，便于做白名单比对）。
 *
 * `listToolsets()` 返回 `{ erp: { toolName: Tool } }`；本函数透出 `erp` 子表。
 * `listTools()` 返回的是带 `serverName_` 前缀的扁平表，本切片不使用。
 */
export async function mcpTools(): Promise<Record<string, unknown>> {
  const toolsets = await getMcpClient().listToolsets();
  return toolsets[ERP_SERVER_KEY] ?? {};
}

/** verifyMcpToolsAtStartup 失败时抛出；server.ts 捕获后 process.exit(1) */
export class McpWhitelistError extends Error {
  public readonly missing: ReadonlyArray<string>;
  public readonly extra: ReadonlyArray<string>;
  public readonly schemaMissing: ReadonlyArray<string>;

  constructor(
    message: string,
    args: {
      missing?: ReadonlyArray<string>;
      extra?: ReadonlyArray<string>;
      schemaMissing?: ReadonlyArray<string>;
    } = {},
  ) {
    super(message);
    this.name = 'McpWhitelistError';
    this.missing = args.missing ?? [];
    this.extra = args.extra ?? [];
    this.schemaMissing = args.schemaMissing ?? [];
  }
}

/**
 * 启动期严格校验：mock-mock-server / V2 Spring AI 暴露的工具集合必须 == 7 工具白名单。
 *
 * 校验规则（切片 08 §7 MUST DO §1 / §2 / §3）：
 *   1. 严格 `JSON.stringify(found.sort()) === JSON.stringify(expected.sort())`
 *      —— 数量 / 名字漂移均失败；不允许部分匹配 / 子集匹配。
 *   2. 错误信息必须含具体 missing / extra（便于运维一眼看出缺哪个或多了什么）。
 *   3. 7 个工具每个都需校验 `inputSchema` / `outputSchema` 非空（避免握手成功但 schema 空缺）。
 *
 * 成功后输出绿灯第 4 行 `[startup] mcp-tools-verified`（与启动六行绿灯口径一致）。
 *
 * @throws {McpWhitelistError} 白名单不一致或 schema 缺失；调用方需 process.exit(1)。
 */
export async function verifyMcpToolsAtStartup(): Promise<void> {
  const tools = await mcpTools();
  const found = Object.keys(tools).sort();
  const expected = [...TOOL_WHITELIST].sort();

  if (JSON.stringify(found) !== JSON.stringify(expected)) {
    const expectedSet = new Set<string>(expected);
    const foundSet = new Set<string>(found);
    const missing = expected.filter((t) => !foundSet.has(t));
    const extra = found.filter((t) => !expectedSet.has(t));
    throw new McpWhitelistError(
      `[mcp] 工具白名单不一致；missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)} expected=${JSON.stringify(expected)} found=${JSON.stringify(found)}`,
      { missing, extra },
    );
  }

  const schemaMissing: string[] = [];
  for (const t of expected) {
    const tool = tools[t] as { inputSchema?: unknown; outputSchema?: unknown } | undefined;
    if (!tool || !tool.inputSchema || !tool.outputSchema) {
      schemaMissing.push(t);
    }
  }
  if (schemaMissing.length > 0) {
    const first = schemaMissing[0]!;
    throw new McpWhitelistError(
      `[mcp] 工具 ${first} 缺少 input/output schema；schemaMissing=${JSON.stringify(schemaMissing)}`,
      { schemaMissing },
    );
  }

  logger.info({ tools: expected }, '[startup] mcp-tools-verified');
}

/**
 * 进程退出时清理 MCPClient 连接。
 *
 * 强约束（切片 08 §7 MUST NOT §3）：disconnect 异常不得阻断进程退出 —— 退出阶段
 * 任何异常都仅写日志，不重抛、不影响 exit code。
 */
export async function disposeMcpClient(): Promise<void> {
  if (!_client) return;
  const c = _client;
  _client = null;
  try {
    await c.disconnect();
    logger.info('[shutdown] disposeMcpClient ok');
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      '[shutdown] disposeMcpClient failed (ignored)',
    );
  }
}

/**
 * 仅供测试 reset 单例（业务代码不应调用）。
 * 用 export 命名前缀 `__` 表示内部测试 hook。
 */
export function __resetMcpClientForTest(): void {
  _client = null;
}

/**
 * SIGTERM / SIGINT hook —— 模块顶层 once，进程内幂等。
 *
 * 注意：server.ts 也注册了 SIGTERM/SIGINT 用于 server.close + process.exit(0)；
 * Node 默认按注册顺序触发监听器，本 hook 先 dispose MCPClient 再让 server hook 走 exit，
 * 不抢占 exit code 控制权（不主动 process.exit）。
 */
const installSignalHooks = (): void => {
  const handler = (signal: NodeJS.Signals): void => {
    void disposeMcpClient().catch(() => {
      // 已在 disposeMcpClient 内部 try/catch；此处再兜底，避免未捕获 promise
    });
    logger.info({ signal }, '[shutdown] mcp client dispose triggered');
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
};
installSignalHooks();
