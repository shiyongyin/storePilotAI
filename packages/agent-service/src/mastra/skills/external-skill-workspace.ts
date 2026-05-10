import { LocalSkillSource, Workspace } from '@mastra/core/workspace';

import type { Env } from '../../config/env.js';
import type { VerifiedExternalSkill } from './external-skill-loader.js';

export function createExternalSkillWorkspace(
  env: Env,
  skills: readonly VerifiedExternalSkill[],
): Workspace | undefined {
  if (!env.EXTERNAL_SKILLS_ENABLED || skills.length === 0) return undefined;

  return new Workspace({
    id: 'storepilot-external-skills',
    name: 'StorePilot External Skills',
    skills: ({ requestContext }) => {
      const merchantId = requestContext?.get('merchantId');
      const agentId = requestContext?.get('agentId');
      if (typeof merchantId !== 'string' || merchantId.length === 0) return [];
      if (typeof agentId !== 'string' || agentId.length === 0) return [];
      return skills
        .filter((skill) => skill.allowedAgents.includes(agentId))
        .filter((skill) => skill.effectiveAllowedMerchants.includes(merchantId))
        .map((skill) => skill.relativePath);
    },
    skillSource: new LocalSkillSource({ basePath: env.EXTERNAL_SKILLS_BASE_DIR }),
    bm25: true,
    checkSkillFileMtime: false,
    tools: {
      enabled: false,
    },
  });
}
