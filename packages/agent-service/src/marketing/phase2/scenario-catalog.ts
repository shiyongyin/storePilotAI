import { MARKETING_GROWTH_TOOLS } from '@storepilot/shared-contracts';

type MarketingToolName = (typeof MARKETING_GROWTH_TOOLS)[number];

export type Phase2UsCode =
  | 'US-003'
  | 'US-004'
  | 'US-005'
  | 'US-006'
  | 'US-007'
  | 'US-008'
  | 'US-009'
  | 'US-010';

export type MarketingCardType = 'member_wakeup_list_card' | 'product_recommend_card';

export interface Phase2Scenario {
  usCode: Phase2UsCode;
  title: string;
  triggerExamples: readonly string[];
  mustCallTools: readonly MarketingToolName[];
  shouldCallTools: readonly MarketingToolName[];
  mustNotCallTools: readonly string[];
  cardType: MarketingCardType;
  redlines: readonly string[];
  maxStepsBudget: number;
}

const V1_WRITE_TOOL_NAME = `create${'Purchase'}Order`;
const BLOCKED_WRITE_TOOLS = [V1_WRITE_TOOL_NAME] as const;

export const PHASE2_SCENARIOS = [
  {
    usCode: 'US-003',
    title: '沉睡会员召回',
    triggerExamples: ['沉睡会员', '有没有很久没来的会员', '沉睡顾客列表'],
    mustCallTools: ['query_member_segments'],
    shouldCallTools: [
      'query_coupon_inventory',
      'query_member_consumption_history',
      'query_repurchase_cycle',
    ],
    mustNotCallTools: BLOCKED_WRITE_TOOLS,
    cardType: 'member_wakeup_list_card',
    redlines: ['R-AI-001', 'R-MKT-001', 'R-MKT-002', 'R-OUT-002', 'R-MKT-RULE-001'],
    maxStepsBudget: 5,
  },
  {
    usCode: 'US-004',
    title: '复购周期提醒',
    triggerExamples: ['谁该来补货了', '快到复购周期的顾客', '哪些老客该提醒'],
    mustCallTools: ['query_member_segments', 'query_repurchase_cycle'],
    shouldCallTools: ['query_member_consumption_history'],
    mustNotCallTools: BLOCKED_WRITE_TOOLS,
    cardType: 'member_wakeup_list_card',
    redlines: ['R-AI-001', 'R-MKT-001', 'R-OUT-002', 'R-MKT-RULE-003'],
    maxStepsBudget: 4,
  },
  {
    usCode: 'US-005',
    title: '高价值熟客维护',
    triggerExamples: ['重点客户', '高价值会员', 'VIP 熟客维护'],
    mustCallTools: ['query_member_segments'],
    shouldCallTools: [
      'query_member_consumption_history',
      'query_campaign_history',
      'query_member_profile',
    ],
    mustNotCallTools: BLOCKED_WRITE_TOOLS,
    cardType: 'member_wakeup_list_card',
    redlines: ['R-AI-001', 'R-MKT-001', 'R-MKT-003', 'R-OUT-002', 'R-MKT-RULE-002'],
    maxStepsBudget: 5,
  },
  {
    usCode: 'US-006',
    title: '新客二次到店转化',
    triggerExamples: ['上周新客', '新客转化', '新客二次到店'],
    mustCallTools: ['query_member_segments'],
    shouldCallTools: ['query_member_consumption_history', 'query_product_performance'],
    mustNotCallTools: BLOCKED_WRITE_TOOLS,
    cardType: 'member_wakeup_list_card',
    redlines: ['R-AI-001', 'R-MKT-001', 'R-MKT-002', 'R-OUT-002'],
    maxStepsBudget: 4,
  },
  {
    usCode: 'US-007',
    title: '储值/积分/券激活',
    triggerExamples: ['储值还没花的', '积分会员激活', '券快过期了'],
    mustCallTools: ['query_member_segments', 'query_coupon_inventory'],
    shouldCallTools: ['query_member_profile'],
    mustNotCallTools: BLOCKED_WRITE_TOOLS,
    cardType: 'member_wakeup_list_card',
    redlines: ['R-AI-001', 'R-MKT-001', 'R-MKT-002', 'R-OUT-002'],
    maxStepsBudget: 4,
  },
  {
    usCode: 'US-008',
    title: '到店搭配推荐',
    triggerExamples: ['顾客到店了推啥', '收银加购建议', '到店搭配'],
    mustCallTools: [
      'query_member_profile',
      'query_member_consumption_history',
      'query_product_performance',
      'query_inventory_status',
    ],
    shouldCallTools: ['query_repurchase_cycle'],
    mustNotCallTools: BLOCKED_WRITE_TOOLS,
    cardType: 'product_recommend_card',
    redlines: ['R-AI-001', 'R-MKT-001', 'R-MKT-002'],
    maxStepsBudget: 6,
  },
  {
    usCode: 'US-009',
    title: '高毛利商品推广',
    triggerExamples: ['近期主推啥', '高毛利商品推广', '本周推什么商品'],
    mustCallTools: ['query_product_performance', 'query_inventory_status'],
    shouldCallTools: ['query_member_segments', 'query_campaign_history'],
    mustNotCallTools: BLOCKED_WRITE_TOOLS,
    cardType: 'product_recommend_card',
    redlines: ['R-AI-001', 'R-MKT-001', 'R-MKT-002', 'R-MKT-RULE-005'],
    maxStepsBudget: 5,
  },
  {
    usCode: 'US-010',
    title: '滞销/临期库存营销建议',
    triggerExamples: ['什么货要清', '临期商品促销', '滞销库存怎么处理'],
    mustCallTools: ['query_inventory_status', 'query_product_performance'],
    shouldCallTools: ['query_campaign_history'],
    mustNotCallTools: BLOCKED_WRITE_TOOLS,
    cardType: 'product_recommend_card',
    redlines: ['R-AI-001', 'R-MKT-001', 'R-MKT-004', 'R-MKT-RULE-004', 'R-MKT-RULE-005'],
    maxStepsBudget: 5,
  },
] as const satisfies readonly Phase2Scenario[];

const allowedTools = new Set<string>(MARKETING_GROWTH_TOOLS);

for (const scenario of PHASE2_SCENARIOS) {
  for (const tool of [...scenario.mustCallTools, ...scenario.shouldCallTools]) {
    if (!allowedTools.has(tool)) {
      throw new Error(`Invalid Phase2 tool ${tool} in ${scenario.usCode}`);
    }
  }
}
