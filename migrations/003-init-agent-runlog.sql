-- ============================================================================
-- Migration 003 — Agent 运行日志 + Skill 运行日志
-- 切片 03 / 对接切片 04 shared-contracts AgentRunLog/SkillRunLog interface
-- 留存 180 天(env RETENTION_DAYS_RUN_LOG;清理由切片 20 cron 实现)
-- ============================================================================

-- agent_run_log — 全 Agent 请求审计(每次 SSE 一条)
CREATE TABLE IF NOT EXISTS agent_run_log (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  trace_id        VARCHAR(64)  NOT NULL COMMENT '5 层贯穿 traceId',
  session_id      VARCHAR(64)  NOT NULL,
  merchant_id     VARCHAR(64)  NOT NULL,
  store_id        VARCHAR(64)  NOT NULL,
  user_id         VARCHAR(64)  NOT NULL,
  intent          VARCHAR(64)  NOT NULL COMMENT '切片 04 IntentCode;UNKNOWN 表示未识别',
  user_message_len INT          NOT NULL COMMENT '原 user message 长度,不存原文',
  status          VARCHAR(16)  NOT NULL COMMENT 'OK|FAILED|CANCELLED',
  error_code      VARCHAR(64)  NULL  COMMENT '切片 04 ErrorCode',
  duration_ms     INT          NOT NULL,
  started_at      DATETIME(3)  NOT NULL,
  finished_at     DATETIME(3)  NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_runlog_trace (trace_id),
  KEY idx_runlog_tenant_time (merchant_id, store_id, created_at),
  KEY idx_runlog_status_time (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Agent 请求审计(留存 180 天,切片 20 清理)';

-- agent_skill_run_log — Skill 调用审计(每次 Skill workflow 一条)
CREATE TABLE IF NOT EXISTS agent_skill_run_log (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  trace_id        VARCHAR(64)  NOT NULL,
  skill_code      VARCHAR(64)  NOT NULL,
  input_summary   VARCHAR(1024) NOT NULL COMMENT '不存完整 payload,仅摘要',
  output_summary  VARCHAR(1024) NOT NULL,
  status          VARCHAR(16)  NOT NULL COMMENT 'OK|FAILED',
  error_code      VARCHAR(64)  NULL,
  duration_ms     INT          NOT NULL,
  started_at      DATETIME(3)  NOT NULL,
  finished_at     DATETIME(3)  NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_skillrun_trace (trace_id),
  KEY idx_skillrun_skill_time (skill_code, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Skill 调用审计(留存 180 天)';
