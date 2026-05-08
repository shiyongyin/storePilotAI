-- ============================================================================
-- Migration 004 — API Key 鉴权(argon2id + prefix 候选检索)
-- 切片 03 / 对接切片 09(bridge-auth-session,P95 < 200ms 依赖 prefix 索引)
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_api_key (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  api_key_hash    VARCHAR(256) NOT NULL COMMENT 'argon2id 哈希(切片 09)',
  api_key_prefix  VARCHAR(32)  NOT NULL COMMENT 'sk-agent-xxxx 前缀,候选检索用',
  merchant_id     VARCHAR(64)  NOT NULL,
  store_id        VARCHAR(64)  NULL  COMMENT 'NULL 表示该 Key 不限定门店',
  user_id         VARCHAR(64)  NOT NULL,
  status          VARCHAR(32)  NOT NULL DEFAULT 'ENABLED'
    COMMENT 'ENABLED|DISABLED|REVOKED|ROTATING',
  expires_at      DATETIME(3)  NULL,
  last_used_at    DATETIME(3)  NULL  COMMENT '切片 09 节流更新',
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_api_key_hash (api_key_hash),
  KEY idx_api_key_prefix_status (api_key_prefix, status)
    COMMENT '切片 09 argon2id 候选检索(P95 < 200ms 硬约束)',
  KEY idx_api_key_merchant (merchant_id, store_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='API Key 鉴权(切片 09 / tools/api-key-issuer 写入)';
