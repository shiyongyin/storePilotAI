-- ============================================================================
-- Migration 014 — V2 marketing coupon table
-- ============================================================================

CREATE TABLE IF NOT EXISTS marketing_coupon (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  merchant_id VARCHAR(64) NOT NULL,
  store_id VARCHAR(64) NOT NULL,
  coupon_id VARCHAR(64) NOT NULL,
  member_id VARCHAR(64),
  coupon_type VARCHAR(16) NOT NULL,
  amount DECIMAL(18,2),
  discount DECIMAL(8,4),
  threshold_amount DECIMAL(18,2),
  valid_from DATE NOT NULL,
  valid_to DATE NOT NULL,
  status VARCHAR(16) NOT NULL,
  used_at DATETIME(3),
  used_in_order_id VARCHAR(64),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_marketing_coupon_tenant_coupon (merchant_id, store_id, coupon_id),
  KEY idx_marketing_coupon_tenant_member (merchant_id, store_id, member_id),
  KEY idx_marketing_coupon_tenant_status_expiry (merchant_id, store_id, status, valid_to)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

