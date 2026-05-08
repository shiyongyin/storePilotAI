import { BizError, StrategySchema } from '@storepilot/shared-contracts';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import { mcpTools } from '../mcp/client.js';
import { getEnv } from '../../config/env.js';
import { logger } from '../../observability/logger.js';
import { dailyReportPrompt } from '../../prompts/daily-report.prompt.js';
import { extractNumbersFrom } from '../../safety/numbers.js';
import { mergeStrategy } from '../../safety/strategy-engine.js';
import { composeMarkdown } from '../../skills/reports/compose-markdown.js';
import { validateReportOutput } from './business-report-validation.js';

const DAILY_TOOL_NAMES = [
  'getStoreReportConfig',
  'queryStoreSalesSummary',
  'queryCategorySalesRatio',
  'queryProductSalesRank',
  'queryInventoryOverview',
] as const;

interface ReportTool {
  // Mastra 1.0 ToolAction.execute(inputData, context?) — inputData 直接展开。
  execute(inputData: Record<string, unknown>): Promise<unknown>;
}

interface DailyTools {
  getStoreReportConfig: ReportTool;
  queryStoreSalesSummary: ReportTool;
  queryCategorySalesRatio: ReportTool;
  queryProductSalesRank: ReportTool;
  queryInventoryOverview: ReportTool;
}

