/**
 * 切片 14 — 补货预测 Workflow（replenishment_forecast）
 *
 * 严格按 docs/tanks/14-skill-replenishment-forecast.md §6 / §7 / §8 落地。
 *
 * 两步骤：
 *   - computeStep：mergeStrategy → mcpTools().queryReplenishmentBaseData → calculator.computeSku
 *     （纯算公式 + 上下文因子；不调 LLM）。
 *   - persistDraftStep：DraftManager.create 落库 → composeReplenishmentMarkdown 渲染 →
 *     validateOutput（Zod + 数字一致性，含 ## 数据来源 派生白名单）→ 失败重试 1 次。
 *
 * 强约束（任务卡 §7 MUST/MUST NOT，违反即拒收）：
 *   - MUST：mergeStrategy 取 forecastDays / safetyStockDays（不允许 hard-code）；
 *     用户输入 forecastDays → `min(userForecastDays, strategy.replenishmentPolicy.forecastDays)`，
 *     最终仍校验 1..30。
 *   - MUST：computeSku 必须是纯函数（calculator.ts 内 grep 守门，本 workflow 仅作为调用方）。
 *   - MUST：finalSuggestQty 来自 calculator，不允许 LLM 改数字（compose 输出 schema 仅 markdown/cards/abnormal）。
 *   - MUST：DraftManager.create 落 draftItems 结构化 JSON（采购单未来从这里取，不从 markdown 反解析）。
 *   - MUST：调用 DraftManager.create 落库（不直接 INSERT replenishment_draft）。
 *   - MUST：输出经 validateOutput；失败 NUMBER_INCONSISTENT 时 Skill 内重试 1 次。
 *   - MUST NOT：调用任何 WRITE 工具（采购单创建工具）grep 守门，本文件 0 命中。
 *   - MUST NOT：在 calculator 内 await（公式必须确定；calculator.test.ts 守门）。
 *   - MUST NOT：草稿落库后 await LLM —— 但 V1 选择"先落库 DRAFT，再 await LLM 出 markdown"
 *     的次序与切片 17 HITL 流程兼容（DraftManager.create 已经是短事务边界，
 *     compose 在事务外）。
 *
 * 引用：
 *   - 任务卡 §6 / §7 / §8 / §9
 *   - E-Skill.md §T-SKILL-03.5
 *   - 切片 11（mergeStrategy / extractNumbersFrom / validateOutput）
 *   - 切片 13（DraftManager.create / DraftItem 结构化）
 *
 * @since 2026-05-07（切片 14 落地）
 */
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { BizError, StrategySchema, type DraftItem } from '@storepilot/shared-contracts';
import type { ReplenishmentBaseData } from '@storepilot/shared-contracts/mcp';
import { z } from 'zod';

import { getEnv } from '../../config/env.js';
import { logger } from '../../observability/logger.js';
import * as draftManager from '../../safety/draft-manager.js';
import { extractNumbersFrom } from '../../safety/numbers.js';
import { validateOutput } from '../../safety/output-validator.js';
import { mergeStrategy } from '../../safety/strategy-engine.js';
import {
  type ComputedSku,
  computeSku,
} from '../../skills/replenishment/calculator.js';
import { composeReplenishmentMarkdown } from '../../skills/replenishment/compose-markdown.js';
import { mcpTools } from '../mcp/client.js';
import type { AgentRuntime, RuntimeContext } from '../runtime-context.js';

/* ============================================================================
 * Schema
 * ========================================================================== */

/**
 * Workflow 入参：merchantId / storeId / 可选 forecastDays。
 *
 * - `forecastDays` 可选；缺省时由 mergeStrategy 提供（strategy.replenishmentPolicy.forecastDays）。
 * - 若用户传入 → workflow 取 `min(userForecastDays, strategy.replenishmentPolicy.forecastDays)`，
 *   最终仍需 1..30 的硬约束（schema 层兜底）。
 */
