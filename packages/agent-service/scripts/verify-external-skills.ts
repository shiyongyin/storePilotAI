import { z } from 'zod';

import {
  ExternalSkillMerchantIdSchema,
  type Env,
} from '../src/config/env.js';
import {
  EXTERNAL_SKILL_ERROR_CODES,
  loadVerifiedExternalSkills,
} from '../src/mastra/skills/external-skill-loader.js';

const BooleanStringSchema = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const VerifyExternalSkillsEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    EXTERNAL_SKILLS_ENABLED: BooleanStringSchema,
    EXTERNAL_SKILLS_BASE_DIR: z.string().default(''),
    EXTERNAL_SKILLS_MANIFEST_PATH: z.string().default(''),
    EXTERNAL_SKILLS_ALLOWED_SOURCES: z
      .string()
      .default('')
      .transform((raw, ctx) => {
        const items = raw
          .split(',')
          .map((part) => part.trim().toLowerCase())
          .filter(Boolean);
        for (const hostname of items) {
          if (!/^[a-z0-9.-]{1,253}$/.test(hostname) || hostname.includes('*')) {
            ctx.addIssue({ code: 'custom', message: `非法 hostname: ${hostname}` });
          }
        }
        return items as readonly string[];
      }),
    EXTERNAL_SKILLS_GRAY_MERCHANT_WHITELIST: z
      .string()
      .default('')
      .transform((raw, ctx) => {
        const items = raw
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean);
        for (const merchantId of items) {
          const result = ExternalSkillMerchantIdSchema.safeParse(merchantId);
          if (!result.success) {
            ctx.addIssue({ code: 'custom', message: `非法 merchantId: ${merchantId}` });
          }
        }
        return items as readonly string[];
      }),
    EXTERNAL_SKILLS_ALLOW_SCRIPTS: BooleanStringSchema,
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
  .refine((env) => env.NODE_ENV !== 'production' || env.EXTERNAL_SKILLS_ALLOW_SCRIPTS === false, {
    path: ['EXTERNAL_SKILLS_ALLOW_SCRIPTS'],
    message: '生产环境禁止启用 EXTERNAL_SKILLS_ALLOW_SCRIPTS',
  });

function buildLoaderEnv(): Env {
  const parsed = VerifyExternalSkillsEnvSchema.parse(process.env);
  return {
    NODE_ENV: parsed.NODE_ENV,
    PORT: 0,
    DATABASE_URL: 'mysql://verify:verify@localhost:3306/verify',
    MODEL_PROVIDER: 'openai-compatible',
    MODEL_BASE_URL: 'http://127.0.0.1/verify-not-used',
    MODEL_API_KEY: 'verify-not-used',
    MODEL_NAME: 'verify-not-used',
    MODEL_TIMEOUT_MS: 25_000,
    MAX_OUTPUT_TOKENS: 4096,
    MAX_TOOL_CALLS_PER_REQUEST: 8,
    ERP_MCP_SERVER_URL: 'http://127.0.0.1/verify-not-used',
    MCP_TENANT_SHARED_SECRET: 'verify-not-used-32-chars-0000000',
    MCP_PROTOCOL_VERSION: '2025-06-18',
    TOOL_CALL_TIMEOUT_MS: 15_000,
    DB_POOL_MAX: 20,
    DB_QUEUE_LIMIT: 200,
    AGENT_API_KEY_HASH_SALT: 'verify-not-used',
    AGENT_API_KEY_PREFIX: 'sk-agent-',
    CORS_ALLOWED_ORIGINS: 'http://127.0.0.1',
    USER_MESSAGE_MAX_CHARS: 4000,
    SUSPEND_TTL_MINUTES: 30,
    RETENTION_DAYS_RUN_LOG: 180,
    NUMBER_CONSISTENCY_CHECK_ENABLED: true,
    GRAY_MERCHANT_WHITELIST: '',
    EXTERNAL_SKILLS_ENABLED: parsed.EXTERNAL_SKILLS_ENABLED,
    EXTERNAL_SKILLS_BASE_DIR: parsed.EXTERNAL_SKILLS_BASE_DIR,
    EXTERNAL_SKILLS_MANIFEST_PATH: parsed.EXTERNAL_SKILLS_MANIFEST_PATH,
    EXTERNAL_SKILLS_ALLOWED_SOURCES: parsed.EXTERNAL_SKILLS_ALLOWED_SOURCES,
    EXTERNAL_SKILLS_GRAY_MERCHANT_WHITELIST: parsed.EXTERNAL_SKILLS_GRAY_MERCHANT_WHITELIST,
    EXTERNAL_SKILLS_ALLOW_SCRIPTS: parsed.EXTERNAL_SKILLS_ALLOW_SCRIPTS,
  };
}

function redactForOutput(value: string): string {
  const secrets = [
    process.env.EXTERNAL_SKILLS_BASE_DIR,
    process.env.EXTERNAL_SKILLS_MANIFEST_PATH,
    process.env.MODEL_API_KEY,
    process.env.MCP_TENANT_SHARED_SECRET,
  ]
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .sort((a, b) => b.length - a.length);
  let redacted = value;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

function printableError(err: unknown): { code: string; message: string; skillName?: string } {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const message = redactForOutput(rawMessage);
  const knownCode = Object.values(EXTERNAL_SKILL_ERROR_CODES).find((code) =>
    rawMessage.includes(code),
  );
  const skillName = message.includes(':') ? message.split(':').at(-1)?.trim() : undefined;
  return {
    code: knownCode ?? 'EXTERNAL_SKILLS_VERIFY_FAILED',
    message,
    ...(skillName ? { skillName } : {}),
  };
}

async function main(): Promise<void> {
  const env = buildLoaderEnv();
  if (!env.EXTERNAL_SKILLS_ENABLED) {
    console.info('[verify-external-skills] disabled');
    return;
  }

  const skills = await loadVerifiedExternalSkills(env);
  console.info(
    JSON.stringify({
      status: 'ok',
      count: skills.length,
      skills: skills.map((skill) => ({
        name: skill.name,
        version: skill.version,
        skillMdHash12: skill.skillMdSha256.slice(0, 12),
        filesCount: skill.fileHashes.size,
      })),
    }),
  );
}

main().catch((err) => {
  console.error('[verify-external-skills] failed', printableError(err));
  process.exit(1);
});
