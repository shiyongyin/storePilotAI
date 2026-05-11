import { Agent } from '@mastra/core/agent';
import { MARKETING_GROWTH_TOOLS, MarketingToolContracts } from '@storepilot/shared-contracts';
import { stepCountIs } from 'ai';

import { getModel } from '../llm-provider.js';
import { mcpTools } from '../mcp/client.js';
import { buildPhase2Instructions } from '../../marketing/phase2/instructions.js';

export const MARKETING_AGENT_MAX_STEPS = 8;

export const BASE_MARKETING_INSTRUCTIONS = `你是 StorePilotAI 的单店营销增长副驾驶 marketingGrowthCopilot。

边界：
1. 只能使用 9 个只读营销 MCP 工具：${MARKETING_GROWTH_TOOLS.join(', ')}。
2. 最多 8 次工具调用（maxSteps=8）；必要时先问清楚，不要扩大工具调用。
3. 不得调用 createPurchaseOrder，不发券、不群发、不改价、不改库存、不改积分。
4. 不得加载 External Skills，不读取 SKILL.md / references / scripts，也不得把外部资料当作营销规则来源。
5. 会员姓名和手机号只用脱敏字段；不得输出完整姓名、完整手机号、身份证、邮箱、地址。
6. 销售额、库存、毛利、券数量、会员数必须来自工具返回或确定性计算；禁止编造。
7. 老板可见回复不得出现 tool_calls / function_call / traceId / merchantId / storeId / agent_run_id。

输出：
- 用简洁中文给出建议，必须说明依据来自哪些工具事实。
- 如果是会员类问题，默认过滤散客。
- 如果是商品类问题，必须过滤缺货商品并提示毛利、合规或品牌风险。
- 阶段 2 结果应携带合法 card_data 注释块，供 OutputGuard 校验。`;

export const MARKETING_GROWTH_INSTRUCTIONS = [
  BASE_MARKETING_INSTRUCTIONS,
  buildPhase2Instructions(),
].join('\n\n');

type JsonSchemaLike = {
  jsonSchema?: {
    properties?: Record<string, unknown>;
    required?: string[];
    'x-optional'?: string[];
  };
};

type MarketingToolName = keyof typeof MarketingToolContracts;

type MarketingToolLike = {
  inputSchema?: unknown;
  execute?: (input: Record<string, unknown>, context?: unknown) => Promise<unknown>;
  [key: string]: unknown;
};

type TenantRuntimeContext = {
  get(key: string): unknown;
};

function tenantValue(ctx: TenantRuntimeContext | undefined, key: 'merchantId' | 'storeId'): string {
  const value = ctx?.get(key);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`RuntimeContext 缺少 ${key}`);
  }
  return value;
}

function hideTenantFromInputSchema(schema: unknown): unknown {
  const jsonSchema = (schema as JsonSchemaLike | undefined)?.jsonSchema;
  if (!jsonSchema?.properties) return schema;

  const { merchantId: _merchantId, storeId: _storeId, ...properties } = jsonSchema.properties;
  return {
    ...(schema as Record<string, unknown>),
    jsonSchema: {
      ...jsonSchema,
      properties,
      required: jsonSchema.required?.filter((key) => key !== 'merchantId' && key !== 'storeId'),
      'x-optional': jsonSchema['x-optional']?.filter((key) => key !== 'merchantId' && key !== 'storeId'),
    },
  };
}

function omitTenantFromJsonSchema(
  schema: {
    properties?: Record<string, unknown>;
    required?: string[];
    'x-optional'?: string[];
    [key: string]: unknown;
  },
): {
  properties?: Record<string, unknown>;
  required?: string[];
  'x-optional'?: string[];
  [key: string]: unknown;
} {
  const { merchantId: _merchantId, storeId: _storeId, ...properties } = schema.properties ?? {};
  const out: {
    properties?: Record<string, unknown>;
    required?: string[];
    'x-optional'?: string[];
    [key: string]: unknown;
  } = {
    ...schema,
    properties,
  };
  const required = schema.required?.filter((key) => key !== 'merchantId' && key !== 'storeId');
  if (required !== undefined) out.required = required;
  const optional = schema['x-optional']?.filter((key) => key !== 'merchantId' && key !== 'storeId');
  if (optional !== undefined) out['x-optional'] = optional;
  return out;
}

function modelVisibleInputSchema(toolName: string, fallback: unknown): unknown {
  const contract = MarketingToolContracts[toolName as MarketingToolName];
  if (!contract) return hideTenantFromInputSchema(fallback);
  const input = contract.input as {
    toJSONSchema(): {
      properties?: Record<string, unknown>;
      required?: string[];
      'x-optional'?: string[];
      [key: string]: unknown;
    };
    safeParse(value: unknown): { success: boolean; data?: Record<string, unknown>; error?: { message: string } };
  };
  return {
    jsonSchema: omitTenantFromJsonSchema(input.toJSONSchema()),
    validate: (value: unknown) => {
      const result = input.safeParse({
        ...(typeof value === 'object' && value !== null ? value : {}),
        merchantId: '__tenant_placeholder__',
        storeId: '__tenant_placeholder__',
      });
      if (!result.success) {
        return { success: false, error: new Error(result.error?.message ?? 'invalid marketing tool input') };
      }
      return { success: true, value };
    },
  };
}

export function buildMarketingToolsForRuntime(
  tools: Record<string, unknown>,
  requestContext?: TenantRuntimeContext,
): Record<string, MarketingToolLike> {
  const allowed = new Set<string>(MARKETING_GROWTH_TOOLS);
  return Object.fromEntries(
    Object.entries(tools)
      .filter(([name]) => allowed.has(name))
      .map(([name, tool]) => {
        const source = tool as MarketingToolLike;
        return [
          name,
          {
            ...source,
            inputSchema: modelVisibleInputSchema(name, source.inputSchema),
            execute: async (input: Record<string, unknown>, context?: unknown) => {
              if (typeof source.execute !== 'function') {
                throw new Error(`marketing MCP tool ${name} missing execute`);
              }
              return source.execute(
                {
                  ...input,
                  merchantId: tenantValue(requestContext, 'merchantId'),
                  storeId: tenantValue(requestContext, 'storeId'),
                },
                context,
              );
            },
          },
        ];
      }),
  ) as Record<string, MarketingToolLike>;
}

async function getMarketingTools(args?: { requestContext?: TenantRuntimeContext }): Promise<Record<string, unknown>> {
  const tools = await mcpTools();
  return buildMarketingToolsForRuntime(tools, args?.requestContext);
}

export function createMarketingGrowthCopilotAgent() {
  return new Agent({
    id: 'marketingGrowthCopilot',
    name: 'marketingGrowthCopilot',
    description: 'V2 单店营销增长副驾驶；只使用 9 个只读 marketing MCP 工具，不接 External Skills',
    model: getModel(),
    tools: getMarketingTools as never,
    instructions: MARKETING_GROWTH_INSTRUCTIONS,
    defaultOptions: {
      stopWhen: stepCountIs(MARKETING_AGENT_MAX_STEPS),
    },
  });
}

export const marketingGrowthCopilot = createMarketingGrowthCopilotAgent();
