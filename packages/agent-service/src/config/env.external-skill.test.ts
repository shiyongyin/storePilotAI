import { afterEach, describe, expect, it, vi } from 'vitest';

import { getEnv, resetEnvForTest } from './env.js';

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

function stubBaseEnv(overrides: Record<string, string | undefined> = {}): void {
  for (const [key, value] of Object.entries({ ...ENV_FIXTURE, ...overrides })) {
    if (value === undefined) {
      vi.unstubAllEnvs();
      throw new Error(`unexpected undefined fixture value for ${key}`);
    }
    vi.stubEnv(key, value);
  }
}

function expectEnvExit(overrides: Record<string, string>): void {
  stubBaseEnv(overrides);
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit');
  }) as never);
  const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    expect(() => getEnv()).toThrow('process.exit');
  } finally {
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

describe('external skills env schema', () => {
  afterEach(() => {
    resetEnvForTest();
    vi.unstubAllEnvs();
  });

  it('defaults external skills to disabled and parses source and merchant allowlists into readonly arrays', () => {
    stubBaseEnv({
      EXTERNAL_SKILLS_ALLOWED_SOURCES: 'Skills.Example.COM,cdn.example.com',
      EXTERNAL_SKILLS_GRAY_MERCHANT_WHITELIST: 'M001,merchant_02',
    });

    const env = getEnv();

    expect(env.EXTERNAL_SKILLS_ENABLED).toBe(false);
    expect(env.EXTERNAL_SKILLS_BASE_DIR).toBe('');
    expect(env.EXTERNAL_SKILLS_MANIFEST_PATH).toBe('');
    expect(env.EXTERNAL_SKILLS_ALLOWED_SOURCES).toEqual([
      'skills.example.com',
      'cdn.example.com',
    ]);
    expect(env.EXTERNAL_SKILLS_GRAY_MERCHANT_WHITELIST).toEqual(['M001', 'merchant_02']);
    expect(env.EXTERNAL_SKILLS_ALLOW_SCRIPTS).toBe(false);
    expect(env.MARKETING_SCOPE_CLASSIFIER_TIMEOUT_MS).toBe(1500);
  });

  it('parses MARKETING_SCOPE_CLASSIFIER_TIMEOUT_MS for live semantic routing smoke tests', () => {
    stubBaseEnv({
      MARKETING_SCOPE_CLASSIFIER_TIMEOUT_MS: '8000',
    });

    expect(getEnv().MARKETING_SCOPE_CLASSIFIER_TIMEOUT_MS).toBe(8000);
  });

  it('requires absolute base dir, absolute manifest path, and non-empty allowed sources when enabled', () => {
    expectEnvExit({
      EXTERNAL_SKILLS_ENABLED: 'true',
      EXTERNAL_SKILLS_BASE_DIR: 'relative/skills',
      EXTERNAL_SKILLS_MANIFEST_PATH: '/tmp/manifest.json',
      EXTERNAL_SKILLS_ALLOWED_SOURCES: 'skills.example.com',
    });
    resetEnvForTest();
    expectEnvExit({
      EXTERNAL_SKILLS_ENABLED: 'true',
      EXTERNAL_SKILLS_BASE_DIR: '/tmp/skills',
      EXTERNAL_SKILLS_MANIFEST_PATH: '',
      EXTERNAL_SKILLS_ALLOWED_SOURCES: 'skills.example.com',
    });
    resetEnvForTest();
    expectEnvExit({
      EXTERNAL_SKILLS_ENABLED: 'true',
      EXTERNAL_SKILLS_BASE_DIR: '/tmp/skills',
      EXTERNAL_SKILLS_MANIFEST_PATH: '/tmp/manifest.json',
      EXTERNAL_SKILLS_ALLOWED_SOURCES: '',
    });
  });

  it('rejects wildcard/url source values and invalid gray merchant ids', () => {
    expectEnvExit({
      EXTERNAL_SKILLS_ALLOWED_SOURCES: '*.example.com',
    });
    resetEnvForTest();
    expectEnvExit({
      EXTERNAL_SKILLS_ALLOWED_SOURCES: 'https://skills.example.com/path',
    });
    resetEnvForTest();
    expectEnvExit({
      EXTERNAL_SKILLS_GRAY_MERCHANT_WHITELIST: 'M001,undefined',
    });
    resetEnvForTest();
    expectEnvExit({
      EXTERNAL_SKILLS_GRAY_MERCHANT_WHITELIST: 'M001,bad merchant',
    });
  });

  it('rejects EXTERNAL_SKILLS_ALLOW_SCRIPTS=true in production at env schema level', () => {
    expectEnvExit({
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.example.com',
      EXTERNAL_SKILLS_ALLOW_SCRIPTS: 'true',
    });
  });
});
