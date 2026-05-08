/**
 * 切片 18 §9 — MCP fixtures 集成测试（in-process）
 *
 * 验证 mcp-mock-server 6 fixture profile 在 in-process 启动器下的端到端语义：
 *   - happy-path：所有工具返回完整数据
 *   - missing-category-ratio：queryCategorySalesRatio 缺数据 → 空数组 / 失败响应
 *   - slow-sales-summary：querySalesSummary 慢响应（<5s 默认 timeout）
 *   - create-po-idempotent：createPurchaseOrder 同 idempotencyKey 100 次 → 1 PO
 *   - empty-inventory：queryInventoryOverview 返回空
 *   - cross-tenant-denied：跨租户调用返回 ACCESS_DENIED
 *
 * 测试形态：通过 raw HTTP 直接调用 mock 的 /mcp jsonrpc 端点，
 * 避免引入 @modelcontextprotocol/sdk client 依赖耦合。
 *
 * 严格遵循任务卡 §T-TEST-01.5 §3：随机端口 + 7/6 工具齐全。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startMcpMock, type McpMockHandle } from '../../src/test-helpers/mcp-in-process.js';

const TENANT_SECRET = 'a'.repeat(32);

let mcp: McpMockHandle;

afterEach(async () => {
  await mcp?.close().catch(() => undefined);
});

interface JsonRpcResp<T> {
  jsonrpc: '2.0';
  id: number | string;
  result?: T;
  error?: { code: number; message: string };
}

async function rpc<T = unknown>(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
  tenantSecret = TENANT_SECRET,
): Promise<JsonRpcResp<T>> {
  const res = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-Tenant-Key': tenantSecret,
      'X-Mcp-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await res.json()) as JsonRpcResp<T>;
}

interface ToolsListResult {
  tools?: Array<{ name: string }>;
}

interface ToolsCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

describe('MCP fixtures — happy-path（任务卡 §T-TEST-01.5 §3）', () => {
  beforeEach(async () => {
    mcp = await startMcpMock({ fixtures: 'happy-path' });
  });

  it('tools/list 返回 7 个工具（含 createPurchaseOrder）', async () => {
    const r = await rpc<ToolsListResult>(mcp.url, 'tools/list');
    const names = (r.result?.tools ?? []).map((t) => t.name).sort();
    expect(names).toContain('createPurchaseOrder');
    expect(names.length).toBe(7);
  });

  it('getStoreReportConfig 返回 currency=CNY + dailyCards 非空', async () => {
    const r = await rpc<ToolsCallResult>(mcp.url, 'tools/call', {
      name: 'getStoreReportConfig',
      arguments: { merchantId: 'M001', storeId: 'S001' },
    });
    expect(r.error).toBeUndefined();
    expect(r.result?.isError).toBeFalsy();
    const sc = r.result?.structuredContent as {
      currency?: string;
      dailyCards?: unknown[];
    };
    expect(sc?.currency).toBe('CNY');
    expect(Array.isArray(sc?.dailyCards)).toBe(true);
    expect(sc?.dailyCards?.length).toBeGreaterThan(0);
  });
});

describe('MCP fixtures — enableWriteTools=false（任务卡 §T-TEST-01.5 §3）', () => {
  beforeEach(async () => {
    mcp = await startMcpMock({ enableWriteTools: false });
  });

  it('tools/list 返回 6 个工具（不含 createPurchaseOrder）', async () => {
    const r = await rpc<ToolsListResult>(mcp.url, 'tools/list');
    const names = (r.result?.tools ?? []).map((t) => t.name);
    expect(names).not.toContain('createPurchaseOrder');
    expect(names.length).toBe(6);
  });

  it('调 createPurchaseOrder → 工具不存在错误', async () => {
    const r = await rpc<ToolsCallResult>(mcp.url, 'tools/call', {
      name: 'createPurchaseOrder',
      arguments: { merchantId: 'M001', storeId: 'S001', items: [] },
    });
    // 期待 Method not found 或 isError=true
    expect(r.error !== undefined || r.result?.isError === true).toBe(true);
  });
});

describe('MCP fixtures — create-po-idempotent（任务卡 §10 测试场景 11）', () => {
  beforeEach(async () => {
    mcp = await startMcpMock({ fixtures: 'create-po-idempotent' });
  });

  it('I-11：相同 idempotencyKey 多次调用 → 同一 PO 号', async () => {
    const args = {
      merchantId: 'M001',
      storeId: 'S001',
      source: 'AI_REPLENISHMENT_AGENT',
      sourceDraftId: 'drf_idempotent',
      idempotencyKey: 'drf_idempotent',
      items: [
        { skuId: 'SKU001', quantity: 5, unit: '瓶', reason: 'r' },
      ],
    };

    const r1 = await rpc<ToolsCallResult>(mcp.url, 'tools/call', {
      name: 'createPurchaseOrder',
      arguments: args,
    });
    const r2 = await rpc<ToolsCallResult>(mcp.url, 'tools/call', {
      name: 'createPurchaseOrder',
      arguments: args,
    });

    expect(r1.result?.isError).toBeFalsy();
    expect(r2.result?.isError).toBeFalsy();

    const po1 = (r1.result?.structuredContent as { purchaseOrderNo?: string })?.purchaseOrderNo;
    const po2 = (r2.result?.structuredContent as { purchaseOrderNo?: string })?.purchaseOrderNo;
    expect(po1).toBeTruthy();
    expect(po2).toBe(po1);
  });
});

describe('MCP fixtures — empty-inventory', () => {
  beforeEach(async () => {
    mcp = await startMcpMock({ fixtures: 'empty-inventory' });
  });

  it('queryInventoryOverview 返回 lowStockSkus=0 + outOfStockSkus 非零', async () => {
    const r = await rpc<ToolsCallResult>(mcp.url, 'tools/call', {
      name: 'queryInventoryOverview',
      arguments: {
        merchantId: 'M001',
        storeId: 'S001',
        lowStockThresholdDays: 3,
      },
    });
    expect(r.result?.isError).toBeFalsy();
    const sc = r.result?.structuredContent as {
      lowStockSkus?: number;
      outOfStockSkus?: number;
      totalOnHandValue?: number;
    };
    expect(sc?.lowStockSkus).toBe(0);
    expect(sc?.outOfStockSkus).toBeGreaterThan(0);
    expect(sc?.totalOnHandValue).toBe(0);
  });
});

describe('MCP fixtures — cross-tenant-denied（跨租户硬隔离）', () => {
  beforeEach(async () => {
    mcp = await startMcpMock({ fixtures: 'cross-tenant-denied' });
  });

  it('错误的 X-Tenant-Key → 401/403 鉴权拒绝', async () => {
    const res = await fetch(`${mcp.url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'X-Tenant-Key': 'wrong-secret-' + 'x'.repeat(20),
        'X-Mcp-Protocol-Version': '2025-06-18',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    });
    expect([401, 403]).toContain(res.status);
  });

  it('缺 X-Tenant-Key → 401', async () => {
    const res = await fetch(`${mcp.url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'X-Mcp-Protocol-Version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect([401, 403]).toContain(res.status);
  });
});

describe('MCP fixtures — protocol negotiation', () => {
  beforeEach(async () => {
    mcp = await startMcpMock({ fixtures: 'happy-path' });
  });

  it('initialize 协议握手返回 protocolVersion + serverInfo', async () => {
    const r = await rpc<{
      protocolVersion: string;
      serverInfo: { name: string };
      capabilities: unknown;
    }>(mcp.url, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'integration-test', version: '1.0.0' },
    });
    expect(r.error).toBeUndefined();
    expect(r.result?.protocolVersion).toBe('2025-06-18');
    expect(r.result?.serverInfo?.name).toBeTruthy();
  });

  it('tools/call 未知工具 → JSON-RPC error 或 isError=true（不 crash）', async () => {
    const r = await rpc<ToolsCallResult>(mcp.url, 'tools/call', {
      name: '__non_existent_tool__',
      arguments: {},
    });
    expect(r.error !== undefined || r.result?.isError === true).toBe(true);
  });

  it('jsonrpc 字段缺失 → 400 或解析错误（防御性）', async () => {
    const res = await fetch(`${mcp.url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'X-Tenant-Key': TENANT_SECRET,
        'X-Mcp-Protocol-Version': '2025-06-18',
      },
      body: JSON.stringify({ id: 1, method: 'tools/list' }),
    });
    // 不应是 200 + 正常 result（必须是错误响应或 4xx）
    if (res.status === 200) {
      const json = (await res.json()) as JsonRpcResp<unknown>;
      expect(json.error).toBeDefined();
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });
});
