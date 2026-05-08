/**
 * 切片 04 — ErrorCode 27 + BizError + 派生(SSOT)
 * 严格按 docs/任务卡/B-契约.md §T-SCHEMA-03.5 落地。
 *
 * 27 项分 6 类:
 *   - 鉴权 / 协议(4):UNAUTHORIZED / INVALID_REQUEST / RATE_LIMITED / TOOL_CALLS_LEAK
 *   - 意图 / Skill(3):SKILL_NOT_AVAILABLE / INTENT_LOW_CONFIDENCE / MULTI_INTENT_TOO_MANY
 *   - Workflow / HITL(4):SUSPEND_NOT_FOUND / SUSPEND_EXPIRED / USER_CANCELLED / RESUME_RACE
 *   - 业务(5):DRAFT_NOT_FOUND / DRAFT_EXPIRED / DRAFT_ALREADY_SUBMITTED / ADJUSTMENT_SKU_UNMATCHED / ADJUSTMENT_TOO_MANY
 *   - 校验(3):SCHEMA_FAIL / NUMBER_INCONSISTENT / PROMPT_INJECTION
 *   - 上游(6):MCP_UNAVAILABLE / MCP_TIMEOUT / MCP_TOOL_NOT_WHITELISTED / MODEL_UNAVAILABLE / MODEL_TIMEOUT / DB_UNAVAILABLE
 *   - 兜底(2):NOT_IMPLEMENTED_IN_V1 / INTERNAL_ERROR
 *
 * 任意下游切片新增/重命名错误码必须先回填本文件(MUST NOT §8 同义错误码)。
 */

export const ErrorCode = {
  // 鉴权 / 协议(4)
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_REQUEST: 'INVALID_REQUEST',
  RATE_LIMITED: 'RATE_LIMITED',
  TOOL_CALLS_LEAK: 'TOOL_CALLS_LEAK',
  // 意图 / Skill(3)
  SKILL_NOT_AVAILABLE: 'SKILL_NOT_AVAILABLE',
  INTENT_LOW_CONFIDENCE: 'INTENT_LOW_CONFIDENCE',
  MULTI_INTENT_TOO_MANY: 'MULTI_INTENT_TOO_MANY',
  // Workflow / HITL(4)
  SUSPEND_NOT_FOUND: 'SUSPEND_NOT_FOUND',
  SUSPEND_EXPIRED: 'SUSPEND_EXPIRED',
  USER_CANCELLED: 'USER_CANCELLED',
  RESUME_RACE: 'RESUME_RACE',
  // 业务(5)
  DRAFT_NOT_FOUND: 'DRAFT_NOT_FOUND',
  DRAFT_EXPIRED: 'DRAFT_EXPIRED',
  DRAFT_ALREADY_SUBMITTED: 'DRAFT_ALREADY_SUBMITTED',
  ADJUSTMENT_SKU_UNMATCHED: 'ADJUSTMENT_SKU_UNMATCHED',
  ADJUSTMENT_TOO_MANY: 'ADJUSTMENT_TOO_MANY',
  // 校验(3)
  SCHEMA_FAIL: 'SCHEMA_FAIL',
  NUMBER_INCONSISTENT: 'NUMBER_INCONSISTENT',
  PROMPT_INJECTION: 'PROMPT_INJECTION',
  // 上游(6)
  MCP_UNAVAILABLE: 'MCP_UNAVAILABLE',
  MCP_TIMEOUT: 'MCP_TIMEOUT',
  MCP_TOOL_NOT_WHITELISTED: 'MCP_TOOL_NOT_WHITELISTED',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  MODEL_TIMEOUT: 'MODEL_TIMEOUT',
  DB_UNAVAILABLE: 'DB_UNAVAILABLE',
  // 兜底(2)
  NOT_IMPLEMENTED_IN_V1: 'NOT_IMPLEMENTED_IN_V1',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface BizErrorCtx {
  traceId?: string;
  cause?: unknown;
  retryable?: boolean;
  httpStatus?: number;
  meta?: Record<string, unknown>;
}

export interface OpenAiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    type: 'invalid_request_error';
  };
}

export class BizError extends Error {
  public readonly code: ErrorCode;
  public readonly retryable: boolean;
  public readonly httpStatus: number;
  public readonly meta: Record<string, unknown>;
  public readonly traceId?: string;

  constructor(code: ErrorCode, message: string, ctx: BizErrorCtx = {}) {
    super(message, { cause: ctx.cause });
    this.name = 'BizError';
    this.code = code;
    this.retryable = ctx.retryable ?? defaultRetryable(code);
    this.httpStatus = ctx.httpStatus ?? defaultHttpStatus(code);
    this.meta = ctx.meta ?? {};
    if (ctx.traceId !== undefined) {
      this.traceId = ctx.traceId;
    }
  }

  toOpenAiError(): OpenAiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        type: 'invalid_request_error',
      },
    };
  }
}

const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'MCP_UNAVAILABLE',
  'MCP_TIMEOUT',
  'MODEL_UNAVAILABLE',
  'MODEL_TIMEOUT',
  'DB_UNAVAILABLE',
  'SCHEMA_FAIL',
  'NUMBER_INCONSISTENT',
]);

export function defaultRetryable(code: ErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

export function defaultHttpStatus(code: ErrorCode): number {
  if (code === 'UNAUTHORIZED') return 401;
  if (code === 'RATE_LIMITED') return 429;
  if (code === 'INVALID_REQUEST' || code === 'INTENT_LOW_CONFIDENCE') return 400;
  if (code.startsWith('MCP_') || code === 'MODEL_UNAVAILABLE' || code === 'DB_UNAVAILABLE') {
    return 503;
  }
  if (code === 'TOOL_CALLS_LEAK' || code === 'PROMPT_INJECTION') return 502;
  return 500;
}
