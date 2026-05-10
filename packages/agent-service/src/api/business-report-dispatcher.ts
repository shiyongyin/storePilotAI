import dayjs from 'dayjs';
import { BizError, Intent, friendlyMessage } from '@storepilot/shared-contracts';

import { generalQa, requirementCollector, type AgentBundle } from '../mastra/agents/index.js';
import { classifyIntent } from '../mastra/agents/intent-classifier.js';
import {
  INTENT_TO_SKILL,
  assertSkillUsable,
} from '../mastra/agents/skill-registry.js';
import { buildRuntimeContext } from '../mastra/runtime-context.js';
import { generateDailyReportStep } from '../mastra/workflows/business-daily-report.js';
import {
  composeMonthlyReportStep,
  prepareMonthlyInputStep,
  queryInventoryStep,
  queryRankStep,
  queryRatioStep,
  querySalesStep,
} from '../mastra/workflows/business-monthly-report.js';
import {
  computeStep as replenishmentComputeStep,
  persistDraftStep as replenishmentPersistDraftStep,
} from '../mastra/workflows/replenishment-forecast.js';
import {
  applyInstructionStep as adjustmentApplyInstructionStep,
  extractInstructionStep as adjustmentExtractInstructionStep,
  loadActiveDraftStep as adjustmentLoadActiveDraftStep,
  persistAdjustmentStep as adjustmentPersistAdjustmentStep,
} from '../mastra/workflows/replenishment-adjustment.js';
import { logger } from '../observability/logger.js';
import { cancelInflight, confirmDraft } from '../safety/confirm-manager.js';
import { findRecentDraft } from '../safety/draft-manager.js';
import type { DispatchArgs, DispatchFn } from './chat-completions.js';

interface ReportWorkflowOutput {
  summaryMarkdown: string;
  cards: Array<{ key: string; value: string | number }>;
  abnormalInsights: string[];
  dataSourceSummary: {
    tools: string[];
    elapsedMs: number;
    missing?: string[];
  };
}

type StepExecutor<T> = {
  execute(args: Record<string, unknown>): Promise<T>;
};

interface MonthlyPreparedInput {
  merchantId: string;
  storeId: string;
  month: string;
  reportPolicy: { maxSummaryChars: number; maxCards: number };
  startDate: string;
  endDate: string;
  prevStartDate: string;
  prevEndDate: string;
}

interface MonthlySalesResult {
  current: unknown;
  previous: unknown;
  previousMissing: boolean;
}

interface MonthlyValueResult {
  value: unknown;
}

/**
 * 11 IntentEnum 完整 dispatcher（V2.1 切片 16 接力收尾）。
 *
 * 严格按 docs/tanks/10-bridge-sse-output-guard.md §8.4 + §8.4.1 + docs/tanks/16-safety-confirm-manager-hitl.md
 * §6 / §7 MUST DO §9-§11 落地。
 *
 * 三层解耦（任务卡 16 §7 MUST NOT §7）：
 *   - 桥接层 → dispatcher → mastra/agent/safety
 *   - 本文件不得直接 import SQL pool / MCPClient；通过 Agent / step.execute / DraftManager / ConfirmManager 间接调用
 *
 * 依赖注入降级：
 *   - ConfirmManagerPool / MastraResolver 在切片 19/20 注入；本切片在依赖未就绪时 friendlyMessage 兜底
 *   - 不让"未注入"的依赖把整个 chat 拉挂
 *
 * 文件名沿用 `business-report-dispatcher`（保留切片 12 测试 + 现有 server.ts import）；
 * 真实承担"11 IntentEnum 完整 switch"角色。
 */
