/**
 * 切片 01 — env zod parse + getEnv() 单例 + fail-fast
 * 严格按 docs/任务卡/A-基础设施.md §T-INFRA-04 §5.1（23 基础字段）+ §5.2 落地；
 * 另含切片 11 数字一致性运行期开关。
 * 唯一允许 `process.env.*` 直读的源文件;唯一允许 `console.error` 的源文件(fail-fast 输出)。
 */
/* eslint-disable no-console */
import { z } from 'zod';

const BooleanStringSchema = z
  .enum(['true', 'false'])
  .default('true')
  .transform((v) => v === 'true');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(7100),
    DATABASE_URL: z.string().regex(/^mysql:\/\/.+/, 'DATABASE_URL must be mysql://'),
    MODEL_PROVIDER: z.enum(['openai-compatible', 'openai', 'azure']).default('openai-compatible'),
    MODEL_BASE_URL: z.string().url(),
    MODEL_API_KEY: z.string().min(8),
    MODEL_NAME: z.string().min(1),
    MODEL_TIMEOUT_MS: z.coerce.number().int().min(5000).max(60000).default(25000),
    MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(8192).default(4096),
    MAX_TOOL_CALLS_PER_REQUEST: z.coerce.number().int().min(1).max(20).default(8),
    ERP_MCP_SERVER_URL: z.string().url(),
    MCP_TENANT_SHARED_SECRET: z.string().min(32),
    MCP_PROTOCOL_VERSION: z.literal('2025-06-18').default('2025-06-18'),
    TOOL_CALL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(15000),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(20),
    DB_QUEUE_LIMIT: z.coerce.number().int().min(0).max(1000).default(200),
    AGENT_API_KEY_HASH_SALT: z.string().min(16),
    AGENT_API_KEY_PREFIX: z.literal('sk-agent-').default('sk-agent-'),
    CORS_ALLOWED_ORIGINS: z
      .string()
      .refine(
        (s) => process.env.NODE_ENV !== 'production' || !s.includes('*'),
        '生产 CORS 不能 *',
      ),
    USER_MESSAGE_MAX_CHARS: z.coerce.number().int().min(1).max(4000).default(4000),
    SUSPEND_TTL_MINUTES: z.coerce.number().int().min(1).max(120).default(30),
    RETENTION_DAYS_RUN_LOG: z.coerce.number().int().min(7).max(365).default(180),
    NUMBER_CONSISTENCY_CHECK_ENABLED: BooleanStringSchema,
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
    /**
     * 切片 21 — Skill 灰度白名单（任务卡 §7 MUST DO §4 / §8.2）。
     *
     * 形态：逗号分隔的 merchantId 列表（如 `M001,M002`）；空 / 缺省时视为空白名单
     * （即所有商家都不命中灰度，`status='gray'` 的 Skill 一律拒绝）。
     *
     * 与 `agent_skill_def.status='gray'` 联动：
     *   - `gray + merchantId ∈ whitelist`  → 允许
     *   - `gray + merchantId ∉ whitelist`  → 抛 `SKILL_NOT_AVAILABLE`
     *   - `disabled`                       → 一律抛 `SKILL_NOT_AVAILABLE`
     *   - `enabled`                        → 全量可用
     */
    GRAY_MERCHANT_WHITELIST: z.string().default(''),
  })
  .refine((env) => env.NODE_ENV !== 'production' || env.NUMBER_CONSISTENCY_CHECK_ENABLED, {
    path: ['NUMBER_CONSISTENCY_CHECK_ENABLED'],
    message: '生产环境不能关闭数字一致性校验',
  });

export type Env = z.infer<typeof EnvSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (_env) return _env;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('[env] 配置错误：', parsed.error.flatten());
    process.exit(1);
  }
  _env = parsed.data;
  return _env;
}

/**
 * 测试辅助：清空 env 单例缓存，让下一次 {@link getEnv} 重新读取 `process.env`。
 *
 * 仅用于切片 19 E2E：vi.stubEnv 后强制业务模块按新 env 重新初始化（如 MCP URL 切到 mock）。
 * 生产路径绝不调用，否则违背"启动期 fail-fast / 运行期不变"约定。
 *
 * @internal 测试专用；与 setMysqlStoragePoolForTest / resetDispatcherForTest 同性质。
 */
export function resetEnvForTest(): void {
  _env = null;
}
