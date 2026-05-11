import { MARKETING_GROWTH_TOOLS } from '@storepilot/shared-contracts';

import { PHASE2_SCENARIOS } from './scenario-catalog.js';
import { phase2MemberPlaybooks } from './member-playbooks.js';
import { phase2ProductPlaybooks } from './product-playbooks.js';

export function buildPhase2Instructions(): string {
  const scenarioLines = PHASE2_SCENARIOS.map((scenario) => {
    const must = scenario.mustCallTools.join(', ');
    const should = scenario.shouldCallTools.join(', ') || 'none';
    return `- ${scenario.usCode} ${scenario.title}: mustCall=[${must}], shouldCall=[${should}], cardType=${scenario.cardType}, maxSteps=${scenario.maxStepsBudget}`;
  }).join('\n');
  const memberPlaybookLines = Object.values(phase2MemberPlaybooks)
    .flatMap((playbook) => playbook.instructions.map((item) => `- ${playbook.usCode} ${item}`))
    .join('\n');
  const productPlaybookLines = Object.values(phase2ProductPlaybooks)
    .flatMap((playbook) => {
      const usCode = 'usCode' in playbook ? playbook.usCode : 'SHARED';
      return playbook.instructions.map((item) => `- ${usCode} ${item}`);
    })
    .join('\n');

  return [
    'V2 Phase2 营销场景边界：',
    `- 只允许使用 9 个只读营销 MCP 工具：${MARKETING_GROWTH_TOOLS.join(', ')}。`,
    '- 不得调用 V1 采购写工具；不发券、不群发、不改价、不改库存、不改积分。',
    '- 会员类场景默认过滤散客，只输出脱敏会员标识、原因、建议动作和话术。',
    '- 商品类场景必须过滤缺货商品，并提示毛利、合规或品牌风险。',
    '- 所有数字必须来自工具结果或确定性计算；不要用“大概/预计/约”绕过追溯。',
    '- 老板可见输出不得包含系统内部字段、租户字段或工具调用结构名。',
    '- 阶段 2 必须输出合法 card_data 注释块；会员场景用 member_wakeup_list_card，商品场景用 product_recommend_card。',
    '- 复购周期提醒里，“补货”指顾客常购商品快用完后的复购提醒，不是门店采购流程。',
    '场景目录：',
    scenarioLines,
    '会员场景 playbook：',
    memberPlaybookLines,
    '商品场景 playbook：',
    productPlaybookLines,
  ].join('\n');
}
