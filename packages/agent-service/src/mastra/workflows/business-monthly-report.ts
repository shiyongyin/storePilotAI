import dayjs from 'dayjs';
import { BizError, StrategySchema } from '@storepilot/shared-contracts';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import { mcpTools } from '../mcp/client.js';
import { getEnv } from '../../config/env.js';
import { logger } from '../../observability/logger.js';
import { monthlyReportPrompt } from '../../prompts/monthly-report.prompt.js';
import { extractNumbersFrom } from '../../safety/numbers.js';
import { mergeStrategy } from '../../safety/strategy-engine.js';
import { composeMarkdown } from '../../skills/reports/compose-markdown.js';
import { validateReportOutput } from './business-report-validation.js';

const MONTHLY_TOOL_NAMES = [
  'queryStoreSalesSummary',
  'queryCategorySalesRatio',
  'queryProductSalesRank',
  'queryInventoryOverview',
] as const;

interface ReportTool {
  // Mastra 1.0 ToolAction.execute(inputData, context?) — inputData 直接展开。
  execute(inputData: Record<string, unknown>): Promise<unknown>;
}

interface MonthlyTools {
  queryStoreSalesSummary: ReportTool;
  queryCategorySalesRatio: ReportTool;
  queryProductSalesRank: ReportTool;
  queryInventoryOverview: ReportTool;
}

interface ComposeResult {
  markdown: string;
  cards: Array<{ key: string; value: string | number }>;
  abnormal: string[];
}

