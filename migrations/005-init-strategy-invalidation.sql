-- ============================================================================
-- Migration 005 — 策略缓存失效(切片 11 LRU 清理触发器)
-- 切片 03 / 对接切片 11(safety-strategy-validator)
-- ============================================================================

CREATE TABLE IF NOT EXISTS strategy_invalidation (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  scope         VARCHAR(16)  NOT NULL COMMENT 'PLATFORM|MERCHANT|STORE',
  merchant_id   VARCHAR(64)  NULL  COMMENT 'scope=MERCHANT/STORE 必填',
  store_id      VARCHAR(64)  NULL  COMMENT 'scope=STORE 必填',
  reason        VARCHAR(256) NOT NULL,
  invalidated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  consumed_at   DATETIME(3)  NULL  COMMENT '切片 11 LRU 消费后写入(防重复处理)',
  KEY idx_invalidation_scope_time (scope, invalidated_at),
  KEY idx_invalidation_consumer (consumed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='策略缓存失效信号(切片 11 LRU 重新加载触发)';
