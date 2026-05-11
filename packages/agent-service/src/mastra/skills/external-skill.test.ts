import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RequestContext } from '@mastra/core/di';
import { describe, expect, it } from 'vitest';

import {
  EXTERNAL_SKILL_ERROR_CODES,
  loadVerifiedExternalSkills,
} from './external-skill-loader.js';
import { ExternalSkillManifestSchema } from './external-skill-manifest.js';
import { createExternalSkillWorkspace } from './external-skill-workspace.js';

import type { Env } from '../../config/env.js';

const baseEnv: Env = {
  NODE_ENV: 'test',
  PORT: 7100,
  DATABASE_URL: 'mysql://test:test@localhost:3306/test',
  MODEL_PROVIDER: 'openai-compatible',
  MODEL_BASE_URL: 'http://localhost:7100/llm',
  MODEL_API_KEY: 'sk-test-1234567890',
  MODEL_NAME: 'gpt-test',
  MODEL_TIMEOUT_MS: 25_000,
  MAX_OUTPUT_TOKENS: 4096,
  MAX_TOOL_CALLS_PER_REQUEST: 8,
  MARKETING_AGENT_ENABLED: false,
  MARKETING_AGENT_MAX_STEPS: 8,
  MARKETING_AGENT_ENABLED_STORE_WHITELIST: '',
  MARKETING_AGENT_ROLLOUT_PERCENT: 0,
  MARKETING_SCOPE_CLASSIFIER_TIMEOUT_MS: 1500,
  AGENT_TOOL_CALLS_PER_REQUEST_HARD_LIMIT: 8,
  ERP_MCP_SERVER_URL: 'http://localhost:7300/mcp',
  MCP_TENANT_SHARED_SECRET: 'a'.repeat(32),
  MCP_PROTOCOL_VERSION: '2025-06-18',
  TOOL_CALL_TIMEOUT_MS: 15_000,
  DB_POOL_MAX: 20,
  DB_QUEUE_LIMIT: 200,
  AGENT_API_KEY_HASH_SALT: 'salt-abcdef-1234',
  AGENT_API_KEY_PREFIX: 'sk-agent-',
  CORS_ALLOWED_ORIGINS: 'http://localhost:3210',
  USER_MESSAGE_MAX_CHARS: 4000,
  SUSPEND_TTL_MINUTES: 30,
  RETENTION_DAYS_RUN_LOG: 180,
  NUMBER_CONSISTENCY_CHECK_ENABLED: true,
  GRAY_MERCHANT_WHITELIST: '',
  EXTERNAL_SKILLS_ENABLED: true,
  EXTERNAL_SKILLS_BASE_DIR: '',
  EXTERNAL_SKILLS_MANIFEST_PATH: '',
  EXTERNAL_SKILLS_ALLOWED_SOURCES: ['skills.example.com'],
  EXTERNAL_SKILLS_GRAY_MERCHANT_WHITELIST: ['M001'],
  EXTERNAL_SKILLS_ALLOW_SCRIPTS: false,
};

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function buildSkillMd(name = 'inventory-guide', lineEnding = '\n'): string {
  return [
    '---',
    `name: ${name}`,
    'description: Safe low-risk inventory explanation guide',
    '---',
    '',
    'Use this only as low-priority reference.',
    '',
  ].join(lineEnding);
}

async function createSkillFixture(args: {
  name?: string;
  skillMd?: string;
  extraFiles?: Record<string, string>;
  manifestOverrides?: Record<string, unknown>;
  skillOverrides?: Record<string, unknown>;
} = {}) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'storepilot-external-skill-'));
  const baseDir = path.join(tmpDir, 'skills');
  const skillName = args.name ?? 'inventory-guide';
  const skillDir = path.join(baseDir, skillName);
  await mkdir(skillDir, { recursive: true });

  const skillMd = args.skillMd ?? buildSkillMd(skillName);
  await writeFile(path.join(skillDir, 'SKILL.md'), skillMd);

  const files = [
    {
      path: 'SKILL.md',
      sha256: sha256(skillMd),
      sizeBytes: Buffer.byteLength(skillMd),
      role: 'skill',
    },
  ];

  for (const [relativePath, content] of Object.entries(args.extraFiles ?? {})) {
    await mkdir(path.dirname(path.join(skillDir, relativePath)), { recursive: true });
    await writeFile(path.join(skillDir, relativePath), content);
    files.push({
      path: relativePath,
      sha256: sha256(content),
      sizeBytes: Buffer.byteLength(content),
      role: relativePath.startsWith('references/') ? 'reference' : 'asset',
    });
  }

  const manifest = {
    version: 1,
    skills: [
      {
        name: skillName,
        version: '1.0.0',
        sourceUrl: 'https://skills.example.com/storepilot/inventory-guide.tgz',
        skillMdSha256: sha256(skillMd),
        files,
        path: skillName,
        enabled: true,
        riskLevel: 'LOW',
        allowedAgents: ['generalQa'],
        allowedMerchants: ['M001'],
        scriptsPolicy: 'deny',
        ...args.skillOverrides,
      },
    ],
    ...args.manifestOverrides,
  };
  const manifestPath = path.join(tmpDir, 'external-skills.manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const env = {
    ...baseEnv,
    EXTERNAL_SKILLS_BASE_DIR: baseDir,
    EXTERNAL_SKILLS_MANIFEST_PATH: manifestPath,
  };

  return {
    tmpDir,
    baseDir,
    skillDir,
    manifest,
    manifestPath,
    env,
  };
}

