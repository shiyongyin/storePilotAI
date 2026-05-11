export const usDormantPlaybook = {
  usCode: 'US-003',
  title: '沉睡会员召回',
  instructions: [
    '优先调用 query_member_segments，segmentCodes 至少包含 DORMANT_NORMAL、DORMANT_HIGH_VALUE、DORMANT_WITH_STORAGE、DORMANT_WITH_COUPON、COUPON_EXPIRING。',
    '默认过滤 LOW_RESPONSIVE，除非老板明确要求查看低响应会员。',
    '按高价值沉睡、储值沉睡、有券沉睡、普通沉睡分组输出；每组包含脱敏姓名、脱敏手机号、上次到店、沉睡原因、建议动作和可复制话术。',
    '高价值沉睡不默认推荐低价券；优先专属关怀、常购提醒、新品邀约或到店体验。',
    '储值沉睡可以提醒有余额未消费，但不得承诺余额外优惠。',
    '有券沉睡必须由 query_coupon_inventory 或工具结果确认未用券/即将过期券后再引用，不得编造券面额、门槛或数量。',
    '用户要求立即发券、群发或执行触达时，明确说明不能替老板执行，只提供方案和话术。',
  ],
} as const;

export const usRepurchasePlaybook = {
  usCode: 'US-004',
  title: '复购周期提醒',
  instructions: [
    '先调用 query_member_segments，segmentCodes 必须包含 REPURCHASE_DUE；不要把 DORMANT_NORMAL 当作复购提醒主名单。',
    '再对候选会员调用 query_repurchase_cycle；实际工具步数不得超过 US-004 maxStepsBudget。',
    '输出按置信度和到期紧迫度排序：HIGH 且已到期/过期优先，HIGH/MEDIUM 且距上次消费达到平均周期 0.9 倍其次。',
    '每位会员必须包含脱敏顾客、常购商品、平均周期、距上次消费天数、预计到期/已过期、置信度和可复制话术。',
    'confidence=LOW 或 sampleSize < 3 时必须写“样本较小”，只做提醒参考，不做强结论。',
    '“补货”在 US-004 指顾客复购提醒，不是门店采购补货；只提供建议话术，不替老板执行触达。',
  ],
} as const;

export const usHighValuePlaybook = {
  usCode: 'US-005',
  title: '高价值熟客维护',
  instructions: [
    '先调用 query_member_segments，segmentCodes 至少包含 HIGH_VALUE、LOYAL_FREQUENT；默认排除 LOW_RESPONSIVE。',
    '按需调用 query_member_profile、query_member_consumption_history 或 query_campaign_history 至少 1 个，用于补充储值、消费历史或活动响应依据。',
    '输出 Top N 高价值熟客，包含脱敏顾客、价值依据、风险/偏好、维护动作和可复制话术。',
    '高价值沉睡可标为“高价值但近期沉睡”，维护动作仍以关系关怀、专属邀约、新品预览或生日关怀为主。',
    '不得把统一低价券作为默认维护策略；用户要求直接触达、群发或发券时，只提供建议，不替老板执行。',
    '投诉、履约异常、转介绍字段缺失时按未返回处理，不得声称投诉为零或虚构具体数字。',
  ],
} as const;

export const usNewCustomerPlaybook = {
  usCode: 'US-006',
  title: '新客二次到店转化',
  instructions: [
    '先调用 query_member_segments，segmentCodes 至少包含 NEW_FIRST_PURCHASE、NEW_NEED_TWO_VISIT。',
    '再调用 query_member_consumption_history 确认首购时间、首购商品和是否只有 1 次消费；散客小票不得进入会员名单。',
    '按首购后 0-3 天感谢、4-7 天二次到店、8-30 天转化挽回三段输出；超过 30 天不放入新客二转主名单。',
    'MBR_00142 这类新客待二转样本必须展示首购商品、首购日期和“25 天未二次到店”这类来自工具日期的确定性天数。',
    '可以用 query_product_performance 补充首购 SKU 或同品类表现；商品数据缺失时只写“根据首购品类做搭配”，不得编具体 SKU。',
    '只提供感谢提醒、二次到店券建议、搭配商品建议和会员引导话术，不宣称已经触达或发券。',
  ],
} as const;

export const usActivationPlaybook = {
  usCode: 'US-007',
  title: '储值/积分/券激活',
  instructions: [
    '先调用 query_member_segments 和 query_coupon_inventory；segmentCodes 至少覆盖 DORMANT_WITH_STORAGE、DORMANT_WITH_COUPON、COUPON_EXPIRING。',
    '按需调用 query_member_profile 读取 storageBalance.balance、points.pointsExpiringIn30d、couponSummary；这些数字必须作为输出依据。',
    '输出必须分为券快过期、储值未消费、积分即将过期三类；同一会员可出现在多个原因下，但每条原因必须独立说明。',
    '券到期只引用 query_coupon_inventory 返回的 daysToExpire、validTo、threshold、amount、discount，不编券库存或优惠。',
    '预估消费机会只能来自储值余额、券门槛/面额或历史客单价，并在文案中明确标注“预估”。',
    '用户要求直接扣积分、发券或群发时，明确说明不能替老板执行，只提供建议动作和可复制话术。',
  ],
} as const;

export const phase2MemberPlaybooks = {
  usDormantPlaybook,
  usRepurchasePlaybook,
  usHighValuePlaybook,
  usNewCustomerPlaybook,
  usActivationPlaybook,
} as const;
