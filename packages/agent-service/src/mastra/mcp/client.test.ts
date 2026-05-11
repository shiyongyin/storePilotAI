/**
 * 切片 08 §9.10-§9.11 / §11 自检 — mcp/client 单元测试
 *
 * 用 mock 隔离 MCPClient（避免单测期需要真实启 mcp-mock-server）；真实端到端启动在
 * `pnpm dev:mcp` + `pnpm dev:agent` 冒烟（任务卡 §9.1-§9.9）覆盖。
 *
 * 覆盖项：
 *   - TOOL_WHITELIST 与 shared-contracts/TOOL_NAMES **字典序严格相等**（守门 §7 MUST DO §1）
 *   - getMcpClient() 单例：多次返回同一引用（§7 MUST DO §8 / §9.10）
 *   - verifyMcpToolsAtStartup happy path：16 工具齐全 + schema 非空 → resolve 不抛
 *   - verifyMcpToolsAtStartup missing：缺 createPurchaseOrder → 抛 McpWhitelistError(missing)
 *   - verifyMcpToolsAtStartup extra：多 executeSql → 抛 McpWhitelistError(extra)
 *   - verifyMcpToolsAtStartup schema 缺失：inputSchema undefined → 抛错并含工具名
 *   - disposeMcpClient：disconnect 异常被吞（不重抛、不阻断退出）
 */
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TOOL_NAMES } from '@storepilot/shared-contracts';

vi.mock('@mastra/mcp', () => {
  type ToolMap = Record<string, { inputSchema?: unknown; outputSchema?: unknown }>;
  /**
   * 全局可控 mock：测试用例通过 setMockToolsets 注入 listToolsets 的返回值与异常。
   * 每个 MCPClient 实例 disconnect 累计调用次数，便于 dispose 单测断言。
   */
  const state: {
    toolsets: Record<string, ToolMap>;
    disconnectCalls: number;
    disconnectThrow: boolean;
    instanceCount: number;
    constructorArgs: unknown[];
  } = {
    toolsets: { erp: {} },
    disconnectCalls: 0,
    disconnectThrow: false,
    instanceCount: 0,
    constructorArgs: [],
  };
  class MCPClient {
    public readonly _instanceId: number;
    constructor(args: unknown) {
      state.instanceCount += 1;
      state.constructorArgs.push(args);
      this._instanceId = state.instanceCount;
    }
    listToolsets(): Promise<Record<string, ToolMap>> {
      return Promise.resolve(state.toolsets);
    }
    disconnect(): Promise<void> {
      state.disconnectCalls += 1;
      if (state.disconnectThrow) {
        return Promise.reject(new Error('boom from disconnect'));
      }
      return Promise.resolve();
    }
  }
  return {
    MCPClient,
    __mcpClientMockState: state,
    __setMockToolsets: (t: Record<string, ToolMap>) => {
      state.toolsets = t;
    },
    __setDisconnectThrow: (v: boolean) => {
      state.disconnectThrow = v;
    },
    __resetMcpClientMockState: () => {
      state.toolsets = { erp: {} };
      state.disconnectCalls = 0;
      state.disconnectThrow = false;
      state.instanceCount = 0;
      state.constructorArgs = [];
    },
  };
});

const ENV_FIXTURE: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '7100',
  DATABASE_URL: 'mysql://test:test@localhost:3306/test',
  MODEL_PROVIDER: 'openai-compatible',
  MODEL_BASE_URL: 'http://localhost:7100/llm',
  MODEL_API_KEY: 'sk-test-1234567890',
  MODEL_NAME: 'gpt-test',
  ERP_MCP_SERVER_URL: 'http://localhost:7300/mcp',
  MCP_TENANT_SHARED_SECRET: 'a'.repeat(32),
  MCP_PROTOCOL_VERSION: '2025-06-18',
  AGENT_API_KEY_HASH_SALT: 'salt-abcdef-1234',
  AGENT_API_KEY_PREFIX: 'sk-agent-',
  CORS_ALLOWED_ORIGINS: 'http://localhost:3210',
};

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV_FIXTURE)) vi.stubEnv(k, v);
});

afterEach(async () => {
  // 每个用例独立 reset 单例 / mock 状态
  const { __resetMcpClientForTest } = await import('./client.js');
  const { __resetMcpClientMockState } = (await import('@mastra/mcp')) as unknown as {
    __resetMcpClientMockState: () => void;
  };
  __resetMcpClientForTest();
  __resetMcpClientMockState();
  vi.unstubAllEnvs();
});

function buildToolEntry(): { inputSchema: unknown; outputSchema: unknown } {
  return {
    inputSchema: z.object({}),
    outputSchema: z.object({}),
  };
}

function buildHappyToolset(): Record<string, ReturnType<typeof buildToolEntry>> {
  const out: Record<string, ReturnType<typeof buildToolEntry>> = {};
  for (const name of TOOL_NAMES) out[name] = buildToolEntry();
  return out;
}

