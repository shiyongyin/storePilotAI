-- ============================================================================
-- Migration 013 — V2 marketing POS fact tables
-- ============================================================================

CREATE TABLE IF NOT EXISTS marketing_pos_order (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  merchant_id VARCHAR(64) NOT NULL,
  store_id VARCHAR(64) NOT NULL,
  order_id VARCHAR(64) NOT NULL,
  member_id VARCHAR(64),
  order_time DATETIME(3) NOT NULL,
  sales_amount DECIMAL(18,2) NOT NULL,
  item_count INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_marketing_pos_tenant_order (merchant_id, store_id, order_id),
  KEY idx_marketing_pos_tenant_time (merchant_id, store_id, order_time),
  KEY idx_marketing_pos_tenant_member (merchant_id, store_id, member_id, order_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS marketing_pos_order_item (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  merchant_id VARCHAR(64) NOT NULL,
  store_id VARCHAR(64) NOT NULL,
  order_id VARCHAR(64) NOT NULL,
  sku_id VARCHAR(64) NOT NULL,
  quantity INT NOT NULL,
  sales_amount DECIMAL(18,2) NOT NULL,
  gross_margin_rate DECIMAL(8,4),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_marketing_pos_item_order (merchant_id, store_id, order_id),
  KEY idx_marketing_pos_item_sku (merchant_id, store_id, sku_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

