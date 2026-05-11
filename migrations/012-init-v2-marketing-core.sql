-- ============================================================================
-- Migration 012 — V2 marketing core tables
-- ============================================================================

CREATE TABLE IF NOT EXISTS marketing_member_profile (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  merchant_id VARCHAR(64) NOT NULL,
  store_id VARCHAR(64) NOT NULL,
  member_id VARCHAR(64) NOT NULL,
  member_code VARCHAR(64),
  name_masked VARCHAR(64) NOT NULL,
  phone_masked VARCHAR(32),
  level VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL,
  join_date DATE NOT NULL,
  last_visit_at DATETIME(3),
  total_spent DECIMAL(18,2) NOT NULL DEFAULT 0,
  total_orders INT NOT NULL DEFAULT 0,
  avg_order_value DECIMAL(18,2),
  avg_repurchase_days INT,
  tags_json JSON,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_marketing_member_tenant_member (merchant_id, store_id, member_id),
  KEY idx_marketing_member_tenant_level (merchant_id, store_id, level),
  KEY idx_marketing_member_tenant_status (merchant_id, store_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_member_balance (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  merchant_id VARCHAR(64) NOT NULL,
  store_id VARCHAR(64) NOT NULL,
  member_id VARCHAR(64) NOT NULL,
  points INT NOT NULL DEFAULT 0,
  points_expiring_in_30d INT NOT NULL DEFAULT 0,
  storage_balance DECIMAL(18,2) NOT NULL DEFAULT 0,
  total_recharged DECIMAL(18,2) NOT NULL DEFAULT 0,
  total_consumed DECIMAL(18,2) NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_member_balance_tenant_member (merchant_id, store_id, member_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

