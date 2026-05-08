-- ============================================================================
-- Migration 010 — Mastra Workflow Suspend(HITL 挂起载荷持久化)
-- 切片 03 / 对接切片 07(storage)+ 切片 16(ConfirmManager 5 边界)
-- expires_at 索引为 5 分钟清理 Job 性能基础(切片 16 §findExpiredSuspends 依赖)
-- ============================================================================

CREATE TABLE IF NOT EXISTS mastra_workflow_suspend (
  run_id        VARCHAR(64)  NOT NULL,
  step_id       VARCHAR(128) NOT NULL,
  payload_json  JSON         NOT NULL COMMENT 'Mastra suspend(...) 时的完整 payload',
  expires_at    DATETIME(3)  NOT NULL DEFAULT (NOW(3) + INTERVAL 30 MINUTE)
    COMMENT '30 分钟过期,与 SUSPEND_TTL_MINUTES env 一致',
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (run_id, step_id),
  KEY idx_expires (expires_at) COMMENT '切片 16 cron 5 分钟扫描过期 suspend'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Mastra workflow suspend payload(HITL 持久化,切片 07/16)';
