import { z } from 'zod';

import {
  EXTERNAL_SKILLS_MAX_COUNT,
  EXTERNAL_SKILL_MAX_FILE_BYTES,
  EXTERNAL_SKILL_MAX_SKILL_MD_BYTES,
  ExternalSkillMerchantIdSchema,
} from '../../config/env.js';

const PosixRelativePathSchema = z.string().min(1).superRefine((value, ctx) => {
  if (!isSafePosixRelativePath(value)) {
    ctx.addIssue({
      code: 'custom',
      message: 'path 必须是 POSIX 相对路径，且不能包含 ..、空段、反斜杠、NUL 或控制字符',
    });
  }
});

const ExternalSkillFileSchema = z.object({
  path: PosixRelativePathSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative().max(EXTERNAL_SKILL_MAX_FILE_BYTES),
  role: z.enum(['skill', 'reference', 'asset']),
});

const SourceUrlSchema = z.string().url().superRefine((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'sourceUrl 必须是合法 URL' });
    return;
  }
  if (url.protocol !== 'https:') {
    ctx.addIssue({ code: 'custom', message: 'sourceUrl 必须使用 https' });
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    ctx.addIssue({ code: 'custom', message: 'sourceUrl 禁止 username/password/hash' });
  }
});

const ExternalSkillEntrySchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/),
    version: z.string().min(1),
    sourceUrl: SourceUrlSchema,
    skillMdSha256: z.string().regex(/^[a-f0-9]{64}$/),
    files: z.array(ExternalSkillFileSchema).min(1),
    path: PosixRelativePathSchema,
    enabled: z.boolean().default(false),
    riskLevel: z.enum(['LOW', 'MEDIUM']).default('LOW'),
    allowedAgents: z.array(z.enum(['generalQa'])).default(['generalQa']),
    allowedMerchants: z.array(ExternalSkillMerchantIdSchema).min(1),
    scriptsPolicy: z.enum(['deny']).default('deny'),
  })
  .superRefine((skill, ctx) => {
    const skillFiles = skill.files.filter((f) => f.path === 'SKILL.md');
    if (skillFiles.length !== 1) {
      ctx.addIssue({ code: 'custom', path: ['files'], message: '必须且只能登记一个 SKILL.md' });
      return;
    }
    const skillMd = skillFiles[0]!;
    if (skillMd.role !== 'skill') {
      ctx.addIssue({ code: 'custom', path: ['files'], message: 'SKILL.md role 必须为 skill' });
    }
    if (skillMd.sha256 !== skill.skillMdSha256) {
      ctx.addIssue({
        code: 'custom',
        path: ['skillMdSha256'],
        message: 'skillMdSha256 必须等于 files[SKILL.md].sha256',
      });
    }
    if (skillMd.sizeBytes > EXTERNAL_SKILL_MAX_SKILL_MD_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'SKILL.md 超出大小限制',
      });
    }
    const seen = new Set<string>();
    for (const file of skill.files) {
      if (seen.has(file.path)) {
        ctx.addIssue({ code: 'custom', path: ['files'], message: `重复文件路径: ${file.path}` });
      }
      seen.add(file.path);

      if (file.path === 'SKILL.md') continue;
      if (file.path.startsWith('references/')) {
        if (file.role !== 'reference') {
          ctx.addIssue({
            code: 'custom',
            path: ['files'],
            message: `references 文件 role 必须为 reference: ${file.path}`,
          });
        }
        continue;
      }
      if (file.path.startsWith('assets/')) {
        if (file.role !== 'asset') {
          ctx.addIssue({
            code: 'custom',
            path: ['files'],
            message: `assets 文件 role 必须为 asset: ${file.path}`,
          });
        }
        continue;
      }
      ctx.addIssue({
        code: 'custom',
        path: ['files'],
        message: `只允许登记 SKILL.md、references/**、assets/**: ${file.path}`,
      });
    }
  });

export const ExternalSkillManifestSchema = z
  .object({
    version: z.literal(1),
    skills: z.array(ExternalSkillEntrySchema).max(EXTERNAL_SKILLS_MAX_COUNT),
  })
  .superRefine((manifest, ctx) => {
    const names = new Set<string>();
    for (const skill of manifest.skills) {
      if (names.has(skill.name)) {
        ctx.addIssue({ code: 'custom', path: ['skills'], message: `重复 Skill name: ${skill.name}` });
      }
      names.add(skill.name);
    }
  });

export type ExternalSkillManifest = z.infer<typeof ExternalSkillManifestSchema>;
export type ExternalSkillEntry = ExternalSkillManifest['skills'][number];
export type ExternalSkillFile = ExternalSkillEntry['files'][number];

export function isSafePosixRelativePath(value: string): boolean {
  if (value.length === 0) return false;
  if (value.startsWith('/') || value.startsWith('./')) return false;
  if (value.includes('\\') || value.includes(String.fromCharCode(0))) return false;
  if ([...value].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  })) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}