export function createBusinessReportDispatcher(args: {
  now?: () => Date;
  agents?: Pick<AgentBundle, 'generalQa' | 'requirementCollector'>;
} = {}): DispatchFn {
  const now = args.now ?? (() => new Date());
  const activeGeneralQa = args.agents?.generalQa ?? generalQa;
  const activeRequirementCollector = args.agents?.requirementCollector ?? requirementCollector;

  return async (dispatchArgs) => {
    const latestUserMessage = getLatestUserMessage(dispatchArgs.body.messages);
    if (!latestUserMessage) {
      return {
        finalText: '请告诉我您想了解什么经营情况，或说"日报 / 月报 / 补货建议"。',
      };
    }

    const { intent } = await classifyIntent(latestUserMessage);

    try {
      // 切片 21 §8.2 — Skill 灰度白名单网关：在 dispatcher 进入具体 Workflow 前
      // 按 INTENT_TO_SKILL 表查 skillCode，做 disabled / gray 拦截。
      // - 白名单 hit / status='enabled' → 放行；
      // - status='disabled' / 'gray' 且名外 → 抛 BizError(SKILL_NOT_AVAILABLE)
      //   → 由 try/catch 顶层转 friendlyMessage（任务卡 §9 step 2-3）。
      const skillCode = INTENT_TO_SKILL[intent];
      if (skillCode !== undefined) {
        assertSkillUsable(skillCode, dispatchArgs.auth.merchantId);
      }

      if (intent === Intent.BUSINESS_DAILY_REPORT) {
        const output = await executeStep<ReportWorkflowOutput>(generateDailyReportStep, {
          inputData: {
            merchantId: dispatchArgs.auth.merchantId,
            storeId: dispatchArgs.auth.storeId,
            date: inferReportDate(latestUserMessage, now()),
          },
        });
        return { finalText: formatReportOutput(output) };
      }

      if (intent === Intent.BUSINESS_MONTHLY_REPORT) {
        const prepared = await executeStep<MonthlyPreparedInput>(prepareMonthlyInputStep, {
          inputData: {
            merchantId: dispatchArgs.auth.merchantId,
            storeId: dispatchArgs.auth.storeId,
            month: inferReportMonth(latestUserMessage, now()),
          },
        });
        const [sales, ratio, rank, inventory] = await Promise.all([
          executeStep<MonthlySalesResult>(querySalesStep, { inputData: prepared }),
          executeStep<MonthlyValueResult>(queryRatioStep, { inputData: prepared }),
          executeStep<MonthlyValueResult>(queryRankStep, { inputData: prepared }),
          executeStep<MonthlyValueResult>(queryInventoryStep, { inputData: prepared }),
        ]);
        const output = await executeStep<ReportWorkflowOutput>(composeMonthlyReportStep, {
          inputData: {
            'query-sales-summary-monthly': sales,
            'query-category-ratio-monthly': ratio,
            'query-product-rank-monthly': rank,
            'query-inventory-overview-monthly': inventory,
          },
          getInitData: () => prepared,
        });
        return { finalText: formatReportOutput(output) };
      }

      // ----- GENERAL_QA / EXPLAIN_METRIC：generalQa Agent 走 DeepSeek -----
      if (intent === Intent.GENERAL_QA || intent === Intent.EXPLAIN_METRIC) {
        const ctx = buildCtx(dispatchArgs, 'generalQa');
        // mastra 1.0 generate options 期望 RequestContext<unknown>；项目 RuntimeContext<AgentRuntime>
        // 是其类型化别名，运行期等价。用 `as never` 绕开协变限制。
        const r = (await activeGeneralQa.generate(latestUserMessage, {
          requestContext: ctx as never,
        })) as { text?: string };
        return {
          finalText:
            r?.text ?? '我可以帮您查日报 / 月报 / 补货建议；请告诉我具体想了解什么。',
        };
      }

      // ----- COLLECT_REQUIREMENT：requirementCollector 走 DeepSeek，V1 不写表 -----
      if (intent === Intent.COLLECT_REQUIREMENT) {
        const ctx = buildCtx(dispatchArgs);
        const r = (await activeRequirementCollector.generate(latestUserMessage, {
          requestContext: ctx as never,
        })) as { text?: string };
        return { finalText: r?.text ?? '已收到您的需求建议，我会发给运营团队评审。' };
      }

      // ----- CANCEL_REPLENISHMENT_DRAFT：ConfirmManager.cancelInflight 兜底 -----
      if (intent === Intent.CANCEL_REPLENISHMENT_DRAFT) {
        await cancelInflight({
          sessionId: dispatchArgs.sessionId,
          reason: 'USER_CANCEL',
        }).catch((e: unknown) => {
          logger.warn(
            { err: e instanceof Error ? e.message : String(e) },
            '[dispatch] cancelInflight failed; continue with friendly text',
          );
        });
        return { finalText: '已为您取消。如需重新生成补货建议请告诉我。' };
      }

      // ----- CONFIRM_CREATE_PURCHASE_ORDER：边界 5 兜底 + HITL resume -----
      if (intent === Intent.CONFIRM_CREATE_PURCHASE_ORDER) {
        const ctx = buildCtx(dispatchArgs);
        const recent = await findRecentDraft(ctx, 5).catch((e: unknown) => {
          logger.warn(
            { err: e instanceof Error ? e.message : String(e) },
            '[dispatch] findRecentDraft failed; degrade to friendly hint',
          );
          return [];
        });
        if (recent.length === 0) {
          return {
            finalText: friendlyMessage(
              new BizError('DRAFT_NOT_FOUND', '没有找到待确认的补货草稿'),
            ),
          };
        }
        const confirmed = await confirmDraft({
          draftId: recent[0]!.draftId,
          runtimeContext: ctx,
        });
        if (confirmed.kind === 'PREVIEW_FIRST') {
          return { finalText: confirmed.preview };
        }
        return { finalText: formatConfirmResult(confirmed.result) };
      }

      // ----- REPLENISHMENT_PLAN：切片 14 compute → persist workflow -----
      if (intent === Intent.REPLENISHMENT_PLAN) {
        const inputData: { merchantId: string; storeId: string; forecastDays?: number } = {
          merchantId: dispatchArgs.auth.merchantId,
          storeId: dispatchArgs.auth.storeId,
        };
        const forecastDays = inferForecastDays(latestUserMessage);
        if (forecastDays !== undefined) inputData.forecastDays = forecastDays;

        const computed = await executeStep<unknown>(replenishmentComputeStep, { inputData });
        const output = await executeStep<ReportWorkflowOutput>(replenishmentPersistDraftStep, {
          inputData: computed,
          requestContext: buildCtx(dispatchArgs),
        });
        return { finalText: formatReportOutput(output) };
      }

      // ----- ADJUST_REPLENISHMENT_DRAFT：workflow runtime 由切片 15 完整化 -----
      if (intent === Intent.ADJUST_REPLENISHMENT_DRAFT) {
        const ctx = buildCtx(dispatchArgs);
        const loaded = await executeStep<unknown>(adjustmentLoadActiveDraftStep, {
          inputData: {
            sessionId: dispatchArgs.sessionId,
            userMessage: latestUserMessage,
          },
          requestContext: ctx,
        });
        const extracted = await executeStep<unknown>(adjustmentExtractInstructionStep, {
          inputData: loaded,
          requestContext: ctx,
        });
        const applied = await executeStep<unknown>(adjustmentApplyInstructionStep, {
          inputData: extracted,
          requestContext: ctx,
        });
        const output = await executeStep<{ summaryMarkdown: string }>(
          adjustmentPersistAdjustmentStep,
          {
            inputData: applied,
            requestContext: ctx,
          },
        );
        return { finalText: output.summaryMarkdown };
      }

      // ----- MULTI_INTENT：一次说一件事 -----
      if (intent === Intent.MULTI_INTENT) {
        return {
          finalText: friendlyMessage(
            new BizError('MULTI_INTENT_TOO_MANY', '一次说一件事更准确'),
          ),
        };
      }

      // ----- UNKNOWN（兜底）-----
      return {
        finalText: friendlyMessage(
          new BizError('INTENT_LOW_CONFIDENCE', '没太理解您的问题'),
        ),
      };
    } catch (err) {
      logger.warn(
        {
          intent,
          err: err instanceof Error ? err.message : String(err),
          errCode: err instanceof BizError ? err.code : 'INTERNAL_ERROR',
        },
        '[dispatch] case threw; degrading to friendlyMessage',
      );
      if (err instanceof BizError) {
        return { finalText: friendlyMessage(err) };
      }
      return {
        finalText: friendlyMessage(
          new BizError('INTERNAL_ERROR', err instanceof Error ? err.message : String(err)),
        ),
      };
    }
  };
}

