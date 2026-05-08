/**
 * 切片 04 — AgentRunLog / SkillRunLog 类型(SSOT)
 * 仅类型定义,持久化 schema 与字段值约束属切片 03(MySQL DDL 表 agent_run_log / skill_run_log)。
 * 本切片提供编译期类型,以便切片 11/12/14/15/17 写入时获得类型保护。
 */

export interface AgentRunLog {
  /** 全局 trace ID,5 层(SSE / dispatch / Skill / Workflow / MCP)贯穿 */
  traceId: string;
  /** 会话 ID(由切片 09 sessionId 推断) */
  sessionId: string;
  merchantId: string;
  storeId: string;
  userId: string;
  /** 路由后的 Intent;UNKNOWN 表示未识别 */
  intent: string;
  /** 进入路由的原始 user message(脱敏后) */
  userMessageLen: number;
  /** 起止时间(ISO offset datetime) */
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** 终态 */
  status: 'OK' | 'FAILED' | 'CANCELLED';
  /** 失败时的 ErrorCode(参见 errors/index.ts) */
  errorCode?: string;
}

export interface SkillRunLog {
  traceId: string;
  skillCode: string;
  /** 仅记录 input/output 摘要,不写完整 payload */
  inputSummary: string;
  outputSummary: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: 'OK' | 'FAILED';
  errorCode?: string;
}
