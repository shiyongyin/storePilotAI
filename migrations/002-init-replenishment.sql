-- ============================================================================
-- Migration 002 — 补货草稿 + 调整审计
-- 切片 03;DraftStatus 7 状态必须与切片 04 shared-contracts/drafts.ts 完全一致。
-- 注:终态(SUBMITTED|EXPIRED|CANCELLED|FAILED)不可流转,DDL 不强约束,
--    切片 13 DraftManager 用 assertDraftTransitAllowed 应用层守门。
-- ============================================================================

-- replenishment_draft — 补货草稿(状态机 + 30 分钟过期 + 5 分钟兜底索引)
CREATE TABLE IF NOT EXISTS replenishment_draft (
  draft_id          VARCHAR(64)  NOT NULL,
  session_id        VARCHAR(64)  NOT NULL,
  merchant_id       VARCHAR(64)  NOT NULL,
  store_id          VARCHAR(64)  NOT NULL,
  user_id           VARCHAR(64)  NOT NULL,
  trace_id          VARCHAR(64)  NOT NULL,
  forecast_days     TINYINT UNSIGNED NOT NULL,
  status            VARCHAR(16)  NOT NULL DEFAULT 'DRAFT'
    COMMENT 'DRAFT|WAIT_CONFIRM|CONFIRMED|SUBMITTED|EXPIRED|CANCELLED|FAILED；后 4 个为终态',
  items             JSON         NOT NULL COMMENT '切片 04 DraftItem[] 全文',
  strategy_version  VARCHAR(64)  NOT NULL,
  submitted_po_no   VARCHAR(64)  NULL  COMMENT 'SUBMITTED 后的 ERP 采购单号',
  expires_at        DATETIME(3)  NOT NULL DEFAULT (NOW(3) + INTERVAL 30 MINUTE)
    COMMENT '30 分钟过期(切片 13 cron + 切片 16 兜底)',
  created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (draft_id),
  KEY idx_draft_session (session_id, status),
  KEY idx_draft_tenant_recent (merchant_id, store_id, user_id, created_at)
    COMMENT '切片 13 findRecentDraft 5 分钟兜底(sessionId 漂移恢复)',
  KEY idx_draft_expires (expires_at)
    COMMENT '切片 13 cron Job 5 分钟扫描过期'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='补货草稿(切片 14 写入 / 切片 13 状态机 / 切片 17 提单)';

-- replenishment_adjustment_log — 调整指令审计
-- 与切片 04 AdjustmentInstruction 1:1 字段对齐。
CREATE TABLE IF NOT EXISTS replenishment_adjustment_log (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  adjustment_id     VARCHAR(64)  NOT NULL,
  draft_id          VARCHAR(64)  NOT NULL,
  user_message      VARCHAR(512) NOT NULL COMMENT '原始用户语句(脱敏前)',
  target_type       VARCHAR(32)  NOT NULL COMMENT 'SKU_ID|SKU_KEYWORD|CATEGORY_CODE|ALL',
  target_value      VARCHAR(256) NOT NULL,
  adjustment_type   VARCHAR(32)  NOT NULL
    COMMENT 'INCREASE_RATE|DECREASE_RATE|INCREASE_QTY|DECREASE_QTY|SET_QTY|EXCLUDE',
  adjustment_rate   DECIMAL(6,4) NULL  COMMENT '-1..5,RATE 类型时填',
  adjustment_qty    INT          NULL  COMMENT '整数,QTY 类型时填',
  reason            VARCHAR(512) NOT NULL,
  applied           TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '0=未应用,1=已应用(切片 15)',
  created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_adjustment_id (adjustment_id),
  KEY idx_draft (draft_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='补货调整审计(切片 15 写入)';