async function expectRejectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toThrow(code);
}

describe('external skill manifest schema', () => {
  it('rejects high-risk agents, scripts entries, path traversal, and duplicate skill names', () => {
    const skillMdHash = 'a'.repeat(64);
    const baseSkill = {
      name: 'inventory-guide',
      version: '1.0.0',
      sourceUrl: 'https://skills.example.com/a.tgz',
      skillMdSha256: skillMdHash,
      files: [{ path: 'SKILL.md', sha256: skillMdHash, sizeBytes: 10, role: 'skill' }],
      path: 'inventory-guide',
      enabled: true,
      riskLevel: 'LOW',
      allowedAgents: ['generalQa'],
      allowedMerchants: ['M001'],
      scriptsPolicy: 'deny',
    };

    expect(
      ExternalSkillManifestSchema.safeParse({
        version: 1,
        skills: [{ ...baseSkill, allowedAgents: ['purchase_order_create'] }],
      }).success,
    ).toBe(false);
    expect(
      ExternalSkillManifestSchema.safeParse({
        version: 1,
        skills: [{ ...baseSkill, files: [...baseSkill.files, { path: 'scripts/a.sh', sha256: 'b'.repeat(64), sizeBytes: 1, role: 'asset' }] }],
      }).success,
    ).toBe(false);
    expect(
      ExternalSkillManifestSchema.safeParse({
        version: 1,
        skills: [{ ...baseSkill, path: '../escape' }],
      }).success,
    ).toBe(false);
    expect(
      ExternalSkillManifestSchema.safeParse({
        version: 1,
        skills: [baseSkill, { ...baseSkill }],
      }).success,
    ).toBe(false);
  });

  it('rejects sourceUrl without https or with userinfo/hash', () => {
    const skillMdHash = 'a'.repeat(64);
    const baseSkill = {
      name: 'inventory-guide',
      version: '1.0.0',
      sourceUrl: 'https://skills.example.com/a.tgz',
      skillMdSha256: skillMdHash,
      files: [{ path: 'SKILL.md', sha256: skillMdHash, sizeBytes: 10, role: 'skill' }],
      path: 'inventory-guide',
      enabled: true,
      riskLevel: 'LOW',
      allowedAgents: ['generalQa'],
      allowedMerchants: ['M001'],
      scriptsPolicy: 'deny',
    };

    for (const sourceUrl of [
      'http://skills.example.com/a.tgz',
      'https://user:pass@skills.example.com/a.tgz',
      'https://skills.example.com/a.tgz#hash',
    ]) {
      expect(
        ExternalSkillManifestSchema.safeParse({
          version: 1,
          skills: [{ ...baseSkill, sourceUrl }],
        }).success,
      ).toBe(false);
    }
  });
});