/* ============================================================================
 * 辅助函数
 * ========================================================================== */

function buildCtx(args: DispatchArgs, agentId?: string) {
  return buildRuntimeContext({
    traceId: args.traceId,
    sessionId: args.sessionId,
    merchantId: args.auth.merchantId,
    storeId: args.auth.storeId,
    userId: args.auth.userId,
    apiKeyPrefix: args.auth.apiKeyPrefix,
    requestStartedAt: Date.now(),
    ...(agentId === undefined ? {} : { agentId }),
  });
}


async function executeStep<T>(step: unknown, args: Record<string, unknown>): Promise<T> {
  return await (step as StepExecutor<T>).execute(args);
}

function getLatestUserMessage(
  messages: Array<{ role: string; content: string }>,
): string {
  return [...messages].reverse().find((message) => message.role === 'user')?.content.trim() ?? '';
}

function inferReportDate(message: string, now: Date): string {
  const explicit = message.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (explicit) return explicit;
  const base = dayjs(now);
  if (/昨天|昨日/.test(message)) return base.subtract(1, 'day').format('YYYY-MM-DD');
  return base.format('YYYY-MM-DD');
}

function inferReportMonth(message: string, now: Date): string {
  const explicit = message.match(/\d{4}-\d{2}(?!-\d{2})/)?.[0];
  if (explicit) return explicit;
  const base = dayjs(now);
  if (/上月|上个月/.test(message)) return base.subtract(1, 'month').format('YYYY-MM');
  return base.format('YYYY-MM');
}

