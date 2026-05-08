/**
 * 切片 19 — E2E 共享 env fixture（任务卡 §6 §7）
 *
 * 严格按 docs/tanks/19-test-e2e-20-cases.md §7 落地：
 *   - E2E 文件不得直接对 process[dot]env[dot]NAME 赋值（任务卡 §7 MUST NOT §6）；
 *   - env 差异只能用 `vi.stubEnv` / dotenv-cli / `startAgentForTest({ envOverrides })`；
 *   - 本文件提供 23 字段 + 1 安全开关 fixture，调用方在 beforeAll 用 vi.stubEnv 批量注入。
 *
 * 调用约定：
 *   ```ts
 *   import { ensureBaseEnv } from './_helpers/env.js';
 *   beforeAll(() => ensureBaseEnv());
 *   ```
 *
 * @since 切片 19
 */
import { vi } from 'vitest';

/**
 * E2E 默认 MySQL URL（docker-compose.dev 默认 root/rootpw + store_pilot；
 * 不开 dateStrings —— ConfirmManager.parseSessionRow 用 new Date(value) 解析；
 * 字符串形态会被当本地时区解释，与 Date.now() 比较时偏 8h，引发 SUSPEND_EXPIRED 误判）。
 *
 * 可被 MYSQL_TEST_URL 覆盖。
 */
export const E2E_DEFAULT_DATABASE_URL =
  'mysql://root:rootpw@127.0.0.1:3306/store_pilot' +
  '?timezone=Z&supportBigNumbers=true' +
  '&bigNumberStrings=true&charset=utf8mb4&decimalNumbers=true';

/**
 * 23 基础字段 + 1 安全开关 — 与 packages/agent-service/.env.example 对齐。
 *
 * E2E 永远走 in-process MCP mock + FakeAuthPool / 真 MySQL，因此这里的 ERP_MCP_SERVER_URL
 * 是默认占位值；真实值由各 test 自行 `vi.stubEnv('ERP_MCP_SERVER_URL', ...)` 覆盖。
 */
export const E2E_BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '7100',
  DATABASE_URL: E2E_DEFAULT_DATABASE_URL,
  MODEL_PROVIDER: 'openai-compatible',
  MODEL_BASE_URL: 'http://127.0.0.1:65535/llm-not-used',
  MODEL_API_KEY: 'sk-e2e-not-used-1234567890',
  MODEL_NAME: 'e2e-stub-model',
  MODEL_TIMEOUT_MS: '25000',
  MAX_OUTPUT_TOKENS: '4096',
  MAX_TOOL_CALLS_PER_REQUEST: '8',
  ERP_MCP_SERVER_URL: 'http://127.0.0.1:65535/mcp-not-used',
  MCP_TENANT_SHARED_SECRET: 'a'.repeat(32),
  MCP_PROTOCOL_VERSION: '2025-06-18',
  TOOL_CALL_TIMEOUT_MS: '15000',
  DB_POOL_MAX: '20',
  DB_QUEUE_LIMIT: '200',
  AGENT_API_KEY_HASH_SALT: 'e2e-test-pepper-32chars-xxxxxxxx',
  AGENT_API_KEY_PREFIX: 'sk-agent-',
  CORS_ALLOWED_ORIGINS: 'http://localhost:3210,http://localhost:3000',
  USER_MESSAGE_MAX_CHARS: '4000',
  SUSPEND_TTL_MINUTES: '30',
  RETENTION_DAYS_RUN_LOG: '180',
  NUMBER_CONSISTENCY_CHECK_ENABLED: 'true',
};

/**
 * 通过 `vi.stubEnv` 批量注入 E2E 基础 env。
 *
 * 调用方负责在 afterAll 调 `vi.unstubAllEnvs()`（任务卡 §7 MUST NOT §6 + 切片 18 §7 MUST NOT §2）。
 */
export function ensureBaseEnv(overrides: Record<string, string> = {}): void {
  for (const [k, v] of Object.entries({ ...E2E_BASE_ENV, ...overrides })) {
    vi.stubEnv(k, v);
  }
}
