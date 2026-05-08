-- ============================================================================
-- Migration 011 — agent_skill_def 5 行种子（切片 21 / T-OPS-02 §7.7 / §8.8）
--
-- 落地内容：
--   - 5 个 V1 Skill 注册（business_daily_report / business_monthly_report /
--     replenishment_forecast / replenishment_adjustment / purchase_order_create）。
--   - 风险等级 / 状态：
--     * 4 项 enabled（LOW × 2 + MEDIUM × 2）
--     * 1 项 gray（HIGH，purchase_order_create 灰度白名单生效）
--   - allowed_intents / required_tools 与 createMastra workflows barrel + 7 工具
--     白名单 1:1（任务卡 21 §8.8）。
--
-- 强约束（任务卡 §7 MUST DO §7 + §7 MUST NOT §3）：
--   - skill_code 与 packages/agent-service/src/mastra/workflows/{*.ts}
--     `createWorkflow({ id })` 的 5 个 id 严格相等（启动期 verifySkillDef 守门）。
--   - 必须可重入：用 `INSERT ... ON DUPLICATE KEY UPDATE` 兜底；`uk_skill_code_version`
--     已在 migration 001 落定（skill_code, version）。
--   - 不直接 UPDATE 覆盖历史；后续升 version 由新 INSERT + status 切换完成
--     （runbook 04 §2.4 描述）。
--
-- 列名说明（与 migration 001 schema 对齐）：
--   - 表 agent_skill_def 实际列名为 `version` / `allowed_intents` / `required_tools`，
--     与切片 21 任务卡示例文本中的 `active_version` / `allowed_intents_json` /
--     `required_tools_json` 是同义命名差异；本 SQL 使用真实表列名（§9 step 7
--     `SELECT skill_code, risk_level, status FROM agent_skill_def` 验收不依赖该差异）。
-- ============================================================================

INSERT INTO agent_skill_def (
  skill_code, version, allowed_intents, required_tools, risk_level, status, description
) VALUES
  -- 1. 经营日报（LOW）
  ('business_daily_report', '1.0.0',
   JSON_ARRAY('BUSINESS_DAILY_REPORT', 'EXPLAIN_METRIC'),
   JSON_ARRAY('getStoreReportConfig', 'queryStoreSalesSummary',
              'queryCategorySalesRatio', 'queryProductSalesRank',
              'queryInventoryOverview'),
   'LOW', 'enabled',
   '门店当日经营指标日报；切片 12 落地。'),

  -- 2. 经营月报（LOW）
  ('business_monthly_report', '1.0.0',
   JSON_ARRAY('BUSINESS_MONTHLY_REPORT'),
   JSON_ARRAY('queryStoreSalesSummary', 'queryCategorySalesRatio',
              'queryProductSalesRank', 'queryInventoryOverview'),
   'LOW', 'enabled',
   '门店月度经营报表；切片 12 落地。'),

  -- 3. 补货预测（MEDIUM）
  ('replenishment_forecast', '1.0.0',
   JSON_ARRAY('REPLENISHMENT_PLAN'),
   JSON_ARRAY('queryReplenishmentBaseData'),
   'MEDIUM', 'enabled',
   '基于历史销量 + 库存 + 在途 + lead-time 的加权移动平均补货预测；切片 14 落地。'),

  -- 4. 补货调整（MEDIUM）
  ('replenishment_adjustment', '1.0.0',
   JSON_ARRAY('ADJUST_REPLENISHMENT_DRAFT'),
   JSON_ARRAY(),
   'MEDIUM', 'enabled',
   '老板对补货草稿的指令式调整（按比例 / 按数量 / 单 SKU / 整体）；切片 15 落地。'),

  -- 5. 采购单创建（HIGH，灰度）
  ('purchase_order_create', '1.0.0',
   JSON_ARRAY('CONFIRM_CREATE_PURCHASE_ORDER', 'CANCEL_REPLENISHMENT_DRAFT'),
   JSON_ARRAY('createPurchaseOrder'),
   'HIGH', 'gray',
   '采购单创建（HITL：preview → suspend 等待"确认" → resume → '
   'createPurchaseOrder + markSubmitted）；切片 17 落地。灰度白名单由 '
   'GRAY_MERCHANT_WHITELIST env 控制（切片 21）。')
ON DUPLICATE KEY UPDATE
  allowed_intents = VALUES(allowed_intents),
  required_tools  = VALUES(required_tools),
  risk_level      = VALUES(risk_level),
  status          = VALUES(status),
  description     = VALUES(description),
  updated_at      = CURRENT_TIMESTAMP(3);