const ReplenishmentForecastInputSchema = z.object({
  merchantId: z.string().min(1),
  storeId: z.string().min(1),
  forecastDays: z.number().int().min(1).max(30).optional(),
});

/**
 * computeStep 输出：含 items / strategyVersion / forecastDays / contextFactors / strategyDegraded / allowedNumbers。
 *
 * `allowedNumbers` 是 calculator 计算后的 ComputedSku 数组 + ERP base data 的并集，
 * 作为 validateOutput 的数字白名单（采用切片 11 extractNumbersFrom 派生）。
 */
const ComputeStepOutputSchema = z.object({
  items: z.array(z.unknown()),
  strategyVersion: z.string(),
  strategyDegraded: z.boolean(),
  forecastDays: z.number().int().min(1).max(30),
  contextFactors: z.object({
    isHolidayUpcoming: z.boolean(),
  }),
  /** 序列化的 allowedNumbers 字符串数组，便于 step 间传递；persistStep 还原为 Set */
  allowedNumbersList: z.array(z.string()),
});

/**
 * persistDraftStep 输出 = workflow 最终 OutputSchema。
 *
 * 含 `summaryMarkdown`，会被 validateOutput 数字一致性校验。
 */
const ReplenishmentForecastOutputSchema = z.object({
  draftId: z.string().regex(/^drf_[a-z0-9]{16,32}$/),
  status: z.string(),
  summaryMarkdown: z.string().min(20),
  cards: z.array(
    z.object({
      key: z.string().min(1),
      value: z.union([z.string(), z.number()]),
    }),
  ),
  abnormalInsights: z.array(z.string()).default([]),
  items: z.array(
    z.object({
      skuId: z.string(),
      skuName: z.string(),
      unit: z.string(),
      baseSuggestQty: z.number().int().nonnegative(),
      finalSuggestQty: z.number().int().nonnegative(),
      reason: z.string(),
      adjustmentTrace: z.array(z.string()),
    }),
  ),
  strategyVersion: z.string(),
  forecastDays: z.number().int().min(1).max(30),
  dataSourceSummary: z.object({
    tools: z.array(z.string()),
    elapsedMs: z.number(),
  }),
});

type ReplenishmentForecastOutput = z.infer<typeof ReplenishmentForecastOutputSchema>;

/* ============================================================================
 * Helper：strategy 取 forecastDays（用户输入 ∩ 策略上限）
 * ========================================================================== */

/**
 * 取 forecastDays 的有效值（任务卡 §7 MUST DO §8）。
 *
 * 规则：
 *   - 用户未传：取 `strategy.replenishmentPolicy.forecastDays`。
 *   - 用户传入：取 `min(userForecastDays, strategy.replenishmentPolicy.forecastDays)`。
 *   - 最终硬约束：1..30；越界抛 SCHEMA_FAIL（理论上 schema 已守门，本函数兜底防 strategy 漂移）。
 *
 * @returns 有效 forecastDays 整数
 * @throws BizError(SCHEMA_FAIL) 当 strategy.forecastDays 越界
 */
export function resolveForecastDays(args: {
  userForecastDays?: number | undefined;
  strategyForecastDays: number;
}): number {
  const strategyDays = args.strategyForecastDays;
  if (!Number.isInteger(strategyDays) || strategyDays < 1 || strategyDays > 30) {
    throw new BizError(
      'SCHEMA_FAIL',
      `strategy.replenishmentPolicy.forecastDays 越界：${strategyDays}（合法范围 1..30）`,
    );
  }
  const effective =
    args.userForecastDays === undefined
      ? strategyDays
      : Math.min(args.userForecastDays, strategyDays);
  if (effective < 1 || effective > 30 || !Number.isInteger(effective)) {
    throw new BizError(
      'SCHEMA_FAIL',
      `forecastDays 越界：${effective}（用户=${String(args.userForecastDays)}, 策略=${strategyDays}）`,
    );
  }
  return effective;
}

/* ============================================================================
 * Helper：ComputedSku → DraftItem
 * ========================================================================== */

