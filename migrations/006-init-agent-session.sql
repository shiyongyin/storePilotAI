-- ============================================================================
-- Migration 006 — Agent Session(含 5 个 HITL 字段,核心硬约束)
-- 切片 03 / 对接切片 09(sessionId 推断)+ 切片 16(ConfirmManager + resume 锁)
-- 5 HITL 字段:active_run_id / active_run_step / active_run_expires_at /
--             resume_locked_at / active_draft_id
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_session (
  session_id           VARCHAR(64) NOT NULL COMMENT '切片 09 hash 推断;主键',
  api_key_prefix       VARCHAR(32) NOT NULL COMMENT 'sk-agent-xxxx',
  merchant_id          VARCHAR(64) NOT NULL,
  current_store_id     VARCHAR(64) NOT NULL,
  user_id              VARCHAR(64) NOT NULL,
  state                VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE|IDLE|EXPIRED',
  last_intent          VARCHAR(64) NULL  COMMENT '切片 04 IntentCode',
  active_draft_id      VARCHAR(64) NULL  COMMENT 'HITL 字段 1:挂起的草稿 ID',
  active_run_id        VARCHAR(64) NULL  COMMENT 'HITL 字段 2:挂起的 Mastra workflow runId',
  active_run_step      VARCHAR(64) NULL  COMMENT 'HITL 字段 3:挂起的 step id',
  active_run_expires_at DATETIME(3) NULL COMMENT 'HITL 字段 4:suspend payload 过期(30 分钟)',
  resume_locked_at     DATETIME(3) NULL  COMMENT 'HITL 字段 5:resume 排他锁(10s 自动释放)',
  last_message_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (session_id),
  KEY idx_session_state_lastmsg (state, last_message_at),
  KEY idx_session_merchant_store (merchant_id, current_store_id),
  KEY idx_active_run (active_run_id) COMMENT '切片 16 resume 时按 runId 查 session'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Agent 会话(HITL 5 字段不另立表)';
