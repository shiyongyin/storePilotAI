import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import {
  EXTERNAL_SKILLS_MAX_MANIFEST_BYTES,
  EXTERNAL_SKILL_MAX_FILE_BYTES,
  EXTERNAL_SKILL_MAX_FRONTMATTER_BYTES,
  EXTERNAL_SKILL_MAX_SKILL_MD_BYTES,
  EXTERNAL_SKILL_MAX_TOTAL_BYTES,
  type Env,
} from '../../config/env.js';
import { logger } from '../../observability/logger.js';

import {
  ExternalSkillManifestSchema,
  isSafePosixRelativePath,
  type ExternalSkillEntry,
  type ExternalSkillFile,
} from './external-skill-manifest.js';

export interface VerifiedExternalSkill {
  name: string;
  relativePath: string;
  absolutePath: string;
  version: string;
  skillMdSha256: string;
  fileHashes: ReadonlyMap<string, string>;
  allowedAgents: readonly string[];
  effectiveAllowedMerchants: readonly string[];
}

export const EXTERNAL_SKILL_ERROR_CODES = {
  BASE_DIR_WRITABLE: 'EXTERNAL_SKILLS_BASE_DIR_WRITABLE',
  MANIFEST_TOO_LARGE: 'EXTERNAL_SKILLS_MANIFEST_TOO_LARGE',
  NO_EFFECTIVE_MERCHANTS: 'EXTERNAL_SKILL_NO_EFFECTIVE_MERCHANTS',
  FRONTMATTER_MISSING: 'EXTERNAL_SKILL_FRONTMATTER_MISSING',
  SOURCE_URL_INVALID: 'EXTERNAL_SKILL_SOURCE_URL_INVALID',
} as const;

export async function loadVerifiedExternalSkills(env: Env): Promise<readonly VerifiedExternalSkill[]> {
  if (!env.EXTERNAL_SKILLS_ENABLED) return [];

  if (!path.isAbsolute(env.EXTERNAL_SKILLS_BASE_DIR)) {
    throw new Error('EXTERNAL_SKILLS_BASE_DIR must be absolute');
  }
  if (!path.isAbsolute(env.EXTERNAL_SKILLS_MANIFEST_PATH)) {
    throw new Error('EXTERNAL_SKILLS_MANIFEST_PATH must be absolute');
  }

  const baseDirReal = await realpath(env.EXTERNAL_SKILLS_BASE_DIR);
  await assertBaseDirReadOnlyInProduction(env, baseDirReal);

  const manifestStat = await stat(env.EXTERNAL_SKILLS_MANIFEST_PATH);
  if (manifestStat.size > EXTERNAL_SKILLS_MAX_MANIFEST_BYTES) {
    throw new Error(EXTERNAL_SKILL_ERROR_CODES.MANIFEST_TOO_LARGE);
  }
  const manifestRaw = await readFile(env.EXTERNAL_SKILLS_MANIFEST_PATH, 'utf8');
  const manifest = ExternalSkillManifestSchema.parse(JSON.parse(manifestRaw));
  const verified: VerifiedExternalSkill[] = [];

  for (const skill of manifest.skills) {
    if (!skill.enabled) continue;
    assertAllowedSource(skill, env.EXTERNAL_SKILLS_ALLOWED_SOURCES);
    const effectiveAllowedMerchants = intersect(
      skill.allowedMerchants,
      env.EXTERNAL_SKILLS_GRAY_MERCHANT_WHITELIST,
    );
    if (effectiveAllowedMerchants.length === 0) {
      throw new Error(`${EXTERNAL_SKILL_ERROR_CODES.NO_EFFECTIVE_MERCHANTS}: ${skill.name}`);
    }

    const absolutePath = await resolveSkillDir(baseDirReal, skill.path);
    await assertNoSymlinksAndScripts(absolutePath, env.EXTERNAL_SKILLS_ALLOW_SCRIPTS);
    const actualFiles = await collectRegularFiles(absolutePath);
    const fileHashes = await verifyFiles(absolutePath, skill, actualFiles);
    await verifySkillFrontmatter(skill, path.join(absolutePath, 'SKILL.md'));

    verified.push({
      name: skill.name,
      relativePath: skill.path,
      absolutePath,
      version: skill.version,
      skillMdSha256: skill.skillMdSha256,
      fileHashes,
      allowedAgents: skill.allowedAgents,
      effectiveAllowedMerchants,
    });
  }

  for (const skill of verified) {
    logger.info(
      {
        name: skill.name,
        version: skill.version,
        hash: skill.skillMdSha256.slice(0, 12),
        filesCount: skill.fileHashes.size,
      },
      '[startup] external-skills-verified',
    );
  }

  return verified;
}