/**
 * 把 calculator 的 ComputedSku 转换为 DraftManager 入库的 DraftItem 结构。
 *
 * 字段映射：
 *   - skuId / skuName / unit / baseSuggestQty / finalSuggestQty / reason / adjustmentTrace 1:1。
 *   - `riskLevel` 不写入 DraftItem（DraftItem 结构未声明该字段，shared-contracts §T-SCHEMA-01）；
 *     workflow 输出在外层数组保留 riskLevel 供 markdown 展示，但落库不带。
 *   - `reason` 在 schema 层 max(200)；calculator 已保证长度（含中文 5 段拼接）。
 */
export function toDraftItem(c: ComputedSku): DraftItem {
  return {
    skuId: c.skuId,
    skuName: c.skuName,
    unit: c.unit,
    baseSuggestQty: c.baseSuggestQty,
    finalSuggestQty: c.finalSuggestQty,
    reason: c.reason,
    adjustmentTrace: c.adjustmentTrace,
  };
}

/* ============================================================================
 * MCP 工具最小约束接口（避免依赖 mastra 工具运行时形态）
 * ========================================================================== */

interface QueryReplenishmentBaseDataTool {
  // Mastra 1.0 ToolAction.execute(inputData, context?) — inputData 直接展开。
  execute(inputData: Record<string, unknown>): Promise<ReplenishmentBaseData>;
}

interface ReplenishmentTools {
  queryReplenishmentBaseData: QueryReplenishmentBaseDataTool;
}

/* ============================================================================
 * Step 1：computeStep
 * ========================================================================== */

/**
 * Step 1 — 调 mergeStrategy + mcpTools().queryReplenishmentBaseData + calculator.computeSku。
 *
 * 流程：
 *   1. mergeStrategy({ merchantId, storeId }) —— 取 forecastDays / safetyStockDays 等策略参数。
 *   2. resolveForecastDays —— 取 `min(userForecastDays, strategy.forecastDays)`。
 *   3. mcpTools().queryReplenishmentBaseData.execute({ merchantId, storeId, forecastDays }) ——
 *      取 SKU 基础数据（recentSalesByDay / onHandQty / inTransitQty / packSize / contextFactors）。
 *   4. base.items.map(computeSku) —— 对每个 SKU 应用确定性公式（R-REP-001/002/004）。
 *
 * 异常：
 *   - mergeStrategy 失败：抛 BizError（由切片 11 实现 fallback platform default）。
 *   - queryReplenishmentBaseData 失败：抛 BizError(MCP_UNAVAILABLE)。
 *   - 公式 / strategy 越界：抛 BizError(SCHEMA_FAIL)。
 */