describe('切片 08 — TOOL_WHITELIST 与 shared-contracts TOOL_NAMES 字典序严格相等', () => {
  it('TOOL_WHITELIST.length === TOOL_NAMES.length === 16', async () => {
    const { TOOL_WHITELIST } = await import('./client.js');
    expect(TOOL_WHITELIST.length).toBe(16);
    expect(TOOL_NAMES.length).toBe(16);
  });

  it('JSON.stringify(TOOL_WHITELIST.sort()) === JSON.stringify([...TOOL_NAMES].sort())', async () => {
    const { TOOL_WHITELIST } = await import('./client.js');
    expect(JSON.stringify([...TOOL_WHITELIST].sort())).toBe(JSON.stringify([...TOOL_NAMES].sort()));
  });

  it('TOOL_WHITELIST 每一项都在 TOOL_NAMES 中（命名漂移守门）', async () => {
    const { TOOL_WHITELIST } = await import('./client.js');
    const expectedSet = new Set<string>(TOOL_NAMES);
    for (const t of TOOL_WHITELIST) expect(expectedSet.has(t)).toBe(true);
  });
});

describe('切片 08 — getMcpClient 单例 (§9.10)', () => {
  it('多次调用必须返回同一引用', async () => {
    const { getMcpClient } = await import('./client.js');
    const a = getMcpClient();
    const b = getMcpClient();
    const c = getMcpClient();
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('mock state 应只 new MCPClient 一次（不每次工具调用都 new）', async () => {
    const { getMcpClient } = await import('./client.js');
    const mock = (await import('@mastra/mcp')) as unknown as {
      __mcpClientMockState: { instanceCount: number };
    };
    getMcpClient();
    getMcpClient();
    getMcpClient();
    expect(mock.__mcpClientMockState.instanceCount).toBe(1);
  });

  it('构造 MCPClient 时必须传稳定 id，避免新版相同配置实例缓存误判', async () => {
    const { getMcpClient } = await import('./client.js');
    const mock = (await import('@mastra/mcp')) as unknown as {
      __mcpClientMockState: { constructorArgs: unknown[] };
    };

    getMcpClient();

    expect(mock.__mcpClientMockState.constructorArgs).toHaveLength(1);
    const constructorArg: unknown = mock.__mcpClientMockState.constructorArgs[0];
    expect(constructorArg).toEqual(expect.objectContaining({ id: 'storepilot-erp-mcp-client' }));
    expect(typeof (constructorArg as { servers?: unknown }).servers).toBe('object');
    expect((constructorArg as { servers?: unknown }).servers).not.toBeNull();
  });
});

describe('切片 08 — verifyMcpToolsAtStartup happy path (§9.2)', () => {
  it('16 工具齐全 + schema 非空 → resolve 不抛', async () => {
    const mod = await import('@mastra/mcp');
    (mod as unknown as {
      __setMockToolsets: (t: unknown) => void;
    }).__setMockToolsets({ erp: buildHappyToolset() });

    const { __setMcpToolSchemasForTest, verifyMcpToolsAtStartup } = await import('./client.js');
    __setMcpToolSchemasForTest(async () => buildHappyToolset());

    await expect(verifyMcpToolsAtStartup()).resolves.toBeUndefined();
  });

  it('Mastra 1.7 listToolsets 可不暴露 outputSchema，但原始 MCP tools/list schema 完整时仍通过', async () => {
    const mastraToolsetWithoutOutputSchema: Record<string, { inputSchema: unknown }> = {};
    for (const name of TOOL_NAMES) {
      mastraToolsetWithoutOutputSchema[name] = { inputSchema: z.object({}) };
    }
    (await import('@mastra/mcp') as unknown as {
      __setMockToolsets: (t: unknown) => void;
    }).__setMockToolsets({ erp: mastraToolsetWithoutOutputSchema });

    const { __setMcpToolSchemasForTest, verifyMcpToolsAtStartup } = await import('./client.js');
    __setMcpToolSchemasForTest(async () => buildHappyToolset());

    await expect(verifyMcpToolsAtStartup()).resolves.toBeUndefined();
  });
});

describe('切片 08 — verifyMcpToolsAtStartup 缺工具 (§9.4 / §10.2)', () => {
  it('缺 createPurchaseOrder → 抛 McpWhitelistError + missing 含 createPurchaseOrder', async () => {
    const happy = buildHappyToolset();
    delete (happy as Record<string, unknown>)['createPurchaseOrder'];
    (await import('@mastra/mcp') as unknown as {
      __setMockToolsets: (t: unknown) => void;
    }).__setMockToolsets({ erp: happy });

    const { __setMcpToolSchemasForTest, verifyMcpToolsAtStartup, McpWhitelistError } = await import('./client.js');
    __setMcpToolSchemasForTest(async () => happy);

    try {
      await verifyMcpToolsAtStartup();
      expect.fail('expected McpWhitelistError');
    } catch (e) {
      expect(e).toBeInstanceOf(McpWhitelistError);
      const err = e as InstanceType<typeof McpWhitelistError>;
      expect(err.missing).toContain('createPurchaseOrder');
      expect(err.message).toContain('createPurchaseOrder');
      expect(err.message).toContain('missing=');
    }
  });
});

describe('切片 08 — verifyMcpToolsAtStartup 多工具 (§9.5 / §10.3)', () => {
  it('多 executeSql → 抛 McpWhitelistError + extra 含 executeSql', async () => {
    const happy = buildHappyToolset() as Record<string, ReturnType<typeof buildToolEntry>>;
    happy['executeSql'] = buildToolEntry();
    (await import('@mastra/mcp') as unknown as {
      __setMockToolsets: (t: unknown) => void;
    }).__setMockToolsets({ erp: happy });

    const { __setMcpToolSchemasForTest, verifyMcpToolsAtStartup, McpWhitelistError } = await import('./client.js');
    __setMcpToolSchemasForTest(async () => happy);

    try {
      await verifyMcpToolsAtStartup();
      expect.fail('expected McpWhitelistError');
    } catch (e) {
      expect(e).toBeInstanceOf(McpWhitelistError);
      const err = e as InstanceType<typeof McpWhitelistError>;
      expect(err.extra).toContain('executeSql');
      expect(err.message).toContain('extra=');
      expect(err.message).toContain('executeSql');
    }
  });
});

describe('切片 08 — verifyMcpToolsAtStartup schema 缺失 (§9.6 / §10.4)', () => {
  it('inputSchema undefined → 抛错且含工具名', async () => {
    const happy = buildHappyToolset();
    happy['queryReplenishmentBaseData'] = {
      inputSchema: undefined,
      outputSchema: z.object({}),
    } as unknown as ReturnType<typeof buildToolEntry>;
    (await import('@mastra/mcp') as unknown as {
      __setMockToolsets: (t: unknown) => void;
    }).__setMockToolsets({ erp: happy });

    const { __setMcpToolSchemasForTest, verifyMcpToolsAtStartup, McpWhitelistError } = await import('./client.js');
    __setMcpToolSchemasForTest(async () => happy);

    try {
      await verifyMcpToolsAtStartup();
      expect.fail('expected McpWhitelistError');
    } catch (e) {
      expect(e).toBeInstanceOf(McpWhitelistError);
      const err = e as InstanceType<typeof McpWhitelistError>;
      expect(err.schemaMissing).toContain('queryReplenishmentBaseData');
      expect(err.message).toContain('queryReplenishmentBaseData');
      expect(err.message).toContain('input/output schema');
    }
  });

  it('outputSchema undefined → 抛错且含工具名', async () => {
    const happy = buildHappyToolset();
    happy['queryStoreSalesSummary'] = {
      inputSchema: z.object({}),
      outputSchema: undefined,
    } as unknown as ReturnType<typeof buildToolEntry>;
    (await import('@mastra/mcp') as unknown as {
      __setMockToolsets: (t: unknown) => void;
    }).__setMockToolsets({ erp: happy });

    const { __setMcpToolSchemasForTest, verifyMcpToolsAtStartup, McpWhitelistError } = await import('./client.js');
    __setMcpToolSchemasForTest(async () => happy);

    await expect(verifyMcpToolsAtStartup()).rejects.toThrow(McpWhitelistError);
  });
});

describe('切片 08 — disposeMcpClient (§7 MUST NOT §3 / §9.9)', () => {
  it('disconnect 异常必须被吞（退出不阻断）', async () => {
    const mock = (await import('@mastra/mcp')) as unknown as {
      __setDisconnectThrow: (v: boolean) => void;
      __mcpClientMockState: { disconnectCalls: number };
    };
    mock.__setDisconnectThrow(true);

    const { getMcpClient, disposeMcpClient } = await import('./client.js');
    getMcpClient();
    await expect(disposeMcpClient()).resolves.toBeUndefined();
    expect(mock.__mcpClientMockState.disconnectCalls).toBe(1);
  });

  it('disconnect 成功 → 单例置空，再次 getMcpClient 重新创建', async () => {
    const mock = (await import('@mastra/mcp')) as unknown as {
      __mcpClientMockState: { instanceCount: number };
    };
    const { getMcpClient, disposeMcpClient } = await import('./client.js');
    const a = getMcpClient();
    await disposeMcpClient();
    const b = getMcpClient();
    expect(a).not.toBe(b);
    expect(mock.__mcpClientMockState.instanceCount).toBe(2);
  });

  it('未初始化时 dispose 必须 NOOP（幂等）', async () => {
    const { disposeMcpClient } = await import('./client.js');
    await expect(disposeMcpClient()).resolves.toBeUndefined();
  });
});