const MonthlyInputSchema = z.object({
  merchantId: z.string(),
  storeId: z.string(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
});

const MonthlyQueryInputSchema = MonthlyInputSchema.extend({
  reportPolicy: z.object({
    maxSummaryChars: z.number().int().positive(),
    maxCards: z.number().int().positive(),
  }),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  prevStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  prevEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const MonthlyComposeInputSchema = z.object({
  'query-sales-summary-monthly': z.object({
    current: z.unknown().nullable(),
    previous: z.unknown().nullable(),
    previousMissing: z.boolean(),
  }),
  'query-category-ratio-monthly': z.object({ value: z.unknown().nullable() }),
  'query-product-rank-monthly': z.object({ value: z.unknown().nullable() }),
  'query-inventory-overview-monthly': z.object({ value: z.unknown().nullable() }),
});

type MonthlyComposeInput = z.infer<typeof MonthlyComposeInputSchema>;

const MonthlyWorkflowOutputSchema = z.object({
  reportType: z.literal('MONTHLY'),
  summaryMarkdown: z.string().min(100),
  cards: z.array(z.object({ key: z.string(), value: z.union([z.string(), z.number()]) })),
  abnormalInsights: z.array(z.string()).default([]),
  dataSourceSummary: z.object({
    tools: z.array(z.string()),
    elapsedMs: z.number(),
    missing: z.array(z.string()).default([]),
  }),
});

function buildMonthlyValidationSchema(reportPolicy: { maxSummaryChars: number; maxCards: number }) {
  return z.object({
    reportType: z.literal('MONTHLY'),
    summaryMarkdown: z.string().min(100).max(reportPolicy.maxSummaryChars),
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
 * 月报日期区间推断纯函数（导出供单测覆盖切片 12 §9 第 10 步月末边界场景）。
 *
 * 行为约定：
 * <ul>
 *   <li>本月：月初日 → `dayjs.endOf('month')`，覆盖 2/4/12 月的 28/30/31 天差异；</li>
 *   <li>上月：本月 startDate 减 1 个月后的 startOf/endOf('month')；</li>
 *   <li>所有结果均 `YYYY-MM-DD` 字符串，可直接拼入 ERP 工具 `dateRange` 入参。</li>
 * </ul>
 *
 * @param month `YYYY-MM` 月份字符串（必须由 {@link MonthlyInputSchema} 校验过）
 * @return 本月与上月的开始/结束日期四元组
 */
export function computeMonthlyDateRanges(month: string): {
  startDate: string;
  endDate: string;
  prevStartDate: string;
  prevEndDate: string;
} {
  const firstDay = `${month}-01`;
  const startDate = dayjs(firstDay).format('YYYY-MM-DD');
  const endDate = dayjs(firstDay).endOf('month').format('YYYY-MM-DD');
  const prevStartDate = dayjs(firstDay).subtract(1, 'month').startOf('month').format('YYYY-MM-DD');
  const prevEndDate = dayjs(firstDay).subtract(1, 'month').endOf('month').format('YYYY-MM-DD');
  return { startDate, endDate, prevStartDate, prevEndDate };
}

/**
 * 月报准备 step。导出供切片 12 §9 单测直接调用 `execute({ inputData })`，
 * 验证 mergeStrategy 接入与 {@link computeMonthlyDateRanges} 结果一致。
 */
export const prepareMonthlyInputStep = createStep({
  id: 'prepare-monthly-input',
  inputSchema: MonthlyInputSchema,
  outputSchema: MonthlyQueryInputSchema,
  execute: async ({ inputData }) => {
    const strategy = await mergeStrategy({
      merchantId: inputData.merchantId,
      storeId: inputData.storeId,
    });
    const ranges = computeMonthlyDateRanges(inputData.month);
    const mergedStrategy = StrategySchema.parse(strategy.merged);
    return {
      ...inputData,
      reportPolicy: mergedStrategy.reportPolicy,
      ...ranges,
    };
  },
});

/**
 * 月报销售汇总 step（含上月环比查询）。导出供 §9 单测覆盖并行 + 上月降级语义。
 */
export const querySalesStep = createStep({
  id: 'query-sales-summary-monthly',
  inputSchema: MonthlyQueryInputSchema,
  outputSchema: z.object({
    current: z.unknown().nullable(),
    previous: z.unknown().nullable(),
    previousMissing: z.boolean(),
  }),
  execute: async ({ inputData }) => {
    try {
      const tools = (await mcpTools()) as unknown as MonthlyTools;
      // Mastra 1.0 ToolAction.execute(inputData, context?)；inputData 直接展开。
      const currentPromise = tools.queryStoreSalesSummary.execute({
        merchantId: inputData.merchantId,
        storeId: inputData.storeId,
        dateRange: { startDate: inputData.startDate, endDate: inputData.endDate },
      });
      const previousPromise = tools.queryStoreSalesSummary.execute({
        merchantId: inputData.merchantId,
        storeId: inputData.storeId,
        dateRange: { startDate: inputData.prevStartDate, endDate: inputData.prevEndDate },
      });
      const [current, previous] = await Promise.allSettled([currentPromise, previousPromise]);
      return {
        current: current.status === 'fulfilled' ? current.value : null,
        previous: previous.status === 'fulfilled' ? previous.value : null,
        previousMissing: previous.status !== 'fulfilled',
      };
    } catch {
      return {
        current: null,
        previous: null,
        previousMissing: true,
      };
    }
  },
});

/** 月报品类占比 step。 */
export const queryRatioStep = createStep({
  id: 'query-category-ratio-monthly',
  inputSchema: MonthlyQueryInputSchema,
  outputSchema: z.object({ value: z.unknown().nullable() }),
  execute: async ({ inputData }) => {
    try {
      const tools = (await mcpTools()) as unknown as MonthlyTools;
      const value = await tools.queryCategorySalesRatio.execute({
        merchantId: inputData.merchantId,
        storeId: inputData.storeId,
        dateRange: { startDate: inputData.startDate, endDate: inputData.endDate },
      });
      return { value };
    } catch {
      return { value: null };
    }
  },
});

/** 月报商品销售排行 step。 */
export const queryRankStep = createStep({
  id: 'query-product-rank-monthly',
  inputSchema: MonthlyQueryInputSchema,
  outputSchema: z.object({ value: z.unknown().nullable() }),
  execute: async ({ inputData }) => {
    try {
      const tools = (await mcpTools()) as unknown as MonthlyTools;
      const value = await tools.queryProductSalesRank.execute({
        merchantId: inputData.merchantId,
        storeId: inputData.storeId,
        dateRange: { startDate: inputData.startDate, endDate: inputData.endDate },
        topN: 10,
      });
      return { value };
    } catch {
      return { value: null };
    }
  },
});

/** 月报库存风险 step。 */
export const queryInventoryStep = createStep({
  id: 'query-inventory-overview-monthly',
  inputSchema: MonthlyQueryInputSchema,
  outputSchema: z.object({ value: z.unknown().nullable() }),
  execute: async ({ inputData }) => {
    try {
      const tools = (await mcpTools()) as unknown as MonthlyTools;
      const value = await tools.queryInventoryOverview.execute({
        merchantId: inputData.merchantId,
        storeId: inputData.storeId,
        lowStockThresholdDays: 3,
      });
      return { value };
    } catch {
      return { value: null };
    }
  },
});

/**
 * 月报汇总 step。导出供 §9 单测验证：missing 聚合、全失败 MCP_UNAVAILABLE、
 * compose retry once、validateOutput 数字一致性。
 */
export const composeMonthlyReportStep = createStep({
  id: 'compose-monthly-report',
  inputSchema: MonthlyComposeInputSchema,
  outputSchema: MonthlyWorkflowOutputSchema,
  execute: async (params) => {
    const init = params.getInitData<z.infer<typeof MonthlyQueryInputSchema>>();
    const startedAt = Date.now();
    const env = getEnv();

    const inputData = MonthlyComposeInputSchema.parse(params.inputData);
    const sales = inputData['query-sales-summary-monthly'];
    const ratio = inputData['query-category-ratio-monthly'];
    const rank = inputData['query-product-rank-monthly'];
    const inventory = inputData['query-inventory-overview-monthly'];

    const missing: string[] = [];
    if (!sales?.current) missing.push('queryStoreSalesSummary');
    if (!ratio?.value) missing.push('queryCategorySalesRatio');
    if (!rank?.value) missing.push('queryProductSalesRank');
    if (!inventory?.value) missing.push('queryInventoryOverview');

    if (missing.length === MONTHLY_TOOL_NAMES.length) {
      throw new BizError('MCP_UNAVAILABLE', '所有 ERP 查询工具失败');
    }

    const llmInput = {
      merchantId: init.merchantId,
      storeId: init.storeId,
      month: init.month,
      currentMonthRange: { startDate: init.startDate, endDate: init.endDate },
      previousMonthRange: { startDate: init.prevStartDate, endDate: init.prevEndDate },
      salesCurrent: sales.current,
      salesPrevious: sales.previous,
      previousMonthMissing: sales.previousMissing,
      categoryRatio: ratio.value,
      productRank: rank.value,
      inventory: inventory.value,
      missing,
      derivedExpressionHint:
        '环比示例：12.5% = (本月销售额 1250 - 上月销售额 1110) / 上月销售额 1110',
    };

    const validationSchema = buildMonthlyValidationSchema(init.reportPolicy);
    const allowedNumbers = extractNumbersFrom([
      sales.current,
      sales.previous,
      ratio.value,
      rank.value,
      inventory.value,
    ].filter(Boolean));
    const buildOutput = (compose: ComposeResult) => ({
      reportType: 'MONTHLY' as const,
      summaryMarkdown: compose.markdown,
      cards: compose.cards,
      abnormalInsights: compose.abnormal,
      dataSourceSummary: {
        tools: MONTHLY_TOOL_NAMES.filter((toolName) => !missing.includes(toolName)),
        elapsedMs: Date.now() - startedAt,
        missing,
      },
    });

    let first: ComposeResult;
    try {
      first = await composeMarkdown({
        promptName: 'monthly',
        template: monthlyReportPrompt({
          month: init.month,
          maxSummaryChars: init.reportPolicy.maxSummaryChars,
          maxCards: init.reportPolicy.maxCards,
          retry: false,
        }),
        inputJson: llmInput,
        maxSummaryChars: init.reportPolicy.maxSummaryChars,
        maxCards: init.reportPolicy.maxCards,
      });
    } catch (firstError) {
      logger.warn(
        {
          err: firstError instanceof Error ? firstError.message : String(firstError),
        },
        '[business_monthly_report] compose failed, retry once',
      );
      try {
        first = await composeMarkdown({
          promptName: 'monthly',
          template: monthlyReportPrompt({
            month: init.month,
            maxSummaryChars: init.reportPolicy.maxSummaryChars,
            maxCards: init.reportPolicy.maxCards,
            retry: true,
          }),
          inputJson: llmInput,
          maxSummaryChars: init.reportPolicy.maxSummaryChars,
          maxCards: init.reportPolicy.maxCards,
        });
      } catch (retryError) {
        logger.warn(
          {
            err: retryError instanceof Error ? retryError.message : String(retryError),
          },
          '[business_monthly_report] compose retry failed, fallback to template report',
        );
        return validateReportOutput({
          schema: validationSchema,
          output: buildOutput(renderMonthlyFallback({ init, inputData })),
          allowedNumbers,
          enforceNumberConsistency: env.NUMBER_CONSISTENCY_CHECK_ENABLED,
        });
      }
    }

    const output = buildOutput(first);

    try {
      return validateReportOutput({
        schema: validationSchema,
        output,
        allowedNumbers,
        enforceNumberConsistency: env.NUMBER_CONSISTENCY_CHECK_ENABLED,
      });
    } catch (error) {
      logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
        },
        '[business_monthly_report] validate failed, retry once',
      );
      const retry = await composeMarkdown({
        promptName: 'monthly',
        template: monthlyReportPrompt({
          month: init.month,
          maxSummaryChars: init.reportPolicy.maxSummaryChars,
          maxCards: init.reportPolicy.maxCards,
          retry: true,
        }),
        inputJson: llmInput,
        maxSummaryChars: init.reportPolicy.maxSummaryChars,
        maxCards: init.reportPolicy.maxCards,
      });
      return validateReportOutput({
        schema: validationSchema,
        output: buildOutput(retry),
        allowedNumbers,
        enforceNumberConsistency: env.NUMBER_CONSISTENCY_CHECK_ENABLED,
      });
    }
  },
});

export const businessMonthlyReport = createWorkflow({
  id: 'business_monthly_report',
  inputSchema: MonthlyInputSchema,
  outputSchema: MonthlyWorkflowOutputSchema,
})
  .then(prepareMonthlyInputStep)
  .parallel([querySalesStep, queryRatioStep, queryRankStep, queryInventoryStep])
  .then(composeMonthlyReportStep)
  .commit();

function renderMonthlyFallback(args: {
  init: z.infer<typeof MonthlyQueryInputSchema>;
  inputData: MonthlyComposeInput;
}): ComposeResult {
  const sales = asRecord(args.inputData['query-sales-summary-monthly'].current);
  const previous = asRecord(args.inputData['query-sales-summary-monthly'].previous);
  const ratio = asRecord(args.inputData['query-category-ratio-monthly'].value);
  const rank = asRecord(args.inputData['query-product-rank-monthly'].value);
  const inventory = asRecord(args.inputData['query-inventory-overview-monthly'].value);

  const totalSales = readNumber(sales, ['totalSalesAmount', 'totalSales', 'salesAmount']);
  const orderCount = readNumber(sales, ['totalOrderCount', 'orderCount']);
  const customerCount = readNumber(sales, ['customerCount']);
  const avgOrderValue = readNumber(sales, ['avgOrderValue']);
  const previousSales = readNumber(previous, ['totalSalesAmount', 'totalSales', 'salesAmount']);
  const topCategory = firstRecord(ratio, ['categories']);
  const topProduct = firstRecord(rank, ['products', 'items']);
  const lowStock = readNumber(inventory, ['lowStockSkus', 'lowStockSkuCount']);
  const outOfStock = readNumber(inventory, ['outOfStockSkus', 'outOfStockSkuCount']);

  const lines = [
    `# ${args.init.startDate} 至 ${args.init.endDate} 经营月报`,
    '',
    '## 本月概览',
    [
      totalSales === undefined ? '本月销售额暂无数据' : `本月销售额 ${totalSales} 元`,
      orderCount === undefined ? null : `订单数 ${orderCount} 单`,
      customerCount === undefined ? null : `客户数 ${customerCount} 人`,
      avgOrderValue === undefined ? null : `客单价 ${avgOrderValue} 元`,
    ].filter(Boolean).join('，') + '。',
    '## 环比分析',
    previousSales === undefined || totalSales === undefined
      ? '上月对比数据暂无或不完整。'
      : `上月销售额 ${previousSales} 元，本月销售额 ${totalSales} 元。`,
    '## 品类结构与商品 Top/滞销',
    topCategory
      ? `${readString(topCategory, ['categoryName', 'name']) ?? 'Top 品类'}销售额 ${
          readNumber(topCategory, ['salesAmount']) ?? '暂无'
        } 元，占比 ${readNumber(topCategory, ['ratio']) ?? '暂无'}。`
      : '品类结构暂无数据。',
    topProduct
      ? `Top 商品 ${readString(topProduct, ['skuName', 'name']) ?? '暂无名称'}，销售额 ${
          readNumber(topProduct, ['salesAmount', 'sales']) ?? '暂无'
        } 元。`
      : '商品排行暂无数据。',
    '## 库存风险',
    [
      lowStock === undefined ? '低库存 SKU 暂无数据' : `低库存 SKU ${lowStock} 个`,
      outOfStock === undefined ? null : `缺货 SKU ${outOfStock} 个`,
    ].filter(Boolean).join('，') + '。',
    '## 下月建议',
    '优先跟进高销售品类和低库存 SKU，保持核心商品不断货。',
    '## 数据来源',
  ];

  for (const value of [
    totalSales,
    orderCount,
    customerCount,
    avgOrderValue,
    previousSales,
    readNumber(topCategory, ['salesAmount']),
    readNumber(topCategory, ['ratio']),
    readNumber(topProduct, ['salesAmount', 'sales']),
    lowStock,
    outOfStock,
  ]) {
    if (value !== undefined) lines.push(`- ${value} = ${value}`);
  }

  const cards: Array<{ key: string; value: string | number }> = [];
  if (totalSales !== undefined) cards.push({ key: 'total_sales', value: totalSales });
  if (orderCount !== undefined) cards.push({ key: 'order_count', value: orderCount });
  if (lowStock !== undefined) cards.push({ key: 'low_stock_skus', value: lowStock });

  return {
    markdown: lines.join('\n'),
    cards,
    abnormal: lowStock && lowStock > 0 ? [`低库存 SKU ${lowStock} 个`] : [],
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function readNumber(record: Record<string, unknown> | null, keys: string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function readString(record: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function firstRecord(
  record: Record<string, unknown> | null,
  keys: string[],
): Record<string, unknown> | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (isUnknownArray(value)) {
      const first = value.find((it) => it && typeof it === 'object');
      if (first && typeof first === 'object') return first as Record<string, unknown>;
    }
  }
  return null;
}