async function assertBaseDirReadOnlyInProduction(env: Env, baseDirReal: string): Promise<void> {
  if (env.NODE_ENV !== 'production') return;
  const probePath = path.join(baseDirReal, `.storepilot-write-probe-${process.pid}-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(probePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    throw new Error(EXTERNAL_SKILL_ERROR_CODES.BASE_DIR_WRITABLE);
  } catch (err) {
    if (err instanceof Error && err.message === EXTERNAL_SKILL_ERROR_CODES.BASE_DIR_WRITABLE) {
      throw err;
    }
    const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      return;
    }
    throw err;
  } finally {
    await handle?.close();
    await rm(probePath, { force: true });
  }
}

function assertAllowedSource(skill: ExternalSkillEntry, allowlist: readonly string[]): void {
  const url = new URL(skill.sourceUrl);
  const hostname = url.hostname.toLowerCase();
  if (!allowlist.includes(hostname)) {
    throw new Error(`${EXTERNAL_SKILL_ERROR_CODES.SOURCE_URL_INVALID}: ${skill.name}`);
  }
}

async function resolveSkillDir(baseDirReal: string, relativePath: string): Promise<string> {
  if (!isSafePosixRelativePath(relativePath)) {
    throw new Error(`external skill path invalid: ${relativePath}`);
  }
  const absolutePath = path.resolve(baseDirReal, relativePath);
  const skillDirReal = await realpath(absolutePath);
  if (!isPathInside(baseDirReal, skillDirReal)) {
    throw new Error(`external skill path escapes base dir: ${relativePath}`);
  }
  return skillDirReal;
}

async function assertNoSymlinksAndScripts(
  skillDir: string,
  allowScripts: boolean,
  currentRelativePath = '',
): Promise<void> {
  const entries = await readdir(path.join(skillDir, currentRelativePath), { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = toPosixPath(path.join(currentRelativePath, entry.name));
    if (entry.isSymbolicLink()) {
      throw new Error(`external skill symlink forbidden: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      if (!allowScripts && (relativePath === 'scripts' || relativePath.startsWith('scripts/'))) {
        throw new Error('external skill scripts directory forbidden');
      }
      await assertNoSymlinksAndScripts(skillDir, allowScripts, relativePath);
    }
  }
}

async function collectRegularFiles(skillDir: string, currentRelativePath = ''): Promise<string[]> {
  const entries = await readdir(path.join(skillDir, currentRelativePath), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = toPosixPath(path.join(currentRelativePath, entry.name));
    const absolutePath = path.join(skillDir, relativePath);
    const entryStat = await lstat(absolutePath);
    if (entryStat.isSymbolicLink()) {
      throw new Error(`external skill symlink forbidden: ${relativePath}`);
    }
    if (entryStat.isDirectory()) {
      files.push(...(await collectRegularFiles(skillDir, relativePath)));
      continue;
    }
    if (entryStat.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

async function verifyFiles(
  skillDir: string,
  skill: ExternalSkillEntry,
  actualFiles: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const declared = new Map<string, ExternalSkillFile>();
  for (const file of skill.files) declared.set(file.path, file);

  const declaredPaths = [...declared.keys()].sort();
  if (JSON.stringify(declaredPaths) !== JSON.stringify([...actualFiles].sort())) {
    throw new Error(`external skill actual files do not match manifest: ${skill.name}`);
  }

  let totalBytes = 0;
  const hashes = new Map<string, string>();
  for (const filePath of actualFiles) {
    const declaredFile = declared.get(filePath);
    if (!declaredFile) throw new Error(`external skill file missing in manifest: ${filePath}`);
    const absolutePath = path.join(skillDir, filePath);
    const fileStat = await stat(absolutePath);
    totalBytes += fileStat.size;
    if (fileStat.size !== declaredFile.sizeBytes) {
      throw new Error(`external skill file size mismatch: ${filePath}`);
    }
    if (fileStat.size > EXTERNAL_SKILL_MAX_FILE_BYTES) {
      throw new Error(`external skill file too large: ${filePath}`);
    }
    if (filePath === 'SKILL.md' && fileStat.size > EXTERNAL_SKILL_MAX_SKILL_MD_BYTES) {
      throw new Error('external skill SKILL.md too large');
    }
    const content = await readFile(absolutePath);
    const hash = createHash('sha256').update(content).digest('hex');
    if (hash !== declaredFile.sha256) {
      throw new Error(`external skill sha256 mismatch: ${filePath}`);
    }
    hashes.set(filePath, hash);
  }
  if (totalBytes > EXTERNAL_SKILL_MAX_TOTAL_BYTES) {
    throw new Error('external skill total bytes too large');
  }
  if (hashes.get('SKILL.md') !== skill.skillMdSha256) {
    throw new Error('external skill SKILL.md sha256 mismatch');
  }
  return hashes;
}

async function verifySkillFrontmatter(skill: ExternalSkillEntry, skillMdPath: string): Promise<void> {
  const handle = await open(skillMdPath, 'r');
  try {
    const buffer = Buffer.alloc(EXTERNAL_SKILL_MAX_FRONTMATTER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const content = buffer.subarray(0, bytesRead).toString('utf8').replace(/\r\n/g, '\n');
    if (!content.startsWith('---\n')) {
      throw new Error(`${EXTERNAL_SKILL_ERROR_CODES.FRONTMATTER_MISSING}: ${skill.name}`);
    }
    const boundary = content.indexOf('\n---', 4);
    const boundaryEnd = boundary >= 0 ? boundary + '\n---'.length : -1;
    if (boundaryEnd < 0) {
      throw new Error(`${EXTERNAL_SKILL_ERROR_CODES.FRONTMATTER_MISSING}: ${skill.name}`);
    }
    const nextChar = content[boundaryEnd];
    if (nextChar !== undefined && nextChar !== '\n') {
      throw new Error(`${EXTERNAL_SKILL_ERROR_CODES.FRONTMATTER_MISSING}: ${skill.name}`);
    }
    const frontmatterRaw = content.slice(4, boundary);
    const parsed = parseYaml(frontmatterRaw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${EXTERNAL_SKILL_ERROR_CODES.FRONTMATTER_MISSING}: ${skill.name}`);
    }
    const name = (parsed as { name?: unknown }).name;
    if (typeof name !== 'string' || name !== skill.name) {
      throw new Error(`${EXTERNAL_SKILL_ERROR_CODES.FRONTMATTER_MISSING}: ${skill.name}`);
    }
  } finally {
    await handle.close();
  }
}

function intersect(left: readonly string[], right: readonly string[]): readonly string[] {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item));
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}
