import { spawn } from 'node:child_process';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  cleanupExternalSkillFixtures,
  createExternalSkillFixture,
  type ExternalSkillFixture,
} from '../../test-helpers/external-skill-fixture.js';

const fixtures: ExternalSkillFixture[] = [];
const AGENT_SERVICE_ROOT = path.resolve(__dirname, '../../..');
const TSX_CLI = path.resolve(AGENT_SERVICE_ROOT, '../../node_modules/tsx/dist/cli.mjs');

function runVerify(env: Record<string, string | undefined>): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [TSX_CLI, 'scripts/verify-external-skills.ts'],
      {
        cwd: AGENT_SERVICE_ROOT,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

afterAll(async () => {
  await cleanupExternalSkillFixtures(fixtures);
});

describe('scripts/verify-external-skills.ts', () => {
  it('prints disabled and exits 0 when external skills are off', async () => {
    const result = await runVerify({
      EXTERNAL_SKILLS_ENABLED: 'false',
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('disabled');
  });

  it('reuses loader verification and prints only safe skill summaries', async () => {
    const fixture = await createExternalSkillFixture({
      extraFiles: { 'references/ops.md': 'safe reference\n' },
    });
    fixtures.push(fixture);

    const result = await runVerify({
      NODE_ENV: 'test',
      DATABASE_URL: 'mysql://test:test@localhost:3306/test',
      MODEL_BASE_URL: 'http://localhost:7100/llm',
      MODEL_API_KEY: 'sk-test-1234567890',
      MODEL_NAME: 'gpt-test',
      ERP_MCP_SERVER_URL: 'http://localhost:7300/mcp',
      MCP_TENANT_SHARED_SECRET: 'a'.repeat(32),
      AGENT_API_KEY_HASH_SALT: 'salt-abcdef-1234',
      CORS_ALLOWED_ORIGINS: 'http://localhost:3210',
      EXTERNAL_SKILLS_ENABLED: 'true',
      EXTERNAL_SKILLS_BASE_DIR: fixture.baseDir,
      EXTERNAL_SKILLS_MANIFEST_PATH: fixture.manifestPath,
      EXTERNAL_SKILLS_ALLOWED_SOURCES: 'skills.example.com',
      EXTERNAL_SKILLS_GRAY_MERCHANT_WHITELIST: 'M001',
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"status":"ok"');
    expect(result.stdout).toContain('"skillMdHash12"');
    expect(result.stdout).not.toContain(fixture.baseDir);
    expect(result.stdout).not.toContain(fixture.manifestPath);
    expect(result.stdout).not.toContain('sk-test-1234567890');
  });

  it('redacts configured paths and secrets from failure output', async () => {
    const fixture = await createExternalSkillFixture();
    fixtures.push(fixture);
    const missingManifestPath = `${fixture.baseDir}/missing-manifest.json`;

    const result = await runVerify({
      NODE_ENV: 'test',
      EXTERNAL_SKILLS_ENABLED: 'true',
      EXTERNAL_SKILLS_BASE_DIR: fixture.baseDir,
      EXTERNAL_SKILLS_MANIFEST_PATH: missingManifestPath,
      EXTERNAL_SKILLS_ALLOWED_SOURCES: 'skills.example.com',
      EXTERNAL_SKILLS_GRAY_MERCHANT_WHITELIST: 'M001',
      MODEL_API_KEY: 'sk-test-should-not-print',
      MCP_TENANT_SHARED_SECRET: 'b'.repeat(32),
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[verify-external-skills] failed');
    expect(result.stderr).not.toContain(fixture.baseDir);
    expect(result.stderr).not.toContain(missingManifestPath);
    expect(result.stderr).not.toContain('sk-test-should-not-print');
    expect(result.stderr).not.toContain('b'.repeat(32));
  });
});