const DailyInputSchema = z.object({
  merchantId: z.string(),
  storeId: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const DailyWorkflowOutputSchema = z.object({
  reportType: z.literal('DAILY'),
  summaryMarkdown: z.string().min(50),
  cards: z.array(z.object({ key: z.string(), value: z.union([z.string(), z.number()]) })),
  abnormalInsights: z.array(z.string()).default([]),
  dataSourceSummary: z.object({
    tools: z.array(z.string()),
    elapsedMs: z.number(),
    missing: z.array(z.string()).default([]),
  }),
});

function buildDailyValidationSchema(reportPolicy: { maxSummaryChars: number; maxCards: number }) {
  return z.object({
    reportType: z.literal('DAILY'),
    summaryMarkdown: z.string().min(50).max(reportPolicy.maxSummaryChars),
    cards: z
      .array(z.object({ key: z.string(), value: z.union([z.string(), z.number()]) }))
      .max(reportPolicy.maxCards),
    abnormalInsights: z.array(z.string()).default([]),
    dataSourceSummary: z.object({
      tools: z.array(z.string()),
      elapsedMs: z.number(),
      missing: z.array(z.string()).default([]),
    }),
  });
}

/**
 * 日报核心 step。导出供切片 12 §9 单测直接调用 `execute({ inputData })`，
 * 避免拉起完整 Mastra 引擎；workflow 仍然 `.then(generateDailyReportStep)` 注册。
 */
export const generateDailyReportStep = createStep({
  id: 'generate-daily-report',
  inputSchema: DailyInputSchema,
  outputSchema: DailyWorkflowOutputSchema,
  execute: async ({ inputData }) => {
    const startedAt = Date.now();
    const env = getEnv();
    const strategy = await mergeStrategy({
      merchantId: inputData.merchantId,
      storeId: inputData.storeId,
    });
    const mergedStrategy = StrategySchema.parse(strategy.merged);
    const reportPolicy = mergedStrategy.reportPolicy;
    const tools = (await mcpTools()) as unknown as DailyTools;

    const dateRange = { startDate: inputData.date, endDate: inputData.date };
    // Mastra 1.0 ToolAction.execute 签名为 `(inputData, context?)`；inputData 直接是
    // 工具 schema 校验的对象，禁止包在 `{ context: ... }` 里（那是 Mastra 0.x 的 API）。
    const settled = await Promise.allSettled([
      tools.getStoreReportConfig.execute({
        merchantId: inputData.merchantId,
        storeId: inputData.storeId,
      }),
      tools.queryStoreSalesSummary.execute({
        merchantId: inputData.merchantId,
        storeId: inputData.storeId,
        dateRange,
      }),
      tools.queryCategorySalesRatio.execute({
        merchantId: inputData.merchantId,
        storeId: inputData.storeId,
        dateRange,
      }),
      tools.queryProductSalesRank.execute({
        merchantId: inputData.merchantId,
        storeId: inputData.storeId,
        dateRange,
        topN: 10,
      }),
      tools.queryInventoryOverview.execute({
        merchantId: inputData.merchantId,
        storeId: inputData.storeId,
        lowStockThresholdDays: 3,
      }),
    ]);

    const missing = DAILY_TOOL_NAMES.filter((_, index) => settled[index]?.status !== 'fulfilled');
    if (missing.length === DAILY_TOOL_NAMES.length) {
      throw new BizError('MCP_UNAVAILABLE', '所有 ERP 查询工具失败');
    }

    const config = settled[0]?.status === 'fulfilled' ? settled[0].value : null;
    const sales = settled[1]?.status === 'fulfilled' ? settled[1].value : null;
    const ratio = settled[2]?.status === 'fulfilled' ? settled[2].value : null;
    const rank = settled[3]?.status === 'fulfilled' ? settled[3].value : null;
    const inventory = settled[4]?.status === 'fulfilled' ? settled[4].value : null;

    const composeInput = {
      reportDate: inputData.date,
      maxSummaryChars: reportPolicy.maxSummaryChars,
      maxCards: reportPolicy.maxCards,
      retry: false,
    };
    const llmInput = {
      merchantId: inputData.merchantId,
      storeId: inputData.storeId,
      date: inputData.date,
      config,
      sales,
      ratio,
      rank,
      inventory,
      missing,
    };

    const first = await composeMarkdown({
      promptName: 'daily',
      template: dailyReportPrompt(composeInput),
      inputJson: llmInput,
      maxSummaryChars: reportPolicy.maxSummaryChars,
      maxCards: reportPolicy.maxCards,
    });

    const baseOutput = {
      reportType: 'DAILY' as const,
      summaryMarkdown: first.markdown,
      cards: first.cards,
      abnormalInsights: first.abnormal,
      dataSourceSummary: {
        tools: DAILY_TOOL_NAMES.filter((toolName) => !missing.includes(toolName)),
        elapsedMs: Date.now() - startedAt,
        missing,
      },
    };

    const validationSchema = buildDailyValidationSchema(reportPolicy);
    const allowedNumbers = extractNumbersFrom([config, sales, ratio, rank, inventory].filter(Boolean));

    try {
      return validateReportOutput({
        schema: validationSchema,
        output: baseOutput,
        allowedNumbers,
        enforceNumberConsistency: env.NUMBER_CONSISTENCY_CHECK_ENABLED,
      });
    } catch (error) {
      logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
          modelTimeoutMs: env.MODEL_TIMEOUT_MS,
        },
        '[business_daily_report] validate failed, retry once',
      );
      const retry = await composeMarkdown({
        promptName: 'daily',
        template: dailyReportPrompt({ ...composeInput, retry: true }),
        inputJson: llmInput,
        maxSummaryChars: reportPolicy.maxSummaryChars,
        maxCards: reportPolicy.maxCards,
      });
      return validateReportOutput({
        schema: validationSchema,
        output: {
          ...baseOutput,
          summaryMarkdown: retry.markdown,
          cards: retry.cards,
          abnormalInsights: retry.abnormal,
        },
        allowedNumbers,
        enforceNumberConsistency: env.NUMBER_CONSISTENCY_CHECK_ENABLED,
      });
    }
  },
});

export const businessDailyReport = createWorkflow({
  id: 'business_daily_report',
  inputSchema: DailyInputSchema,
  outputSchema: DailyWorkflowOutputSchema,
})
  .then(generateDailyReportStep)
  .commit();
