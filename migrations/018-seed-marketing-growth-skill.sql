-- ============================================================================
-- Migration 018 — V2 marketing_growth_copilot SkillDef seed
-- ============================================================================

SET @agent_api_key_store_role_missing := (
  SELECT COUNT(*) = 0
    FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'agent_api_key'
     AND column_name = 'store_role'
);
SET @ddl := IF(
  @agent_api_key_store_role_missing,
  'ALTER TABLE agent_api_key ADD COLUMN store_role VARCHAR(32) NOT NULL DEFAULT ''BOSS'' AFTER user_id',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

INSERT INTO agent_skill_def (
  skill_code, version, allowed_intents, required_tools, risk_level, status, description
) VALUES
  ('marketing_growth_copilot', '1.0.0',
   JSON_ARRAY('GENERAL_QA'),
   JSON_ARRAY(
     'query_member_profile',
     'query_member_consumption_history',
     'query_member_segments',
     'query_repurchase_cycle',
     'query_product_performance',
     'query_inventory_status',
     'query_pos_summary_by_time',
     'query_campaign_history',
     'query_coupon_inventory'
   ),
   'MEDIUM', 'gray',
   'V2 单店营销增长副驾驶；Internal Agent，只允许 9 个只读 marketing MCP 工具。')
ON DUPLICATE KEY UPDATE
  allowed_intents = VALUES(allowed_intents),
  required_tools  = VALUES(required_tools),
  risk_level      = VALUES(risk_level),
  status          = VALUES(status),
  description     = VALUES(description),
  updated_at      = CURRENT_TIMESTAMP(3);
