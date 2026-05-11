/**
 * 切片 04 — shared-contracts barrel(SSOT 单源出口)
 * 所有消费方必须从 '@storepilot/shared-contracts' 顶层导入,禁止子路径深引用。
 */

// Intent
export { Intent, IntentEnum, IntentRouterOutput } from './intents.js';
export type { IntentCode } from './intents.js';

// Drafts / Adjustments
export {
  AdjustmentInstruction,
  AdjustmentOpType,
  AdjustmentTargetType,
  DraftItem,
  DraftStatus,
  ReplenishmentDraft,
} from './drafts.js';

// Strategy
export {
  EffectiveStrategy,
  MerchantStrategy,
  PlatformStrategy,
  StoreStrategy,
  StrategySchema,
} from './strategies.js';
export type { Strategy } from './strategies.js';

// Skills
export {
  AgentSkillDef,
  BusinessDailyReportInput,
  BusinessDailyReportOutput,
  BusinessMonthlyReportInput,
  BusinessMonthlyReportOutput,
  PurchaseOrderCreateInput,
  PurchaseOrderCreateOutput,
  ReplenishmentAdjustmentInput,
  ReplenishmentAdjustmentOutput,
  ReplenishmentForecastInput,
  ReplenishmentForecastOutput,
  RiskLevel,
} from './skills.js';

// Run Log(类型)
export type { AgentRunLog, SkillRunLog } from './runlog.js';

// HTTP
export { OpenAiRequest } from './http.js';

// MCP ToolContracts(切片 05)— 顶层重新导出关键符号;深路径 '@storepilot/shared-contracts/mcp' 由 package.json exports 提供
export { MARKETING_GROWTH_TOOLS, MarketingToolContracts, TOOL_NAMES, ToolContracts } from './mcp/index.js';
export type { ToolContractName } from './mcp/index.js';

// Errors
export { BizError, ErrorCode, defaultHttpStatus, defaultRetryable } from './errors/index.js';
export type { BizErrorCtx, OpenAiErrorBody } from './errors/index.js';
export { friendlyMessage } from './errors/friendly.js';
