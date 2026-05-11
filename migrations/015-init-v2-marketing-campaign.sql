-- ============================================================================
-- Migration 015 — V2 marketing campaign tables
-- ============================================================================

CREATE TABLE IF NOT EXISTS marketing_campaign_record (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  merchant_id VARCHAR(64) NOT NULL,
  store_id VARCHAR(64) NOT NULL,
  campaign_id VARCHAR(64) NOT NULL,
  campaign_name VARCHAR(128) NOT NULL,
  status VARCHAR(16) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  touched_members INT NOT NULL DEFAULT 0,
  converted_members INT NOT NULL DEFAULT 0,
  sales_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
  gross_margin_rate DECIMAL(8,4),
  result_summary VARCHAR(512) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_marketing_campaign_tenant_campaign (merchant_id, store_id, campaign_id),
  KEY idx_marketing_campaign_tenant_time (merchant_id, store_id, start_date, end_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

