-- ============================================================================
-- Migration 009 — Mastra Workflow Event(事件流持久化)
-- 切片 03 / 对接切片 07
-- 用于 Mastra workflow 步骤事件追溯。
-- ============================================================================

CREATE TABLE IF NOT EXISTS mastra_workflow_event (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  workflow_name   VARCHAR(128) NOT NULL,
  run_id          VARCHAR(64)  NOT NULL,
  step_id         VARCHAR(128) NOT NULL,
  event_type      VARCHAR(32)  NOT NULL COMMENT 'STEP_START|STEP_END|STEP_FAIL|RUN_START|RUN_END',
  payload_json    JSON         NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_event_run (workflow_name, run_id, created_at),
  KEY idx_event_type_time (event_type, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Mastra workflow event(切片 07 storage adapter)';
