/**
 * 切片 06 — 3 个 Agent 的 barrel
 * 下游 createMastra() 通过本 barrel 注入到 Mastra 实例。
 */
import type { Workspace } from '@mastra/core/workspace';

import { generalQa, createGeneralQaAgent } from './general-qa.js';
import { intentRouter } from './intent-router.js';
import { requirementCollector } from './requirement-collector.js';

export { intentRouter } from './intent-router.js';
export { generalQa, createGeneralQaAgent } from './general-qa.js';
export { requirementCollector } from './requirement-collector.js';

export interface AgentBundle {
  intentRouter: typeof intentRouter;
  generalQa: ReturnType<typeof createGeneralQaAgent>;
  requirementCollector: typeof requirementCollector;
}

export function createAgentBundle(
  args: { externalSkillsWorkspace?: Workspace } = {},
): AgentBundle {
  return {
    intentRouter,
    generalQa: createGeneralQaAgent(
      args.externalSkillsWorkspace === undefined
        ? {}
        : { workspace: args.externalSkillsWorkspace },
    ),
    requirementCollector,
  };
}