function inferForecastDays(message: string): number | undefined {
  const raw = message.match(/(\d{1,2})\s*天/)?.[1];
  if (!raw) return undefined;
  const days = Number(raw);
  return Number.isInteger(days) && days >= 1 && days <= 30 ? days : undefined;
}

function formatReportOutput(output: ReportWorkflowOutput): string {
  const sections = [output.summaryMarkdown.trim()];

  if (output.cards.length > 0) {
    sections.push(
      ['## 指标卡片', ...output.cards.map((card) => `- ${card.key}: ${card.value}`)].join('\n'),
    );
  }

  if (output.abnormalInsights.length > 0) {
    sections.push(
      ['## 异常洞察', ...output.abnormalInsights.map((insight) => `- ${insight}`)].join('\n'),
    );
  }

  sections.push(
    [
      '## 数据源摘要',
      `- tools: ${output.dataSourceSummary.tools.join(', ') || 'none'}`,
      `- missing: ${(output.dataSourceSummary.missing ?? []).join(', ') || 'none'}`,
      `- elapsedMs: ${output.dataSourceSummary.elapsedMs}`,
    ].join('\n'),
  );

  return sections.join('\n\n');
}

function formatConfirmResult(result: unknown): string {
  const poNo = findPurchaseOrderNo(result);
  if (poNo) {
    return `## 采购单已创建\n\n采购单号：${poNo}`;
  }
  return '## 采购单已创建\n\n采购单创建流程已完成。';
}

function findPurchaseOrderNo(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.purchaseOrderNo === 'string') return record.purchaseOrderNo;
  if (record.result) return findPurchaseOrderNo(record.result);
  if (record.output) return findPurchaseOrderNo(record.output);
  return null;
}
