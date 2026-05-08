/**
 * 切片 06 §9.5 — requirementCollector V1 不入库门禁。
 *
 * V1 只把老板诉求转成 markdown 提案并流出；不创建 requirement_inbox，不写 agent_run_log V2 标记。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

// 以本测试文件位置回溯 monorepo 根的 migrations，避免 vitest workspace（root cwd）下解析失败
const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = join(here, '..', '..', '..', '..', '..');

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

async function loadCollector(): Promise<
  typeof import('./requirement-collector.js')
> {
  for (const [key, value] of Object.entries(ENV_FIXTURE)) vi.stubEnv(key, value);
  try {
    return await import('./requirement-collector.js');
  } finally {
    vi.unstubAllEnvs();
  }
}

describe('切片 06 — requirementCollector V1 不入库', () => {
  it('老板需求应转成 markdown 提案，不包含已落库 / 已排期承诺', async () => {
    const { collectRequirementProposal } = await loadCollector();
    const markdown = collectRequirementProposal({
      originalText: '我希望提醒滞销品',
      merchantId: 'M001',
      storeId: 'S001',
    });

    expect(markdown).toContain('## 需求摘要');
    expect(markdown).toContain('## 老板原意');
    expect(markdown).toContain('我希望提醒滞销品');
    expect(markdown).toContain('我会把这个建议发给运营团队评审');
    expect(markdown).not.toMatch(/已落库|已分配|已排期|已创建工单|requirement_inbox/);
  });

  it('V1 migrations 不得创建 requirement_inbox 表', () => {
    const migrationDir = join(monorepoRoot, 'migrations');
    const sql = readdirSync(migrationDir)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => readFileSync(join(migrationDir, name), 'utf8'))
      .join('\n');

    expect(sql).not.toMatch(/\brequirement_inbox\b/i);
  });
});
