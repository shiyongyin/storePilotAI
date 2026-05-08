/**
 * 切片 05 — mcp-mock-server env zod parse + fail-fast
 * 严格按 docs/任务卡/G-MCP-Mock.md §T-MCP-01 §3 表落地。
 *
 * 强约束(任务卡 §7 MUST DO §10 / §14):
 *   - NODE_ENV=production → process.exit(1)(生产禁 Mock)
 *   - 缺 MCP_TENANT_SHARED_SECRET → process.exit(1) + 日志 'env validation failed: MCP_TENANT_SHARED_SECRET required'
 */
/* eslint-disable no-console */
import { z } from 'zod';

const FixtureProfile = z.enum([
  'happy-path',
  'missing-category-ratio',
  'slow-sales-summary',
  'create-po-idempotent',
  'empty-inventory',
  'cross-tenant-denied',
]);

export type FixtureProfile = z.infer<typeof FixtureProfile>;

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(7300),
  MCP_PROTOCOL_VERSION: z.string().min(1).default('2025-06-18'),
  MCP_TOOL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
  MCP_ENABLE_WRITE_TOOLS: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .default(true)
    .transform((v) => v === true || v === 'true'),
  FIXTURE_PROFILE: FixtureProfile.default('happy-path'),
  MCP_TENANT_SHARED_SECRET: z.string().min(32),
  MCP_ALLOWED_HOSTS: z.string().default('localhost:7300,127.0.0.1:7300'),
  MCP_CORS_ORIGIN: z.string().default('*'),
  MCP_TEST_EXTRA_TOOL_NAME: z.string().min(1).optional(),
  MCP_TEST_SCHEMA_MISSING_TOOL: z
    .enum([
      'createPurchaseOrder',
      'getStoreReportConfig',
      'queryCategorySalesRatio',
      'queryInventoryOverview',
      'queryProductSalesRank',
      'queryReplenishmentBaseData',
      'queryStoreSalesSummary',
    ])
    .optional(),
  MCP_TEST_SCHEMA_MISSING_SIDE: z.enum(['input', 'output']).optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (_env) return _env;

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    const fields = Object.keys(flat.fieldErrors);
    if (fields.includes('MCP_TENANT_SHARED_SECRET')) {
      console.error('env validation failed: MCP_TENANT_SHARED_SECRET required');
    }
    console.error('[mcp-mock][env] 配置错误:', flat);
    process.exit(1);
  }

  if (parsed.data.NODE_ENV === 'production') {
    console.error('[mcp-mock] 不允许在生产环境运行(切片 05 §7 MUST DO §10)');
    process.exit(1);
  }

  _env = parsed.data;
  return _env;
}
