-- ============================================================================
-- Migration 008 — Mastra Workflow Snapshot(状态快照持久化)
-- 切片 03 / 对接切片 07(mastra-mysql-storage Adapter)
-- 用于 Mastra 重启后恢复 workflow 状态。
-- ============================================================================

CREATE TABLE IF NOT EXISTS mastra_workflow_snapshot (
  workflow_name   VARCHAR(128) NOT NULL,
  run_id          VARCHAR(64)  NOT NULL,
  snapshot_json   JSON         NOT NULL COMMENT 'Mastra workflow 状态全量快照',
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (workflow_name, run_id),
  KEY idx_snapshot_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Mastra workflow snapshot(切片 07 storage adapter)';
