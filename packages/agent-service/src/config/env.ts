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

const BooleanStringDefaultFalseSchema = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

export const ExternalSkillMerchantIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .refine((v) => v !== 'undefined' && v !== 'null');

export const EXTERNAL_SKILLS_MAX_COUNT = 20;
export const EXTERNAL_SKILLS_MAX_MANIFEST_BYTES = 64 * 1024;
export const EXTERNAL_SKILL_MAX_FRONTMATTER_BYTES = 8 * 1024;
export const EXTERNAL_SKILL_MAX_SKILL_MD_BYTES = 128 * 1024;
export const EXTERNAL_SKILL_MAX_FILE_BYTES = 512 * 1024;
export const EXTERNAL_SKILL_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

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
    MARKETING_AGENT_ENABLED: BooleanStringDefaultFalseSchema,
    MARKETING_AGENT_MAX_STEPS: z.coerce.number().int().min(1).max(8).default(8),
    MARKETING_AGENT_ENABLED_STORE_WHITELIST: z.string().default(''),
    MARKETING_AGENT_ROLLOUT_PERCENT: z.coerce.number().int().min(0).max(100).default(0),
    // 入口分类器超时硬上限：5000ms。该步骤属于秒级路由判断，>5s 一律视为模型抖动，
    // 应该让上层尽快走 catch 兜底（degraded: true + AMBIGUOUS），而不是把用户卡住。
    // 默认 1500ms；min 200ms 给 dev/local mock 留余地；max 5000ms 是生产防呆。
    MARKETING_SCOPE_CLASSIFIER_TIMEOUT_MS: z.coerce.number().int().min(200).max(5000).default(1500),
    AGENT_TOOL_CALLS_PER_REQUEST_HARD_LIMIT: z.coerce.number().int().min(1).max(20).default(8),
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
    EXTERNAL_SKILLS_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    EXTERNAL_SKILLS_BASE_DIR: z.string().default(''),
    EXTERNAL_SKILLS_MANIFEST_PATH: z.string().default(''),
    EXTERNAL_SKILLS_ALLOWED_SOURCES: z
      .string()
      .default('')
      .transform((s, ctx) => {
        const items = s
          .split(',')
          .map((part) => part.trim().toLowerCase())
          .filter(Boolean);
        for (const hostname of items) {
          if (!/^[a-z0-9.-]{1,253}$/.test(hostname) || hostname.includes('*')) {
            ctx.addIssue({
              code: 'custom',
              message: `非法 hostname: ${hostname}`,
            });
          }
        }
        return items as readonly string[];
      }),
    EXTERNAL_SKILLS_GRAY_MERCHANT_WHITELIST: z
      .string()
      .default('')
      .transform((s, ctx) => {
        const items = s
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean);
        for (const merchantId of items) {
          const result = ExternalSkillMerchantIdSchema.safeParse(merchantId);
          if (!result.success) {
            ctx.addIssue({
              code: 'custom',
              message: `非法 merchantId: ${merchantId}`,
            });
          }
        }
        return items as readonly string[];
      }),
    EXTERNAL_SKILLS_ALLOW_SCRIPTS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .refine((env) => env.NODE_ENV !== 'production' || env.NUMBER_CONSISTENCY_CHECK_ENABLED, {
    path: ['NUMBER_CONSISTENCY_CHECK_ENABLED'],
    message: '生产环境不能关闭数字一致性校验',
  })
  .refine((env) => !env.EXTERNAL_SKILLS_ENABLED || env.EXTERNAL_SKILLS_BASE_DIR.length > 0, {
    path: ['EXTERNAL_SKILLS_BASE_DIR'],
    message: 'EXTERNAL_SKILLS_ENABLED=true 时必须配置 EXTERNAL_SKILLS_BASE_DIR',
  })
  .refine((env) => !env.EXTERNAL_SKILLS_ENABLED || env.EXTERNAL_SKILLS_MANIFEST_PATH.length > 0, {
    path: ['EXTERNAL_SKILLS_MANIFEST_PATH'],
    message: 'EXTERNAL_SKILLS_ENABLED=true 时必须配置 EXTERNAL_SKILLS_MANIFEST_PATH',
  })
  .refine((env) => !env.EXTERNAL_SKILLS_ENABLED || env.EXTERNAL_SKILLS_ALLOWED_SOURCES.length > 0, {
    path: ['EXTERNAL_SKILLS_ALLOWED_SOURCES'],
    message: 'EXTERNAL_SKILLS_ENABLED=true 时必须配置 EXTERNAL_SKILLS_ALLOWED_SOURCES',
  })
  .refine(
    (env) =>
      env.EXTERNAL_SKILLS_BASE_DIR.length === 0 || env.EXTERNAL_SKILLS_BASE_DIR.startsWith('/'),
    {
      path: ['EXTERNAL_SKILLS_BASE_DIR'],
      message: 'EXTERNAL_SKILLS_BASE_DIR 必须是绝对路径',
    },
  )
  .refine(
    (env) =>
      env.EXTERNAL_SKILLS_MANIFEST_PATH.length === 0 ||
      env.EXTERNAL_SKILLS_MANIFEST_PATH.startsWith('/'),
    {
      path: ['EXTERNAL_SKILLS_MANIFEST_PATH'],
      message: 'EXTERNAL_SKILLS_MANIFEST_PATH 必须是绝对路径',
    },
  )
  .refine(
    (env) => env.NODE_ENV !== 'production' || env.EXTERNAL_SKILLS_ALLOW_SCRIPTS === false,
    {
      path: ['EXTERNAL_SKILLS_ALLOW_SCRIPTS'],
      message: '生产环境禁止启用 EXTERNAL_SKILLS_ALLOW_SCRIPTS',
    },
  );

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