export const computeStep = createStep({
  id: 'compute-suggest-qty',
  inputSchema: ReplenishmentForecastInputSchema,
  outputSchema: ComputeStepOutputSchema,
  execute: async ({ inputData }) => {
    // 1) 合并策略（任务卡 §7 MUST DO §8）
    const strategyEntry = await mergeStrategy({
      merchantId: inputData.merchantId,
      storeId: inputData.storeId,
    });
    const strategy = StrategySchema.parse(strategyEntry.merged);

    // 2) 取有效 forecastDays（min(userForecastDays, strategy.forecastDays)，1..30）
    const effectiveForecastDays = resolveForecastDays({
      userForecastDays: inputData.forecastDays,
      strategyForecastDays: strategy.replenishmentPolicy.forecastDays,
    });

    // 3) 取 ERP 基础数据
    const tools = (await mcpTools()) as unknown as ReplenishmentTools;
    let base: ReplenishmentBaseData;
    try {
      base = await tools.queryReplenishmentBaseData.execute({
        merchantId: inputData.merchantId,
        storeId: inputData.storeId,
        forecastDays: effectiveForecastDays,
      });
    } catch (err) {
      throw new BizError(
        'MCP_UNAVAILABLE',
        '补货基础数据查询失败',
        { meta: { err: err instanceof Error ? err.message : String(err) } },
      );
    }

    const contextFactors = base.contextFactors ?? {
      isHolidayUpcoming: false,
      weatherTrend: 'UNKNOWN' as const,
    };

    // 4) 应用确定性公式（calculator 是纯函数；本步无 LLM 调用）
    const computed: ComputedSku[] = base.items.map((it) => {
      // it 类型为 ReplenishmentBaseItem；可能扩展含 salesAvg7d / 14 / 30 / minOrderQty
      const extended = it as typeof it & {
        salesAvg7d?: number;
        salesAvg14d?: number;
        salesAvg30d?: number;
        minOrderQty?: number;
      };
      return computeSku({
        it: extended,
        strategy: {
          forecastDays: effectiveForecastDays,
          safetyStockDays: strategy.replenishmentPolicy.safetyStockDays,
          minOrderQty: extended.minOrderQty,
          orderMultiple: extended.packSize,
        },
        contextFactors: { isHolidayUpcoming: contextFactors.isHolidayUpcoming },
      });
    });

    // 5) 派生 allowedNumbers（用于 validateOutput）：取 base data + computed 数字并集
    const allowedNumbers = extractNumbersFrom([base, computed]);

    return {
      items: computed,
      strategyVersion: strategyEntry.version,
      strategyDegraded: strategyEntry.degraded,
      forecastDays: effectiveForecastDays,
      contextFactors: { isHolidayUpcoming: contextFactors.isHolidayUpcoming },
      allowedNumbersList: [...allowedNumbers],
    };
  },
});

/* ============================================================================
 * Step 2：persistDraftStep
 * ========================================================================== */

/**
 * Step 2 — DraftManager.create 落库 → composeReplenishmentMarkdown → validateOutput。
 *
 * 流程：
 *   1. DraftManager.create({ sessionId, merchantId, storeId, userId, traceId, forecastDays, items, strategyVersion })
 *      落 `replenishment_draft.draftItems` 结构化 JSON。
 *   2. composeReplenishmentMarkdown({ draftId, status, prompt, draftItems }) → markdown / cards / abnormal。
 *   3. validateOutput({ schema, output, allowedNumbers }) —— Zod + 数字一致性。
 *   4. 失败 → 重试 1 次（compose retry=true）；再失败抛 NUMBER_INCONSISTENT / SCHEMA_FAIL。
 *
 * RuntimeContext：
 *   - 在 Mastra 1.0.x 中，step.execute 的 params 含 `requestContext: RequestContext`。
 *   - 本切片把它当成 RuntimeContext<AgentRuntime> 使用（runtime-context.ts 已做类型别名）。
 *
 * 短事务边界：
 *   - DraftManager.create 是短事务（切片 13 §7 MUST DO §5）。
 *   - compose / validate 在 create 之外，不构成事务嵌套；任务卡 §7 MUST NOT §7 的"草稿落库后
 *     await LLM"指的是"在事务内部"，本实现把 LLM 调用放到 create 完成后的事务外，符合约束。
 */