describe('loadVerifiedExternalSkills', () => {
  it('returns empty array when external skills are disabled', async () => {
    const result = await loadVerifiedExternalSkills({
      ...baseEnv,
      EXTERNAL_SKILLS_ENABLED: false,
      EXTERNAL_SKILLS_BASE_DIR: '',
      EXTERNAL_SKILLS_MANIFEST_PATH: '',
      EXTERNAL_SKILLS_ALLOWED_SOURCES: [],
      EXTERNAL_SKILLS_GRAY_MERCHANT_WHITELIST: [],
    });

    expect(result).toEqual([]);
  });

  it('verifies hash, size, all files, source allowlist, and merchant gray intersection', async () => {
    const fixture = await createSkillFixture({
      extraFiles: {
        'references/ops.md': 'Only explain terms from confirmed facts.\n',
        'assets/icon.txt': 'asset',
      },
    });

    try {
      const [skill] = await loadVerifiedExternalSkills(fixture.env);

      expect(skill?.name).toBe('inventory-guide');
      expect(skill?.relativePath).toBe('inventory-guide');
      await expect(realpath(fixture.skillDir)).resolves.toBe(skill?.absolutePath);
      expect(skill?.allowedAgents).toEqual(['generalQa']);
      expect(skill?.effectiveAllowedMerchants).toEqual(['M001']);
      expect(skill?.fileHashes.get('SKILL.md')).toBe(sha256(buildSkillMd()));
      expect(skill?.fileHashes.get('references/ops.md')).toBe(
        sha256('Only explain terms from confirmed facts.\n'),
      );
    } finally {
      await rm(fixture.tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects hash mismatch, unregistered files, symlinks, scripts directory, source drift, and no gray merchants', async () => {
    const mismatch = await createSkillFixture({ skillOverrides: { skillMdSha256: 'b'.repeat(64) } });
    const unregistered = await createSkillFixture();
    const symlinkFixture = await createSkillFixture();
    const scriptsFixture = await createSkillFixture();
    const sourceFixture = await createSkillFixture({
      skillOverrides: { sourceUrl: 'https://evil.example.com/a.tgz' },
    });
    const grayFixture = await createSkillFixture({
      skillOverrides: { allowedMerchants: ['M999'] },
    });
    try {
      await writeFile(path.join(unregistered.skillDir, 'references-extra.md'), 'extra');
      await symlink('/tmp', path.join(symlinkFixture.skillDir, 'escape-link'));
      await mkdir(path.join(scriptsFixture.skillDir, 'scripts'));

      await expectRejectCode(loadVerifiedExternalSkills(mismatch.env), 'sha256');
      await expectRejectCode(loadVerifiedExternalSkills(unregistered.env), 'manifest');
      await expectRejectCode(loadVerifiedExternalSkills(symlinkFixture.env), 'symlink');
      await expectRejectCode(loadVerifiedExternalSkills(scriptsFixture.env), 'scripts');
      await expectRejectCode(
        loadVerifiedExternalSkills(sourceFixture.env),
        EXTERNAL_SKILL_ERROR_CODES.SOURCE_URL_INVALID,
      );
      await expectRejectCode(
        loadVerifiedExternalSkills(grayFixture.env),
        EXTERNAL_SKILL_ERROR_CODES.NO_EFFECTIVE_MERCHANTS,
      );
    } finally {
      await Promise.all(
        [mismatch, unregistered, symlinkFixture, scriptsFixture, sourceFixture, grayFixture].map(
          (fixture) => rm(fixture.tmpDir, { recursive: true, force: true }),
        ),
      );
    }
  });

  it('rejects missing frontmatter name and accepts CRLF frontmatter', async () => {
    const missing = await createSkillFixture({ skillMd: 'No frontmatter\n' });
    const crlf = await createSkillFixture({ skillMd: buildSkillMd('inventory-guide', '\r\n') });
    try {
      await expectRejectCode(
        loadVerifiedExternalSkills(missing.env),
        EXTERNAL_SKILL_ERROR_CODES.FRONTMATTER_MISSING,
      );

      await expect(loadVerifiedExternalSkills(crlf.env)).resolves.toHaveLength(1);
    } finally {
      await Promise.all([
        rm(missing.tmpDir, { recursive: true, force: true }),
        rm(crlf.tmpDir, { recursive: true, force: true }),
      ]);
    }
  });

  it('fails closed in production when base dir is writable', async () => {
    const fixture = await createSkillFixture();
    try {
      await expectRejectCode(
        loadVerifiedExternalSkills({ ...fixture.env, NODE_ENV: 'production' }),
        EXTERNAL_SKILL_ERROR_CODES.BASE_DIR_WRITABLE,
      );
    } finally {
      await rm(fixture.tmpDir, { recursive: true, force: true });
    }
  });
});

describe('createExternalSkillWorkspace', () => {
  it('returns undefined when disabled or no verified skills are present', () => {
    expect(
      createExternalSkillWorkspace(
        { ...baseEnv, EXTERNAL_SKILLS_ENABLED: false },
        [],
      ),
    ).toBeUndefined();
    expect(createExternalSkillWorkspace(baseEnv, [])).toBeUndefined();
  });

  it('gates visible skills by server-side merchantId and agentId and disables workspace tools', async () => {
    const fixture = await createSkillFixture();
    try {
      const skills = await loadVerifiedExternalSkills(fixture.env);
      const workspace = createExternalSkillWorkspace(fixture.env, skills);
      expect(workspace).toBeDefined();
      expect(workspace?.getToolsConfig()).toEqual({ enabled: false });
      expect(workspace?.filesystem).toBeUndefined();
      expect(workspace?.sandbox).toBeUndefined();

      const hitCtx = new RequestContext();
      hitCtx.set('merchantId', 'M001');
      hitCtx.set('agentId', 'generalQa');
      const missCtx = new RequestContext();
      missCtx.set('merchantId', 'M001');
      missCtx.set('agentId', 'purchase_order_create');

      await expect(workspace?.skills?.maybeRefresh({ requestContext: hitCtx })).resolves.toBeUndefined();
      await expect(workspace?.skills?.list()).resolves.toEqual([
        expect.objectContaining({ name: 'inventory-guide', path: 'inventory-guide' }),
      ]);
      await expect(workspace?.skills?.maybeRefresh({ requestContext: missCtx })).resolves.toBeUndefined();
      await expect(workspace?.skills?.list()).resolves.toEqual([]);
    } finally {
      await rm(fixture.tmpDir, { recursive: true, force: true });
    }
  });
});
