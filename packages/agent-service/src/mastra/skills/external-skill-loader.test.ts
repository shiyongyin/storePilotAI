import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { RequestContext } from '@mastra/core/di';
import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  EXTERNAL_SKILLS_MAX_MANIFEST_BYTES,
  resetEnvForTest,
} from '../../config/env.js';
import {
  EXTERNAL_SKILL_ERROR_CODES,
  loadVerifiedExternalSkills,
} from './external-skill-loader.js';
import { ExternalSkillManifestSchema } from './external-skill-manifest.js';
import { createExternalSkillWorkspace } from './external-skill-workspace.js';
import {
  addInternalSymlink,
  buildRedTeamSkillMd,
  buildSkillMd,
  cleanupExternalSkillFixtures,
  copyFixtureScenario,
  createExternalSkillFixture,
  createOversizedFileFixture,
  createOversizedTotalFixture,
  externalSkillBaseEnv,
  sha256,
  type ExternalSkillFixture,
} from '../../test-helpers/external-skill-fixture.js';

const fixtures: ExternalSkillFixture[] = [];

async function track(fixture: Promise<ExternalSkillFixture> | ExternalSkillFixture) {
  const resolved = await fixture;
  fixtures.push(resolved);
  return resolved;
}

async function expectRejectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toThrow(code);
}

function stubEnv(overrides: Record<string, string>): void {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('PORT', '7100');
  vi.stubEnv('DATABASE_URL', 'mysql://test:test@localhost:3306/test');
  vi.stubEnv('MODEL_PROVIDER', 'openai-compatible');
  vi.stubEnv('MODEL_BASE_URL', 'http://localhost:7100/llm');
  vi.stubEnv('MODEL_API_KEY', 'sk-test-1234567890');
  vi.stubEnv('MODEL_NAME', 'gpt-test');
  vi.stubEnv('ERP_MCP_SERVER_URL', 'http://localhost:7300/mcp');
  vi.stubEnv('MCP_TENANT_SHARED_SECRET', 'a'.repeat(32));
  vi.stubEnv('MCP_PROTOCOL_VERSION', '2025-06-18');
  vi.stubEnv('AGENT_API_KEY_HASH_SALT', 'salt-abcdef-1234');
  vi.stubEnv('AGENT_API_KEY_PREFIX', 'sk-agent-');
  vi.stubEnv('CORS_ALLOWED_ORIGINS', 'http://localhost:3210');
  for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
}

afterAll(async () => {
  await cleanupExternalSkillFixtures(fixtures);
  resetEnvForTest();
  vi.unstubAllEnvs();
});

