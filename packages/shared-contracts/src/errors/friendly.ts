/**
 * 切片 04 — friendlyMessage 中文话术(SSOT)
 * 严格按 docs/任务卡/B-契约.md §T-SCHEMA-03.5.3 + 切片 04 任务卡 §8.7 落地。
 *
 * 强约束:
 *   - 必须中文
 *   - 不得拼接 err.meta / err.stack / SQL / 表名(MUST NOT §6)
 *   - switch 必须覆盖 27 个 ErrorCode + default 兜底
 */
import { BizError } from './index.js';

export function friendlyMessage(err: unknown): string {
  if (!(err instanceof BizError)) {
    return '系统忙，请稍后再试。';
  }
  switch (err.code) {
    // 鉴权 / 协议
    case 'UNAUTHORIZED':
      return '登录已过期或无访问权限，请重新登录。';
    case 'INVALID_REQUEST':
      return '请求格式不正确，请检查后重试。';
    case 'RATE_LIMITED':
      return '请求过于频繁，请稍等几秒再试。';
    case 'TOOL_CALLS_LEAK':
      return '请求被拒绝，请用正常方式提问。';
    // 意图 / Skill
    case 'SKILL_NOT_AVAILABLE':
      return '该功能暂未开放或正在灰度中，请稍后再试。';
    case 'INTENT_LOW_CONFIDENCE':
      return '没太理解您的意思，能再具体说一下吗？';
    case 'MULTI_INTENT_TOO_MANY':
      return '一次说太多事情了，请分开告诉我。';
    // Workflow / HITL
    case 'SUSPEND_NOT_FOUND':
      return '没有等待确认的请求，请重新发起补货。';
    case 'SUSPEND_EXPIRED':
      return '上次确认请求已过期，请重新发起补货。';
    case 'USER_CANCELLED':
      return '已为您取消。如需重新生成请告诉我。';
    case 'RESUME_RACE':
      return '系统已收到您的确认，请勿重复点击。';
    // 业务
    case 'DRAFT_NOT_FOUND':
      return '没有找到对应的补货建议，请先让我生成一份。';
    case 'DRAFT_EXPIRED':
      return '上次的补货建议已过期，请说"再算一份补货"重新生成。';
    case 'DRAFT_ALREADY_SUBMITTED':
      return '这份补货建议已经提交过采购单了。';
    case 'ADJUSTMENT_SKU_UNMATCHED':
      return '没找到您说的商品，请说商品名或编号确认一下。';
    case 'ADJUSTMENT_TOO_MANY':
      return '这次调整次数太多了，请分批告诉我。';
    // 校验
    case 'SCHEMA_FAIL':
    case 'NUMBER_INCONSISTENT':
      return 'AI 服务输出未通过校验，请稍后再试。';
    case 'PROMPT_INJECTION':
      return '请求被拒绝，请用正常方式提问。';
    // 上游
    case 'MCP_UNAVAILABLE':
    case 'MCP_TIMEOUT':
      return 'ERP 系统暂时连不上，请稍后再试。';
    case 'MCP_TOOL_NOT_WHITELISTED':
      return '当前请求需要用到未授权的工具，已为您拦截。';
    case 'MODEL_UNAVAILABLE':
    case 'MODEL_TIMEOUT':
      return 'AI 服务暂时繁忙，请稍后再试。';
    case 'DB_UNAVAILABLE':
      return '数据库暂时不可用，请稍后再试。';
    // 兜底
    case 'NOT_IMPLEMENTED_IN_V1':
      return '该能力 V1 暂不支持，敬请期待。';
    case 'INTERNAL_ERROR':
      return '系统忙，请稍后再试。';
    default:
      return '系统忙，请稍后再试。';
  }
}
