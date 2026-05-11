import { RequestContext } from '@mastra/core/di';
import { describe, expect, it, vi } from 'vitest';

const ENV_FIXTURE: Record<string, string> = {
  NODE_ENV: 'test',
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

for (const [key, value] of Object.entries(ENV_FIXTURE)) vi.stubEnv(key, value);

describe('marketingGrowthCopilot instructions', () => {
  it('composes base and Phase2 instructions', async () => {
    const { MARKETING_GROWTH_INSTRUCTIONS } = await import('./marketing-growth-copilot.js');

    expect(MARKETING_GROWTH_INSTRUCTIONS).toContain('marketingGrowthCopilot');
    expect(MARKETING_GROWTH_INSTRUCTIONS).toContain('V2 Phase2 营销场景边界');
    expect(MARKETING_GROWTH_INSTRUCTIONS).toContain('US-003');
    expect(MARKETING_GROWTH_INSTRUCTIONS).toContain('US-010');
    expect(MARKETING_GROWTH_INSTRUCTIONS).not.toMatch(/1\d{10}/);
  });
});

describe('marketingGrowthCopilot tools', () => {
  it('对模型隐藏 tenant 字段，并在执行时从 RuntimeContext 注入 tenant', async () => {
    const { buildMarketingToolsForRuntime } = await import('./marketing-growth-copilot.js');
    const called: unknown[] = [];
    const rawTools = {
      query_member_segments: {
        id: 'query_member_segments',
        description: 'segments',
        inputSchema: { '~standard': { version: 1, vendor: 'json-schema', jsonSchema: {} } },
        execute: async (input: unknown) => {
          called.push(input);
          return {
            merchantId: (input as { merchantId: string }).merchantId,
            storeId: (input as { storeId: string }).storeId,
            segments: [],
          };
        },
      },
    };
    const ctx = new RequestContext();
    ctx.set('merchantId', 'M001');
    ctx.set('storeId', 'S001');

    const tools = buildMarketingToolsForRuntime(rawTools, ctx);
    const schema = (tools.query_member_segments as {
      inputSchema: {
        jsonSchema: { properties?: Record<string, unknown>; required?: string[] };
      };
      execute(input: unknown, context?: unknown): Promise<unknown>;
    }).inputSchema.jsonSchema;

    expect(schema.properties ?? {}).not.toHaveProperty('merchantId');
    expect(schema.properties ?? {}).not.toHaveProperty('storeId');
    expect(schema.required).not.toContain('merchantId');
    expect(schema.required).not.toContain('storeId');

    await tools.query_member_segments!.execute!({ segmentCodes: ['DORMANT_NORMAL'] });
    expect(called).toEqual([
      {
        merchantId: 'M001',
        storeId: 'S001',
        segmentCodes: ['DORMANT_NORMAL'],
      },
    ]);
  });
});