describe('external skill loader security boundaries', () => {
  it('disabled switch returns empty array', async () => {
    await expect(
      loadVerifiedExternalSkills({
        ...externalSkillBaseEnv,
        EXTERNAL_SKILLS_ENABLED: false,
        EXTERNAL_SKILLS_BASE_DIR: '',
        EXTERNAL_SKILLS_MANIFEST_PATH: '',
        EXTERNAL_SKILLS_ALLOWED_SOURCES: [],
        EXTERNAL_SKILLS_GRAY_MERCHANT_WHITELIST: [],
      }),
    ).resolves.toEqual([]);
  });

  it('fixture-backed happy path and CRLF frontmatter parse successfully', async () => {
    const valid = await track(copyFixtureScenario('valid'));
    const crlf = await track(copyFixtureScenario('crlf'));
    await expect(loadVerifiedExternalSkills(valid.env)).resolves.toHaveLength(1);
    await expect(loadVerifiedExternalSkills(crlf.env)).resolves.toHaveLength(1);
  });

  it('manifest JSON schema missing fields and duplicate names fail deterministically', async () => {
    const missing = await track(
      createExternalSkillFixture({
        manifestOverrides: { skills: [{ name: 'missing-fields' }] },
      }),
    );
    const duplicate = await track(
      createExternalSkillFixture({
        manifestOverrides: {
          skills: [
            {
              name: 'inventory-guide',
              version: '1.0.0',
              sourceUrl: 'https://skills.example.com/a.tgz',
              skillMdSha256: 'a'.repeat(64),
              files: [
                { path: 'SKILL.md', sha256: 'a'.repeat(64), sizeBytes: 1, role: 'skill' },
              ],
              path: 'inventory-guide',
              enabled: true,
              riskLevel: 'LOW',
              allowedAgents: ['generalQa'],
              allowedMerchants: ['M001'],
              scriptsPolicy: 'deny',
            },
            {
              name: 'inventory-guide',
              version: '1.0.1',
              sourceUrl: 'https://skills.example.com/b.tgz',
              skillMdSha256: 'b'.repeat(64),
              files: [
                { path: 'SKILL.md', sha256: 'b'.repeat(64), sizeBytes: 1, role: 'skill' },
              ],
              path: 'inventory-guide-b',
              enabled: true,
              riskLevel: 'LOW',
              allowedAgents: ['generalQa'],
              allowedMerchants: ['M001'],
              scriptsPolicy: 'deny',
            },
          ],
        },
      }),
    );

    await expect(loadVerifiedExternalSkills(missing.env)).rejects.toThrow();
    await expect(loadVerifiedExternalSkills(duplicate.env)).rejects.toThrow('重复 Skill name');
  });

  it('sourceUrl rejects non-https, userinfo/hash, and hostname drift', async () => {
    const cases = [
      ['http', { sourceUrl: 'http://skills.example.com/a.tgz' }],
      ['username', { sourceUrl: 'https://user@skills.example.com/a.tgz' }],
      ['password', { sourceUrl: 'https://user:pass@skills.example.com/a.tgz' }],
      ['hash', { sourceUrl: 'https://skills.example.com/a.tgz#hash' }],
      ['allowlist', { sourceUrl: 'https://evil.example.com/a.tgz' }],
    ] as const;

    for (const [name, skillOverrides] of cases) {
      const fixture = await track(
        createExternalSkillFixture({ name: `source-${name}`, skillOverrides }),
      );
      await expect(loadVerifiedExternalSkills(fixture.env)).rejects.toThrow();
    }
  });

  it('env source and merchant schemas trim empty segments and reject unsafe values', async () => {
    resetEnvForTest();
    stubEnv({
      EXTERNAL_SKILLS_ALLOWED_SOURCES: 'Skills.Example.COM,,cdn.example.com,',
      EXTERNAL_SKILLS_GRAY_MERCHANT_WHITELIST: 'M001,,merchant_02,',
    });
    const { getEnv } = await import('../../config/env.js');
    const env = getEnv();
    expect(env.EXTERNAL_SKILLS_ALLOWED_SOURCES).toEqual(['skills.example.com', 'cdn.example.com']);
    expect(env.EXTERNAL_SKILLS_GRAY_MERCHANT_WHITELIST).toEqual(['M001', 'merchant_02']);

    for (const overrides of [
      { EXTERNAL_SKILLS_ALLOWED_SOURCES: '*.example.com' },
      { EXTERNAL_SKILLS_ALLOWED_SOURCES: 'https://skills.example.com/path' },
      { EXTERNAL_SKILLS_ALLOWED_SOURCES: 'skills.example.com/path' },
      { EXTERNAL_SKILLS_GRAY_MERCHANT_WHITELIST: 'undefined' },
      { EXTERNAL_SKILLS_GRAY_MERCHANT_WHITELIST: 'null' },
      { EXTERNAL_SKILLS_GRAY_MERCHANT_WHITELIST: 'bad merchant' },
    ]) {
      resetEnvForTest();
      stubEnv(overrides);
      expect(() => getEnv()).toThrow();
    }
  });

  it('hash mismatch, undeclared files, unsafe file paths, and SKILL.md hash drift fail', async () => {
    const mismatch = await track(
      createExternalSkillFixture({ skillOverrides: { skillMdSha256: 'b'.repeat(64) } }),
    );
    const unregistered = await track(createExternalSkillFixture());
    await writeFile(path.join(unregistered.skillDir, 'references-extra.md'), 'extra');
    const skillMdHashDrift = await track(
      createExternalSkillFixture({
        skillOverrides: {
          skillMdSha256: 'a'.repeat(64),
          files: [{ path: 'SKILL.md', sha256: 'b'.repeat(64), sizeBytes: 1, role: 'skill' }],
        },
      }),
    );

    await expectRejectCode(loadVerifiedExternalSkills(mismatch.env), 'sha256');
    await expectRejectCode(loadVerifiedExternalSkills(unregistered.env), 'manifest');
    await expectRejectCode(loadVerifiedExternalSkills(skillMdHashDrift.env), 'skillMdSha256');

    for (const unsafePath of ['/abs.md', '../escape.md', 'refs\\a.md', 'references//a.md', 'bad\u0001.md']) {
      expect(
        ExternalSkillManifestSchema.safeParse({
          version: 1,
          skills: [
            {
              name: 'unsafe-path',
              version: '1.0.0',
              sourceUrl: 'https://skills.example.com/a.tgz',
              skillMdSha256: 'a'.repeat(64),
              files: [
                { path: unsafePath, sha256: 'a'.repeat(64), sizeBytes: 1, role: 'reference' },
              ],
              path: 'unsafe-path',
              enabled: true,
              riskLevel: 'LOW',
              allowedAgents: ['generalQa'],
              allowedMerchants: ['M001'],
              scriptsPolicy: 'deny',
            },
          ],
        }).success,
      ).toBe(false);
    }
  });

  it('manifest, file, total size, path traversal, missing SKILL.md, and symlinks fail', async () => {
    const manifestTooLarge = await track(createExternalSkillFixture());
    await writeFile(
      manifestTooLarge.manifestPath,
      JSON.stringify({ x: 'a'.repeat(EXTERNAL_SKILLS_MAX_MANIFEST_BYTES) }),
    );
    const fileTooLarge = await track(createOversizedFileFixture());
    const totalTooLarge = await track(createOversizedTotalFixture());
    const pathTraversal = await track(createExternalSkillFixture({ skillOverrides: { path: '../x' } }));
    const missingSkillMd = await track(createExternalSkillFixture());
    await rm(path.join(missingSkillMd.skillDir, 'SKILL.md'));
    const externalSymlink = await track(createExternalSkillFixture());
    await symlink('/tmp', path.join(externalSymlink.skillDir, 'escape-link'));
    const internalSymlink = await track(createExternalSkillFixture());
    await addInternalSymlink(internalSymlink);

    await expectRejectCode(
      loadVerifiedExternalSkills(manifestTooLarge.env),
      EXTERNAL_SKILL_ERROR_CODES.MANIFEST_TOO_LARGE,
    );
    await expect(loadVerifiedExternalSkills(fileTooLarge.env)).rejects.toThrow();
    await expectRejectCode(loadVerifiedExternalSkills(totalTooLarge.env), 'total bytes');
    await expect(loadVerifiedExternalSkills(pathTraversal.env)).rejects.toThrow();
    await expect(loadVerifiedExternalSkills(missingSkillMd.env)).rejects.toThrow();
    await expectRejectCode(loadVerifiedExternalSkills(externalSymlink.env), 'symlink');
    await expectRejectCode(loadVerifiedExternalSkills(internalSymlink.env), 'symlink');
  });

  it('frontmatter, scripts directory, gray miss, HIGH risk, and non-generalQa agent fail', async () => {
    const noFrontmatter = await track(createExternalSkillFixture({ skillMd: 'No frontmatter\n' }));
    const noName = await track(createExternalSkillFixture({ skillMd: '---\ndescription: x\n---\nbody\n' }));
    const mismatchName = await track(createExternalSkillFixture({ skillMd: buildSkillMd('other-name') }));
    const scripts = await track(createExternalSkillFixture());
    await mkdir(path.join(scripts.skillDir, 'scripts'));
    const grayMiss = await track(createExternalSkillFixture({ skillOverrides: { allowedMerchants: ['M999'] } }));
    const highRisk = await track(createExternalSkillFixture({ skillOverrides: { riskLevel: 'HIGH' } }));
    const wrongAgent = await track(
      createExternalSkillFixture({ skillOverrides: { allowedAgents: ['purchase_order_create'] } }),
    );

    await expectRejectCode(
      loadVerifiedExternalSkills(noFrontmatter.env),
      EXTERNAL_SKILL_ERROR_CODES.FRONTMATTER_MISSING,
    );
    await expectRejectCode(loadVerifiedExternalSkills(noName.env), EXTERNAL_SKILL_ERROR_CODES.FRONTMATTER_MISSING);
    await expectRejectCode(
      loadVerifiedExternalSkills(mismatchName.env),
      EXTERNAL_SKILL_ERROR_CODES.FRONTMATTER_MISSING,
    );
    await expectRejectCode(loadVerifiedExternalSkills(scripts.env), 'scripts');
    await expectRejectCode(loadVerifiedExternalSkills(grayMiss.env), EXTERNAL_SKILL_ERROR_CODES.NO_EFFECTIVE_MERCHANTS);
    await expect(loadVerifiedExternalSkills(highRisk.env)).rejects.toThrow();
    await expect(loadVerifiedExternalSkills(wrongAgent.env)).rejects.toThrow();
  });

  it('production script env and writable base dir fail closed', async () => {
    resetEnvForTest();
    stubEnv({
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.example.com',
      EXTERNAL_SKILLS_ALLOW_SCRIPTS: 'true',
    });
    const { getEnv } = await import('../../config/env.js');
    expect(() => getEnv()).toThrow();

    const writable = await track(createExternalSkillFixture());
    await expectRejectCode(
      loadVerifiedExternalSkills({ ...writable.env, NODE_ENV: 'production' }),
      EXTERNAL_SKILL_ERROR_CODES.BASE_DIR_WRITABLE,
    );
  });

  it('resolver returns no skills for missing agent/merchant and null-like strings', async () => {
    const fixture = await track(createExternalSkillFixture());
    const skills = await loadVerifiedExternalSkills(fixture.env);
    const workspace = createExternalSkillWorkspace(fixture.env, skills);
    expect(workspace).toBeDefined();

    for (const values of [
      {},
      { merchantId: 'M001' },
      { agentId: 'generalQa' },
      { merchantId: 'undefined', agentId: 'generalQa' },
      { merchantId: 'null', agentId: 'generalQa' },
    ]) {
      const ctx = new RequestContext();
      for (const [key, value] of Object.entries(values)) ctx.set(key, value);
      await workspace?.skills?.maybeRefresh({ requestContext: ctx });
      await expect(workspace?.skills?.list()).resolves.toEqual([]);
    }
  });

  it('red-team fixture is still only loaded as low-priority reference', async () => {
    const fixture = await track(copyFixtureScenario('red-team'));

    const [skill] = await loadVerifiedExternalSkills(fixture.env);
    expect(skill?.name).toBe('red-team-guide');
    expect(skill?.skillMdSha256).toBe(sha256(buildRedTeamSkillMd('red-team-guide')));
  });
});
