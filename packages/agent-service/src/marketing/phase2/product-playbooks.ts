export const sharedProductPlaybook = {
  title: '商品推荐公共规则',
  instructions: [
    '商品主线统一使用 product_recommend_card，不新增 cardType。',
    '默认先用 query_inventory_status 校验可售库存；OUT_OF_STOCK、availableQty <= 0、PHASE_OUT 不进入普通推荐。',
    '到店搭配和高毛利主推默认不推荐 NEAR_EXPIRY 或 SLOW_MOVING；只有 US-010 清库存/临期场景可以纳入，并必须写毛利、合规和品牌风险。',
    '毛利风险按 R-MKT-RULE-005 输出 HIGH/MEDIUM/LOW；涉及优惠机制时必须说明风险来源。',
    '公共规则只消费已返回的工具结果，不递归取数，不写库存、不改价、不创建采购单。',
  ],
} as const;

export const usCrossSellPlaybook = {
  usCode: 'US-008',
  title: '到店搭配推荐 / 收银加购',
  instructions: [
    '必须围绕这个顾客和当前购物篮做 1-3 个搭配建议，不做全店高毛利主推。',
    '有 memberId 时先读取 query_member_profile 和 query_member_consumption_history；无 memberId 时只能基于当前购物篮给通用建议，并明确个性化依据不足。',
    '必须结合 query_product_performance 和 query_inventory_status；普通搭配场景过滤 basket 已有 SKU、OUT_OF_STOCK、availableQty <= 0、NEAR_EXPIRY、SLOW_MOVING、PHASE_OUT。',
    '可用 query_repurchase_cycle 判断常购品是否接近复购窗口；样本低或未返回时只作为缺失处理。',
    '每个建议必须包含推荐 SKU、推荐理由、库存状态、毛利/风险和店员话术；店员话术最多 2 句，不宣称动作已完成。',
  ],
} as const;

export const usHighMarginPlaybook = {
  usCode: 'US-009',
  title: '高毛利商品推广',
  instructions: [
    '必须先结合 query_product_performance 和 query_inventory_status；高毛利主推不是最贵商品排序。',
    '推荐 Top 3-5 个商品，每个必须包含毛利优势、库存状态、适合人群、轻量机制、话术和风险。',
    '普通高毛利推广过滤 OUT_OF_STOCK、availableQty <= 0、NEAR_EXPIRY、SLOW_MOVING、PHASE_OUT；LOW_STOCK 只能提示谨慎。',
    '适合人群优先来自 query_member_segments；没有分群信号时说明分群未返回，不编造人群画像。',
    '可参考 query_campaign_history 的历史活动结果；只建议机制，不承诺盈利，不执行投放或改价。',
  ],
} as const;

export const usSlowMovingPlaybook = {
  usCode: 'US-010',
  title: '滞销/临期库存营销建议',
  instructions: [
    '必须结合 query_inventory_status 和 query_product_performance；可用 query_campaign_history 参考历史清库存效果。',
    '输出清单必须包含商品、库存数量、库龄/临期天数、库存金额、近 30 天销量/滞销原因、建议机制、毛利风险、合规风险和品牌风险。',
    '临期商品必须提示确认仍在可售期、符合门店/监管规则后再执行；过期或不可售商品只能建议下架/报损/联系 ERP 流程。',
    '清库存机制必须用 R-MKT-RULE-005 毛利风险等级；HIGH 风险时不建议大折扣，优先陈列、搭配或内部消化。',
    '不得默认把临期商品推给高价值客户；不得承诺清完库存，不执行价格、库存或活动动作。',
  ],
} as const;

export const phase2ProductPlaybooks = {
  shared: sharedProductPlaybook,
  usCrossSellPlaybook,
  usHighMarginPlaybook,
  usSlowMovingPlaybook,
} as const;
