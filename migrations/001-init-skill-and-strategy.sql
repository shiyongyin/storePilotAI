-- ============================================================================
-- Migration 001 — Skill 元数据 + 三层策略(Platform/Merchant/Store)
-- 切片 03(T-INFRA-03)/ 对接切片 04(shared-contracts AgentSkillDef + StrategySchema)
-- 必须可重入(IF NOT EXISTS)。
-- ============================================================================

-- agent_skill_def — 5 项 Skill 白名单(切片 21 启动期校验依据)
CREATE TABLE IF NOT EXISTS agent_skill_def (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  skill_code    VARCHAR(64)  NOT NULL COMMENT 'lower_snake_case;切片 04 AgentSkillDef.skillCode',
  version       VARCHAR(16)  NOT NULL COMMENT 'SemVer x.y.z',
  allowed_intents JSON       NOT NULL COMMENT 'Array<IntentCode>;切片 04 IntentEnum',
  required_tools JSON        NOT NULL DEFAULT (JSON_ARRAY()) COMMENT 'Array<MCPToolName>',
  risk_level    VARCHAR(16)  NOT NULL COMMENT 'LOW|MEDIUM|HIGH',
  status        VARCHAR(16)  NOT NULL DEFAULT 'enabled' COMMENT 'enabled|disabled|gray',
  description   VARCHAR(512) NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_skill_code_version (skill_code, version),
  KEY idx_skill_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Skill 白名单(切片 06 createMastra + 切片 21 verifySkillDef)';

-- agent_merchant_strategy — 商家级策略(merchant_id 维度)
-- 平台默认策略约定 merchant_id='__PLATFORM_DEFAULT__'(切片 11 三层合并基础层)
CREATE TABLE IF NOT EXISTS agent_merchant_strategy (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  merchant_id   VARCHAR(64)  NOT NULL COMMENT '__PLATFORM_DEFAULT__ 表示平台默认',
  strategy_json JSON         NOT NULL COMMENT '切片 04 StrategySchema 全文',
  version       VARCHAR(64)  NOT NULL,
  status        VARCHAR(16)  NOT NULL DEFAULT 'enabled' COMMENT 'enabled|disabled',
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_merchant_version (merchant_id, version),
  KEY idx_merchant_status (merchant_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='商家级策略(三层合并 Merchant 层)';

-- agent_store_strategy — 门店级策略(merchant_id + store_id 维度)
CREATE TABLE IF NOT EXISTS agent_store_strategy (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  merchant_id   VARCHAR(64)  NOT NULL,
  store_id      VARCHAR(64)  NOT NULL,
  strategy_json JSON         NOT NULL COMMENT '切片 04 StrategySchema 全文',
  version       VARCHAR(64)  NOT NULL,
  status        VARCHAR(16)  NOT NULL DEFAULT 'enabled' COMMENT 'enabled|disabled',
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_store_version (merchant_id, store_id, version),
  KEY idx_store_status (merchant_id, store_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='门店级策略(三层合并 Store 层,优先级最高)';
