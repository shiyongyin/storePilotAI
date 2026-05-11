export type UsCode =
  | 'US-001'
  | 'US-002'
  | 'US-003'
  | 'US-004'
  | 'US-005'
  | 'US-006'
  | 'US-007'
  | 'US-008'
  | 'US-009'
  | 'US-010'
  | 'US-011'
  | 'US-012'
  | 'US-013'
  | 'US-014'
  | 'US-015'
  | 'US-016'
  | 'US-017'
  | 'US-018';

export const US_DISPLAY_NAMES: Record<UsCode, string> = {
  'US-001': '看一眼今天的营销机会',
  'US-002': '查看建议唤醒名单',
  'US-003': '查看沉睡会员名单',
  'US-004': '看哪些老客该来补货了',
  'US-005': '查看高价值熟客',
  'US-006': '查看新客二次到店建议',
  'US-007': '查看储值/积分/券激活清单',
  'US-008': '到店顾客搭配建议',
  'US-009': '看本周建议主推商品',
  'US-010': '看哪些货要清',
  'US-011': '低峰时段拉客建议',
  'US-012': '节令/生日活动建议',
  'US-013': '让我设计一个活动方案',
  'US-014': '检查活动毛利风险',
  'US-015': '生成活动文案',
  'US-016': '生成店员推荐话术',
  'US-017': '查看店员任务清单',
  'US-018': '复盘上次活动',
};

const US_CODES = new Set<string>(Object.keys(US_DISPLAY_NAMES));

export function isUsCode(value: string): value is UsCode {
  return US_CODES.has(value);
}
