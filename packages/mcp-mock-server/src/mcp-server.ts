/**
 * 切片 05 — Mock MCP Server(注册 V1 7 工具 + V2 9 个营销工具,schema 全部从 shared-contracts/mcp 导入)
 * 严格按 docs/任务卡/G-MCP-Mock.md §T-MCP-01.5 落地。
 *
 * 强约束:
 *   - 所有 schema 必须来自 @storepilot/shared-contracts/mcp(本地零 schema 重定义)
 *   - QUERY 工具 annotations.readOnlyHint=true
 *   - createPurchaseOrder annotations.{readOnlyHint:false, idempotentHint:true}
 *   - MCP_ENABLE_WRITE_TOOLS=false 时 createPurchaseOrder 不注册
 *   - createPurchaseOrder 用内存 Map 幂等(同 idempotencyKey 同 PO 号)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MARKETING_GROWTH_TOOLS, ToolContracts } from '@storepilot/shared-contracts/mcp';
import type { PurchaseOrderResult } from '@storepilot/shared-contracts/mcp';
import { z } from 'zod';

import type { Env } from './config/env.js';
import { getEnv } from './config/env.js';
import { idempotencyStore } from './support/idempotency-store.js';
import { pickFixture } from './support/fixture-loader.js';
import { logger } from './support/logger.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

type RegisterToolConfig = {
  title: string;
  description: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations: { readOnlyHint: boolean; idempotentHint?: boolean };
};

type RegisterToolCompat = (
  name: string,
  config: RegisterToolConfig,
  handler: (rawInput: unknown) => Promise<ToolResult>,
) => void;

function registerToolCompat(
  server: McpServer,
  name: string,
  config: RegisterToolConfig,
  handler: (rawInput: unknown) => Promise<ToolResult>,
): void {
  const register = server.registerTool.bind(server) as unknown as RegisterToolCompat;
  register(name, config, handler);
}

function ok(data: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function fail(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function makePoNo(idempotencyKey: string): string {
  // SSOT 正则:^PO[_-][A-Za-z0-9]{6,32}$ — 中间分隔符仅在 PO 后第一位;后续仅字母数字
  const tail = idempotencyKey.replace(/[^A-Za-z0-9]/g, '').slice(-12).padStart(6, 'X');
  return `PO_MOCK${Date.now()}${tail}`.slice(0, 35);
}

function maybeOmitSchema(
  env: Env,
  toolName: keyof typeof ToolContracts,
  side: 'input' | 'output',
  schema: unknown,
): unknown {
  if (env.MCP_TEST_SCHEMA_MISSING_TOOL === toolName && env.MCP_TEST_SCHEMA_MISSING_SIDE === side) {
    return undefined;
  }
  return schema;
}

export function createMcpServer(envOverride?: Env): McpServer {
  const env = envOverride ?? getEnv();
  const server = new McpServer({
    name: 'erp-mcp-mock',
    version: '1.0.0',
    // 任务卡 05 要求构造期注入协议版本；SDK 1.29 的 Implementation 类型尚未声明该字段。
    protocolVersion: env.MCP_PROTOCOL_VERSION,
  } as { name: string; version: string; protocolVersion: string });

  // --- V1 6 个 QUERY 工具 + V2 9 个 marketing QUERY 工具(readOnlyHint:true) ---
  const queryTools: Array<{
    name: keyof typeof ToolContracts;
    title: string;
    description: string;
  }> = [
    { name: 'getStoreReportConfig', title: '门店报表配置', description: '获取门店日 / 月报卡片配置' },
    { name: 'queryStoreSalesSummary', title: '门店销售汇总', description: '汇总门店销售额 / 订单数 / 客单价 / 趋势' },
    { name: 'queryCategorySalesRatio', title: '品类销售占比', description: '门店各品类销售占比' },
    { name: 'queryProductSalesRank', title: '商品销售榜', description: '门店商品销售 Top N 排行' },
    { name: 'queryInventoryOverview', title: '库存概览', description: '门店库存概览(总数 / 低库存 / 缺货 / 在库价值)' },
    { name: 'queryReplenishmentBaseData', title: '补货基础数据', description: '门店补货预测所需(库存 / 销量 / 在途 / 提前期)' },
    ...MARKETING_GROWTH_TOOLS.map((name) => ({
      name,
      title: `V2 营销工具 ${name}`,
      description: `V2 marketingGrowthCopilot 只读工具 ${name}`,
    })),
  ];

  for (const tool of queryTools) {
    const contract = ToolContracts[tool.name];
    registerToolCompat(
      server,
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        // SDK 1.29 ZodRawShapeCompat | AnySchema:传 ZodObject 走 AnySchema 路径
        inputSchema: maybeOmitSchema(env, tool.name, 'input', contract.input),
        outputSchema: maybeOmitSchema(env, tool.name, 'output', contract.output),
        annotations: { readOnlyHint: true },
      },
      async (rawInput: unknown): Promise<ToolResult> => {
        try {
          const input = (contract.input as unknown as { parse: (x: unknown) => unknown }).parse(rawInput);
          const fn = pickFixture(env.FIXTURE_PROFILE, tool.name);
          const data = await Promise.resolve(fn(input));
          return ok(data);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logger.warn({ tool: tool.name, err: msg }, 'tool execute failed');
          return fail(`[${tool.name}] ${msg}`);
        }
      },
    );
  }

  // --- 1 个 WRITE 工具 createPurchaseOrder(仅 MCP_ENABLE_WRITE_TOOLS=true 时注册) ---
  if (env.MCP_ENABLE_WRITE_TOOLS) {
    const contract = ToolContracts.createPurchaseOrder;
    registerToolCompat(
      server,
      'createPurchaseOrder',
      {
        title: '创建采购单',
        description: '创建 ERP 采购单(写操作,必须 idempotencyKey===sourceDraftId,内存 Map 幂等)',
        // contract.input 含 .refine(...) 为 ZodEffects;SDK AnySchema 路径接受
        inputSchema: maybeOmitSchema(env, 'createPurchaseOrder', 'input', contract.input),
        outputSchema: maybeOmitSchema(env, 'createPurchaseOrder', 'output', contract.output),
        annotations: { readOnlyHint: false, idempotentHint: true },
      },
      (rawInput: unknown): Promise<ToolResult> => {
        try {
          const input = contract.input.parse(rawInput);
          if (idempotencyStore.has(input.idempotencyKey)) {
            const cached = idempotencyStore.get(input.idempotencyKey);
            return Promise.resolve(ok(cached));
          }
          const result: PurchaseOrderResult = {
            success: true as const,
            purchaseOrderNo: makePoNo(input.idempotencyKey),
            createdAt: new Date().toISOString(),
          };
          idempotencyStore.set(input.idempotencyKey, result);
          logger.info(
            { tool: 'createPurchaseOrder', idempotencyKey: input.idempotencyKey, po: result.purchaseOrderNo },
            'PO created',
          );
          return Promise.resolve(ok(result));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logger.warn({ tool: 'createPurchaseOrder', err: msg }, 'createPurchaseOrder failed');
          return Promise.resolve(fail(`[createPurchaseOrder] ${msg}`));
        }
      },
    );
  }

  if (env.MCP_TEST_EXTRA_TOOL_NAME) {
    registerToolCompat(
      server,
      env.MCP_TEST_EXTRA_TOOL_NAME,
      {
        title: '测试专用额外工具',
        description: '仅用于切片 08 白名单 extra 工具故障注入验收',
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.literal(true) }),
        annotations: { readOnlyHint: true },
      },
      () => Promise.resolve(ok({ ok: true })),
    );
  }

  return server;
}
