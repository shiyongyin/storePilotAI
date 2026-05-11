-- ============================================================================
-- Migration 017 — V2 agent tool call trace
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_tool_call_trace (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  trace_id VARCHAR(64) NOT NULL,
  agent_run_id VARCHAR(64) NOT NULL,
  merchant_id VARCHAR(64) NOT NULL,
  store_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  session_id VARCHAR(128),
  step_index INT NOT NULL,
  tool_call_index INT NOT NULL DEFAULT 0,
  tool_name VARCHAR(64) NOT NULL,
  input_args_json JSON,
  output_summary JSON,
  elapsed_ms INT,
  success BOOLEAN,
  error_code VARCHAR(32),
  occurred_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_trace_step_tool_call (trace_id, step_index, tool_call_index),
  KEY idx_trace_id (trace_id),
  KEY idx_agent_run_id (agent_run_id),
  KEY idx_tenant_time (merchant_id, store_id, occurred_at),
  KEY idx_tool_name_time (tool_name, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