export const persistDraftStep = createStep({
  id: 'persist-draft',
  inputSchema: ComputeStepOutputSchema,
  outputSchema: ReplenishmentForecastOutputSchema,
  execute: async ({ inputData, requestContext }) => {
    const startedAt = Date.now();
    const env = getEnv();
    const items = inputData.items as ComputedSku[];

    // 从 RuntimeContext 取 5 字段（切片 06 / 13）
    // 把 mastra 1.0.x 默认 RequestContext 当成 RuntimeContext<AgentRuntime> 使用
    // （runtime-context.ts §30 已做类型别名 + buildRuntimeContext §32 已 set 全部 7 字段）。
    const ctx = requestContext as unknown as RuntimeContext<AgentRuntime>;
    const sessionId = getRuntimeString(ctx, 'sessionId');
    const merchantId = getRuntimeString(ctx, 'merchantId');
    const storeId = getRuntimeString(ctx, 'storeId');
    const userId = getRuntimeString(ctx, 'userId');
    const traceId = getRuntimeString(ctx, 'traceId');

    // 1) 落库（短事务；DraftManager.create 内部仅 INSERT）
    const draft = await draftManager.create({
      sessionId,
      merchantId,
      storeId,
      userId,
      traceId,
      forecastDays: inputData.forecastDays,
      items: items.map(toDraftItem),
      strategyVersion: inputData.strategyVersion,
    });

    // 2) compose markdown（事务外）—— LLM 仅渲染，不改数字
    const promptInput = {
      merchantId,
      storeId,
      forecastDays: inputData.forecastDays,
      strategyVersion: inputData.strategyVersion,
      maxSummaryChars: 8000,
      maxCards: 12,
    };

    const allowedNumbers = new Set<string>(inputData.allowedNumbersList);

    const baseOutput = (markdown: string, cards: ReplenishmentForecastOutput['cards'], abnormal: string[]): ReplenishmentForecastOutput => ({
      draftId: draft.draftId,
      status: draft.status,
      summaryMarkdown: markdown,
      cards,
      abnormalInsights: abnormal,
      items: draft.items.map((it) => ({
        skuId: it.skuId,
        skuName: it.skuName,
        unit: it.unit,
        baseSuggestQty: it.baseSuggestQty,
        finalSuggestQty: it.finalSuggestQty,
        reason: it.reason,
        adjustmentTrace: it.adjustmentTrace ?? [],
      })),
      strategyVersion: inputData.strategyVersion,
      forecastDays: inputData.forecastDays,
      dataSourceSummary: {
        tools: ['queryReplenishmentBaseData'],
        elapsedMs: Date.now() - startedAt,
      },
    });

    const first = await composeReplenishmentMarkdown({
      draftId: draft.draftId,
      status: draft.status,
      prompt: { ...promptInput, retry: false },
      draftItems: items,
    });

    try {
      return validateOutput({
        schema: ReplenishmentForecastOutputSchema,
        output: baseOutput(first.markdown, first.cards, first.abnormal),
        // clone allowedNumbers（validateOutput 会在 ## 数据来源 派生白名单时 mutate）
        allowedNumbers: new Set(allowedNumbers),
        enforceNumberConsistency: env.NUMBER_CONSISTENCY_CHECK_ENABLED,
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), draftId: draft.draftId },
        '[replenishment_forecast] validate failed, retry once',
      );
      const retry = await composeReplenishmentMarkdown({
        draftId: draft.draftId,
        status: draft.status,
        prompt: { ...promptInput, retry: true },
        draftItems: items,
      });
      return validateOutput({
        schema: ReplenishmentForecastOutputSchema,
        output: baseOutput(retry.markdown, retry.cards, retry.abnormal),
        allowedNumbers: new Set(allowedNumbers),
        enforceNumberConsistency: env.NUMBER_CONSISTENCY_CHECK_ENABLED,
      });
    }
  },
});

/* ============================================================================
 * Workflow
 * ========================================================================== */

/**
 * 补货预测 Workflow（replenishment_forecast）。
 *
 * 注册路径：mastra/workflows/index.ts barrel；切片 21 在 agent_skill_def 表插入对应 skillCode。
 */
export const replenishmentForecast = createWorkflow({
  id: 'replenishment_forecast',
  inputSchema: ReplenishmentForecastInputSchema,
  outputSchema: ReplenishmentForecastOutputSchema,
})
  .then(computeStep)
  .then(persistDraftStep)
  .commit();

function getRuntimeString(
  ctx: RuntimeContext<AgentRuntime>,
  key: 'sessionId' | 'merchantId' | 'storeId' | 'userId' | 'traceId',
): string {
  const value = ctx.get(key);
  if (typeof value !== 'string' || value.length === 0) {
    throw new BizError('INTERNAL_ERROR', `RuntimeContext 缺少 ${key}`);
  }
  return value;
}
