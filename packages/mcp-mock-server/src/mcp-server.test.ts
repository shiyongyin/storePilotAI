import { describe, expect, it, vi, afterEach } from 'vitest';

const BASE_ENV = {
  NODE_ENV: 'test',
  PORT: '7301',
  MCP_TENANT_SHARED_SECRET: 'abcdefghijklmnopqrstuvwxyz123456',
  MCP_PROTOCOL_VERSION: '2025-01-01',
  MCP_ENABLE_WRITE_TOOLS: 'true',
  FIXTURE_PROFILE: 'happy-path',
};

async function loadServer(overrides: Record<string, string> = {}) {
  vi.resetModules();
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  return import('./mcp-server.js');
}

describe('createMcpServer', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('injects MCP_PROTOCOL_VERSION into the underlying MCP server info', async () => {
    const { createMcpServer } = await loadServer();

    const mcpServer = createMcpServer();

    expect(
      (mcpServer.server as unknown as { _serverInfo: { protocolVersion?: string } })._serverInfo
        .protocolVersion,
    ).toBe('2025-01-01');
  });

  it('omits createPurchaseOrder when write tools are disabled', async () => {
    const { createMcpServer } = await loadServer({ MCP_ENABLE_WRITE_TOOLS: 'false' });

    const mcpServer = createMcpServer();
    const toolNames = Object.keys(
      (mcpServer as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    );

    expect(toolNames).toHaveLength(15);
    expect(toolNames).not.toContain('createPurchaseOrder');
  });

  it('registers all 9 V2 marketing query tools as read-only', async () => {
    const { createMcpServer } = await loadServer();

    const mcpServer = createMcpServer();
    const tools = (mcpServer as unknown as {
      _registeredTools: Record<string, { annotations: unknown; inputSchema?: unknown; outputSchema?: unknown }>;
    })._registeredTools;

    const marketingTools = [
      'query_campaign_history',
      'query_coupon_inventory',
      'query_inventory_status',
      'query_member_consumption_history',
      'query_member_profile',
      'query_member_segments',
      'query_pos_summary_by_time',
      'query_product_performance',
      'query_repurchase_cycle',
    ];

    for (const name of marketingTools) {
      expect(tools[name], `${name} should be registered`).toBeDefined();
      expect(tools[name]?.annotations).toEqual({ readOnlyHint: true });
      expect(tools[name]?.inputSchema).toBeDefined();
      expect(tools[name]?.outputSchema).toBeDefined();
    }
  });

  it('marks query tools read-only and createPurchaseOrder idempotent', async () => {
    const { createMcpServer } = await loadServer();

    const mcpServer = createMcpServer();
    const tools = (mcpServer as unknown as { _registeredTools: Record<string, { annotations: unknown }> })
      ._registeredTools;
    const queryInventoryOverview = tools.queryInventoryOverview;
    const createPurchaseOrder = tools.createPurchaseOrder;

    expect(queryInventoryOverview).toBeDefined();
    expect(createPurchaseOrder).toBeDefined();
    expect(queryInventoryOverview?.annotations).toEqual({ readOnlyHint: true });
    expect(createPurchaseOrder?.annotations).toEqual({
      readOnlyHint: false,
      idempotentHint: true,
    });
  });

  it('can register a test-only extra tool for slice 08 whitelist drift verification', async () => {
    const { createMcpServer } = await loadServer({
      MCP_TEST_EXTRA_TOOL_NAME: 'executeSql',
    });

    const mcpServer = createMcpServer();
    const toolNames = Object.keys(
      (mcpServer as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    );

    expect(toolNames).toContain('executeSql');
  });

  it('can omit one tool schema for slice 08 startup schema verification', async () => {
    const { createMcpServer } = await loadServer({
      MCP_TEST_SCHEMA_MISSING_TOOL: 'queryReplenishmentBaseData',
      MCP_TEST_SCHEMA_MISSING_SIDE: 'input',
    });

    const mcpServer = createMcpServer();
    const tools = (mcpServer as unknown as {
      _registeredTools: Record<string, { inputSchema?: unknown; outputSchema?: unknown }>;
    })._registeredTools;

    expect(tools.queryReplenishmentBaseData?.inputSchema).toBeUndefined();
    expect(tools.queryReplenishmentBaseData?.outputSchema).toBeDefined();
  });
});
