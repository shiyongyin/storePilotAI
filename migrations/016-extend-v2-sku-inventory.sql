-- ============================================================================
-- Migration 016 — V2 SKU / inventory extension placeholders
-- ============================================================================

CREATE TABLE IF NOT EXISTS marketing_sku_profile (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  merchant_id VARCHAR(64) NOT NULL,
  store_id VARCHAR(64) NOT NULL,
  sku_id VARCHAR(64) NOT NULL,
  sku_name VARCHAR(128) NOT NULL,
  category_id VARCHAR(64) NOT NULL,
  category_name VARCHAR(128) NOT NULL,
  cost DECIMAL(18,2),
  margin_rate DECIMAL(8,4),
  shelf_life_days INT,
  lifecycle_stage VARCHAR(32),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_marketing_sku_tenant_sku (merchant_id, store_id, sku_id),
  KEY idx_marketing_sku_tenant_category (merchant_id, store_id, category_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_inventory_snapshot (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  merchant_id VARCHAR(64) NOT NULL,
  store_id VARCHAR(64) NOT NULL,
  sku_id VARCHAR(64) NOT NULL,
  available_qty INT NOT NULL DEFAULT 0,
  stock_age_days INT NOT NULL DEFAULT 0,
  near_expiry_days INT,
  slow_moving_flag BOOLEAN NOT NULL DEFAULT FALSE,
  inventory_status VARCHAR(32) NOT NULL,
  snapshot_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_marketing_inventory_tenant_sku (merchant_id, store_id, sku_id),
  KEY idx_marketing_inventory_tenant_status (merchant_id, store_id, inventory_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

