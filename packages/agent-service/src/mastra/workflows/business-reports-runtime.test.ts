/**
 * 切片 12 §9 第 1-8 / 11 步运行期单测 — 直接调用 step.execute 验证：
 *   - 第 1/2 步：happy daily/monthly（无 LLM，用 composeMarkdown mock；E2E SSE 由切片 18 联动）
 *   - 第 4 步：partial missing 时 dataSourceSummary.missing 与 tools 准确反映
 *   - 第 5 步：数字伪造 → validateOutput 抛 NUMBER_INCONSISTENT，重试再失败 → 抛错
 *   - 第 6 步：schema 失败首次、重试后成功
 *   - 第 7/8 步：日报 5 工具 / 月报 4 step 的并行实际并发执行（耗时 ≈ max 而非 sum）
 *   - 第 11 步：全工具失败 → BizError(MCP_UNAVAILABLE)
 *   - §11 自检：mergeStrategy 必须先于工具调用执行；reportPolicy 直接驱动 OutputSchema 上限
 *
 * 隔离手段：vi.mock 屏蔽 `mcpTools` / `mergeStrategy` / `composeMarkdown`，
 * 所有用例仅依赖纯算法路径，不触达真实 ERP / OpenAI。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { BizError } from '@storepilot/shared-contracts';

import type { Strategy } from '@storepilot/shared-contracts';

const ENV_FIXTURE: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '7100',
  DATABASE_URL: 'mysql://test:test@localhost:3306/test',
  MODEL_PROVIDER: 'openai-compatible',
  MODEL_BASE_URL: 'http://localhost:7100/llm',
  MODEL_API_KEY: 'sk-test-1234567890',
  MODEL_NAME: 'gpt-test',
  ERP_MCP_SERVER_URL: 'http://localhost:7300/mcp',
  MCP_TENANT_SHARED_SECRET: 'a'.repeat(32),
  MCP_PROTOCOL_VERSION: '2025-06-18',
  AGENT_API_KEY_HASH_SALT: 'salt-abcdef-1234',
  AGENT_API_KEY_PREFIX: 'sk-agent-',
  CORS_ALLOWED_ORIGINS: 'http://localhost:3210',
};

vi.mock('../mcp/client.js', () => ({
  mcpTools: vi.fn(),
  TOOL_WHITELIST: [],
  __resetMcpClientForTest: vi.fn(),
}));

vi.mock('../../safety/strategy-engine.js', () => ({
  mergeStrategy: vi.fn(),
}));

vi.mock('../../skills/reports/compose-markdown.js', () => ({
  composeMarkdown: vi.fn(),
}));

type ExecuteFn = (args: Record<string, unknown>) => Promise<unknown>;

interface DailyTools {
  getStoreReportConfig: { execute: ExecuteFn };
  queryStoreSalesSummary: { execute: ExecuteFn };
  queryCategorySalesRatio: { execute: ExecuteFn };
  queryProductSalesRank: { execute: ExecuteFn };
  queryInventoryOverview: { execute: ExecuteFn };
}

let generateDailyReportStep: { execute: ExecuteFn };
let prepareMonthlyInputStep: { execute: ExecuteFn };
let querySalesStep: { execute: ExecuteFn };
let queryRatioStep: { execute: ExecuteFn };
let queryRankStep: { execute: ExecuteFn };
let queryInventoryStep: { execute: ExecuteFn };
let composeMonthlyReportStep: { execute: ExecuteFn };
let computeMonthlyDateRanges: (m: string) => {
  startDate: string;
  endDate: string;
  prevStartDate: string;
  prevEndDate: string;
};

let mcpToolsMock: ReturnType<typeof vi.fn>;
let mergeStrategyMock: ReturnType<typeof vi.fn>;
let composeMarkdownMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV_FIXTURE)) vi.stubEnv(k, v);
  ({ mcpTools: mcpToolsMock } = (await import('../mcp/client.js')) as unknown as {
    mcpTools: ReturnType<typeof vi.fn>;
  });
  ({ mergeStrategy: mergeStrategyMock } = (await import(
    '../../safety/strategy-engine.js'
  )) as unknown as { mergeStrategy: ReturnType<typeof vi.fn> });
  ({ composeMarkdown: composeMarkdownMock } = (await import(
    '../../skills/reports/compose-markdown.js'
  )) as unknown as { composeMarkdown: ReturnType<typeof vi.fn> });

  ({ generateDailyReportStep } = (await import('./business-daily-report.js')) as unknown as {
    generateDailyReportStep: { execute: ExecuteFn };
  });
  ({
    prepareMonthlyInputStep,
    querySalesStep,
    queryRatioStep,
    queryRankStep,
    queryInventoryStep,
    composeMonthlyReportStep,
    computeMonthlyDateRanges,
  } = (await import('./business-monthly-report.js')) as unknown as {
    prepareMonthlyInputStep: { execute: ExecuteFn };
    querySalesStep: { execute: ExecuteFn };
    queryRatioStep: { execute: ExecuteFn };
    queryRankStep: { execute: ExecuteFn };
    queryInventoryStep: { execute: ExecuteFn };
    composeMonthlyReportStep: { execute: ExecuteFn };
    computeMonthlyDateRanges: (m: string) => {
      startDate: string;
      endDate: string;
      prevStartDate: string;
      prevEndDate: string;
    };
  });
});

afterAll(() => {
  vi.unstubAllEnvs();
});

const STRATEGY_DEFAULT: Strategy = {
  enabledSkills: ['business_daily_report', 'business_monthly_report'],
  replenishmentPolicy: {
    forecastDays: 7,
    safetyStockDays: 2,
    requireConfirmBeforePurchaseOrder: true,
    allowAutoPurchaseOrder: false,
    forecastMethod: 'weighted_moving_average',
  },
  reportPolicy: { maxSummaryChars: 8000, maxCards: 12 },
  safetyPolicy: {
    requireUserConfirmForWrite: true,
    maxAdjustmentsPerDraft: 10,
    majorAdjustmentRatio: 0.5,
    draftAutoExpireMinutes: 30,
  },
};

function setStrategy(over: Partial<Strategy['reportPolicy']> = {}): void {
  mergeStrategyMock.mockResolvedValue({
    merged: {
      ...STRATEGY_DEFAULT,
      reportPolicy: { ...STRATEGY_DEFAULT.reportPolicy, ...over },
    },
    version: 'M0-S0-Pplatform-default-v1.0.0',
    degraded: false,
  });
}

/** 默认数字数据源（所有用例共用，确保 markdown 中的数字都来自此对象，避免误触 NUMBER_INCONSISTENT） */
const SALES_SUMMARY = { totalSales: 1250, orderCount: 25, avgOrderValue: 50 };
const CATEGORY_RATIO = { categories: [{ name: '饮料', ratio: 0.4 }] };
const PRODUCT_RANK = { items: [{ skuName: 'A', sales: 500 }] };
const INVENTORY = { lowStockSkuCount: 3, deadStockSkuCount: 1 };
const STORE_CONFIG = { storeName: 'demo' };

function buildDailyTools(opts: {
  failTools?: ReadonlyArray<keyof DailyTools>;
  delayMs?: number;
} = {}): DailyTools {
  const { failTools = [], delayMs = 0 } = opts;
  const wrap = (toolName: keyof DailyTools, payload: unknown): { execute: ExecuteFn } => ({
    execute: async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      if (failTools.includes(toolName)) {
        throw new Error(`mock-${toolName as string}-fail`);
      }
      return payload;
    },
  });
  return {
    getStoreReportConfig: wrap('getStoreReportConfig', STORE_CONFIG),
    queryStoreSalesSummary: wrap('queryStoreSalesSummary', SALES_SUMMARY),
    queryCategorySalesRatio: wrap('queryCategorySalesRatio', CATEGORY_RATIO),
    queryProductSalesRank: wrap('queryProductSalesRank', PRODUCT_RANK),
    queryInventoryOverview: wrap('queryInventoryOverview', INVENTORY),
  };
}

const HAPPY_DAILY_MARKDOWN = [
  '# 2026-05-07 经营日报',
  '',
  '本店当日销售额 1250 元，共 25 单，客单价 50 元。',
  '低库存 SKU 3 个，呆滞 SKU 1 个；饮料品类占比 40%。',
  '',
  '## 数据来源',
  '- 40% = 0.4',
].join('\n');

/**
 * 月报 happy markdown：标题用完整 YYYY-MM-DD 起止区间（被 output-validator 的
 * `\d{4}-\d{2}-\d{2}` 正则 strip 为 `<DATE>`），避免 `2026-05` 这种 YYYY-MM
 * 形态被当成数字 2026 触发误报（这是 V1 已知边界，不在切片 12 范围内修补）。
 */
const HAPPY_MONTHLY_MARKDOWN = [
  '# 2026-05-01 至 2026-05-31 经营月报',
  '',
  '## 本月概览',
  '本月销售额 1250 元，共 25 单，客单价 50 元；上月销售额 1110 元，环比 12.61%。',
  '## 环比分析',
  '本月较上月增长 12.61%。',
  '## 品类结构与商品 Top/滞销',
  '饮料品类占比 40%；商品 A 销售 500 元；呆滞 SKU 1 个。',
  '## 库存风险',
  '低库存 SKU 3 个。',
  '## 下月建议',
  '加强饮料品类铺货。',
  '## 数据来源',
  '- 12.61% = (1250 - 1110) / 1110',
  '- 40% = 0.4',
].join('\n');

const HAPPY_DAILY_COMPOSE = {
  markdown: HAPPY_DAILY_MARKDOWN,
  cards: [{ key: 'total_sales', value: 1250 }],
  abnormal: [],
};
const HAPPY_MONTHLY_COMPOSE = {
  markdown: HAPPY_MONTHLY_MARKDOWN,
  cards: [{ key: 'total_sales', value: 1250 }],
  abnormal: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  setStrategy();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ====================== 日报：generateDailyReportStep ======================

describe('切片 12 §9 第 1 步 — daily happy', () => {
  it('5 个工具全部成功 → reportType=DAILY，dataSourceSummary.tools=5/missing=[]', async () => {
    mcpToolsMock.mockResolvedValue(buildDailyTools());
    composeMarkdownMock.mockResolvedValue(HAPPY_DAILY_COMPOSE);

    const result = (await generateDailyReportStep.execute({
      inputData: { merchantId: 'M001', storeId: 'S001', date: '2026-05-07' },
    })) as Record<string, unknown>;

    expect(result.reportType).toBe('DAILY');
    expect(result.summaryMarkdown).toContain('## 数据来源');
    const ds = result.dataSourceSummary as { tools: string[]; missing: string[]; elapsedMs: number };
    expect(ds.tools).toEqual([
      'getStoreReportConfig',
      'queryStoreSalesSummary',
      'queryCategorySalesRatio',
      'queryProductSalesRank',
      'queryInventoryOverview',
    ]);
    expect(ds.missing).toEqual([]);
    expect(ds.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(mergeStrategyMock).toHaveBeenCalledTimes(1);
  });
});

describe('切片 12 §9 第 4 步 — daily partial missing', () => {
  it('1 个工具失败 → missing 单条且文案不崩；tools 数量 = 4', async () => {
    mcpToolsMock.mockResolvedValue(
      buildDailyTools({ failTools: ['queryCategorySalesRatio'] }),
    );
    // 当品类工具缺失时，LLM 应输出不含 40% / 0.4 的 markdown，并显式标注暂无数据
    const PARTIAL_DAILY_MARKDOWN = [
      '# 2026-05-07 经营日报',
      '',
      '本店当日销售额 1250 元，共 25 单，客单价 50 元。',
      '低库存 SKU 3 个，呆滞 SKU 1 个；该指标暂无数据（来源：queryCategorySalesRatio 失败）。',
      '',
      '## 数据来源',
    ].join('\n');
    composeMarkdownMock.mockResolvedValue({
      markdown: PARTIAL_DAILY_MARKDOWN,
      cards: [{ key: 'total_sales', value: 1250 }],
      abnormal: [],
    });

    const result = (await generateDailyReportStep.execute({
      inputData: { merchantId: 'M001', storeId: 'S001', date: '2026-05-07' },
    })) as Record<string, unknown>;
    const ds = result.dataSourceSummary as { tools: string[]; missing: string[] };
    expect(ds.missing).toEqual(['queryCategorySalesRatio']);
    expect(ds.tools).toEqual([
      'getStoreReportConfig',
      'queryStoreSalesSummary',
      'queryProductSalesRank',
      'queryInventoryOverview',
    ]);
    expect(result.summaryMarkdown).toContain('该指标暂无数据');
  });
});

describe('切片 12 §9 第 11 步 — daily 全工具失败 MCP_UNAVAILABLE', () => {
  it('5 个工具全失败 → 抛 BizError(MCP_UNAVAILABLE)', async () => {
    mcpToolsMock.mockResolvedValue(
      buildDailyTools({
        failTools: [
          'getStoreReportConfig',
          'queryStoreSalesSummary',
          'queryCategorySalesRatio',
          'queryProductSalesRank',
          'queryInventoryOverview',
        ],
      }),
    );
    await expect(
      generateDailyReportStep.execute({
        inputData: { merchantId: 'M001', storeId: 'S001', date: '2026-05-07' },
      }),
    ).rejects.toMatchObject({ code: 'MCP_UNAVAILABLE' });
    expect(composeMarkdownMock).not.toHaveBeenCalled();
  });
});

describe('切片 12 §9 第 8 步 — daily 5 工具并行（不是顺序 await）', () => {
  it('每个工具 ≥ 80ms → 总耗时 ≈ max（< 5 × 80 = 400ms 上限设 250ms）', async () => {
    mcpToolsMock.mockResolvedValue(buildDailyTools({ delayMs: 80 }));
    composeMarkdownMock.mockResolvedValue(HAPPY_DAILY_COMPOSE);
    const t0 = Date.now();
    await generateDailyReportStep.execute({
      inputData: { merchantId: 'M001', storeId: 'S001', date: '2026-05-07' },
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThan(250);
  });
});

describe('切片 12 §9 第 6 步 — daily schema 失败重试', () => {
  it('compose 首次返回 < 50 字短 markdown → 重试一次成功', async () => {
    mcpToolsMock.mockResolvedValue(buildDailyTools());
    composeMarkdownMock
      .mockResolvedValueOnce({
        markdown: '太短',
        cards: [],
        abnormal: [],
      })
      .mockResolvedValueOnce(HAPPY_DAILY_COMPOSE);

    const result = (await generateDailyReportStep.execute({
      inputData: { merchantId: 'M001', storeId: 'S001', date: '2026-05-07' },
    })) as Record<string, unknown>;

    expect(result.reportType).toBe('DAILY');
    expect(composeMarkdownMock).toHaveBeenCalledTimes(2);
    expect(
      (composeMarkdownMock.mock.calls[1]?.[0] as { template: string }).template,
    ).toContain('重试生成');
  });

  it('两次都失败 → 抛错（仅重试 1 次，不会有第 3 次 compose）', async () => {
    mcpToolsMock.mockResolvedValue(buildDailyTools());
    composeMarkdownMock
      .mockResolvedValueOnce({ markdown: '太短', cards: [], abnormal: [] })
      .mockResolvedValueOnce({ markdown: '依然太短', cards: [], abnormal: [] });

    await expect(
      generateDailyReportStep.execute({
        inputData: { merchantId: 'M001', storeId: 'S001', date: '2026-05-07' },
      }),
    ).rejects.toMatchObject({ code: 'SCHEMA_FAIL' });
    expect(composeMarkdownMock).toHaveBeenCalledTimes(2);
  });
});

describe('切片 12 §9 第 5 步 — daily 数字伪造拦截', () => {
  it('compose 首次输出含工具未返回的数字 → NUMBER_INCONSISTENT，重试后合规 → success', async () => {
    mcpToolsMock.mockResolvedValue(buildDailyTools());
    composeMarkdownMock
      .mockResolvedValueOnce({
        markdown:
          '# 2026-05-07 经营日报\n\n本店当日销售额 9999 元（伪造数字）。今日营业 13.7% 增长（伪造）。\n\n## 数据来源',
        cards: [{ key: 'total_sales', value: 9999 }],
        abnormal: [],
      })
      .mockResolvedValueOnce(HAPPY_DAILY_COMPOSE);

    const result = (await generateDailyReportStep.execute({
      inputData: { merchantId: 'M001', storeId: 'S001', date: '2026-05-07' },
    })) as Record<string, unknown>;
    expect(result.reportType).toBe('DAILY');
    expect(composeMarkdownMock).toHaveBeenCalledTimes(2);
  });

  it('两次都伪造 → BizError(NUMBER_INCONSISTENT) 直接抛出', async () => {
    mcpToolsMock.mockResolvedValue(buildDailyTools());
    composeMarkdownMock
      .mockResolvedValueOnce({
        markdown:
          '# 2026-05-07 经营日报\n\n本店当日销售额 9999 元（伪造数字），增长 13.7%（伪造）。\n\n## 数据来源',
        cards: [],
        abnormal: [],
      })
      .mockResolvedValueOnce({
        markdown:
          '# 2026-05-07 经营日报\n\n本店当日销售额 8888 元（伪造数字），增长 17.3%（伪造）。\n\n## 数据来源',
        cards: [],
        abnormal: [],
      });

    await expect(
      generateDailyReportStep.execute({
        inputData: { merchantId: 'M001', storeId: 'S001', date: '2026-05-07' },
      }),
    ).rejects.toMatchObject({ code: 'NUMBER_INCONSISTENT' });
  });

  it('含模糊数字措辞 → SCHEMA_FAIL，重试仍含则拒发', async () => {
    mcpToolsMock.mockResolvedValue(buildDailyTools());
    composeMarkdownMock
      .mockResolvedValueOnce({
        markdown:
          '# 2026-05-07 经营日报\n\n本店今日约 1250 元销售额，共 25 单。\n\n## 数据来源',
        cards: [],
        abnormal: [],
      })
      .mockResolvedValueOnce({
        markdown:
          '# 2026-05-07 经营日报\n\n本店今日大概 1250 元销售额，共 25 单。\n\n## 数据来源',
        cards: [],
        abnormal: [],
      });

    await expect(
      generateDailyReportStep.execute({
        inputData: { merchantId: 'M001', storeId: 'S001', date: '2026-05-07' },
      }),
    ).rejects.toMatchObject({ code: 'SCHEMA_FAIL' });
    expect(composeMarkdownMock).toHaveBeenCalledTimes(2);
  });
});

describe('切片 12 §11 自检 — reportPolicy 透传到 prompt', () => {
  it('mergeStrategy 返回 maxSummaryChars=600/maxCards=4 → composeMarkdown 入参一致', async () => {
    setStrategy({ maxSummaryChars: 600, maxCards: 4 });
    mcpToolsMock.mockResolvedValue(buildDailyTools());
    composeMarkdownMock.mockResolvedValue(HAPPY_DAILY_COMPOSE);
    await generateDailyReportStep.execute({
      inputData: { merchantId: 'M001', storeId: 'S001', date: '2026-05-07' },
    });
    const call = composeMarkdownMock.mock.calls[0]?.[0] as {
      template: string;
      maxSummaryChars: number;
      maxCards: number;
    };
    expect(call.maxSummaryChars).toBe(600);
    expect(call.maxCards).toBe(4);
    expect(call.template).toContain('600');
    expect(call.template).toContain('最多 4');
  });
});

// ====================== 月报：4 步并行 + compose ======================

const MONTHLY_QUERY_INPUT = {
  merchantId: 'M001',
  storeId: 'S001',
  month: '2026-05',
  reportPolicy: { maxSummaryChars: 8000, maxCards: 12 },
  startDate: '2026-05-01',
  endDate: '2026-05-31',
  prevStartDate: '2026-04-01',
  prevEndDate: '2026-04-30',
};

describe('切片 12 §11 自检 — prepareMonthlyInputStep', () => {
  it('mergeStrategy 必须先于工具调用执行；返回 reportPolicy + 月末日期', async () => {
    setStrategy({ maxSummaryChars: 5000, maxCards: 8 });
    const out = (await prepareMonthlyInputStep.execute({
      inputData: { merchantId: 'M001', storeId: 'S001', month: '2026-05' },
    })) as Record<string, unknown>;
    expect(out.reportPolicy).toEqual({ maxSummaryChars: 5000, maxCards: 8 });
    expect(out.startDate).toBe('2026-05-01');
    expect(out.endDate).toBe('2026-05-31');
    expect(out.prevStartDate).toBe('2026-04-01');
    expect(out.prevEndDate).toBe('2026-04-30');
    expect(mergeStrategyMock).toHaveBeenCalledTimes(1);
    expect(mcpToolsMock).not.toHaveBeenCalled();
  });

  it('与 computeMonthlyDateRanges 输出严格一致（避免 prepare 重复实现漂移）', async () => {
    const ranges = computeMonthlyDateRanges('2026-02');
    setStrategy();
    const out = (await prepareMonthlyInputStep.execute({
      inputData: { merchantId: 'M001', storeId: 'S001', month: '2026-02' },
    })) as Record<string, unknown>;
    expect(out.startDate).toBe(ranges.startDate);
    expect(out.endDate).toBe(ranges.endDate);
    expect(out.prevStartDate).toBe(ranges.prevStartDate);
    expect(out.prevEndDate).toBe(ranges.prevEndDate);
  });
});

describe('切片 12 §9 第 7 步 — monthly 4 step 并发执行', () => {
  it('4 个 query step 用 Promise.all 同时 execute → 总耗时 ≈ max（< 4 × 80 = 320ms，上限 250ms）', async () => {
    mcpToolsMock.mockImplementation(() => Promise.resolve({
      queryStoreSalesSummary: {
        execute: async () => {
          await new Promise((r) => setTimeout(r, 80));
          return SALES_SUMMARY;
        },
      },
      queryCategorySalesRatio: {
        execute: async () => {
          await new Promise((r) => setTimeout(r, 80));
          return CATEGORY_RATIO;
        },
      },
      queryProductSalesRank: {
        execute: async () => {
          await new Promise((r) => setTimeout(r, 80));
          return PRODUCT_RANK;
        },
      },
      queryInventoryOverview: {
        execute: async () => {
          await new Promise((r) => setTimeout(r, 80));
          return INVENTORY;
        },
      },
    }) as unknown as Promise<unknown>);

    const t0 = Date.now();
    const results = await Promise.all([
      querySalesStep.execute({ inputData: MONTHLY_QUERY_INPUT }),
      queryRatioStep.execute({ inputData: MONTHLY_QUERY_INPUT }),
      queryRankStep.execute({ inputData: MONTHLY_QUERY_INPUT }),
      queryInventoryStep.execute({ inputData: MONTHLY_QUERY_INPUT }),
    ]);
    const elapsed = Date.now() - t0;
    expect(results).toHaveLength(4);
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThan(250);
  });

  it('querySalesStep 上月失败 → previousMissing=true，本月 current 仍可用', async () => {
    mcpToolsMock.mockResolvedValue({
      queryStoreSalesSummary: {
        // Mastra 1.0: tool.execute(inputData) — inputData 直接展开。
        execute: (args: { dateRange: { startDate: string } }) => {
          if (args.dateRange.startDate === MONTHLY_QUERY_INPUT.prevStartDate) {
            return Promise.reject(new Error('mock prev fail'));
          }
          return Promise.resolve(SALES_SUMMARY);
        },
      },
    });
    const out = (await querySalesStep.execute({
      inputData: MONTHLY_QUERY_INPUT,
    })) as { current: unknown; previous: unknown; previousMissing: boolean };
    expect(out.current).toEqual(SALES_SUMMARY);
    expect(out.previous).toBeNull();
    expect(out.previousMissing).toBe(true);
  });

  it('querySalesStep 本月失败 → 返回 current=null，让 compose 统一 missing / 全失败判定', async () => {
    mcpToolsMock.mockResolvedValue({
      queryStoreSalesSummary: {
        execute: () => Promise.reject(new Error('mock current fail')),
      },
    });
    const out = (await querySalesStep.execute({
      inputData: MONTHLY_QUERY_INPUT,
    })) as { current: unknown; previous: unknown; previousMissing: boolean };
    expect(out.current).toBeNull();
    expect(out.previous).toBeNull();
    expect(out.previousMissing).toBe(true);
  });

  it('ratio/rank/inventory 工具失败 → step 返回 value=null，不中断 parallel 后续汇总', async () => {
    mcpToolsMock.mockResolvedValue({
      queryCategorySalesRatio: { execute: () => Promise.reject(new Error('ratio fail')) },
      queryProductSalesRank: { execute: () => Promise.reject(new Error('rank fail')) },
      queryInventoryOverview: { execute: () => Promise.reject(new Error('inventory fail')) },
    });
    await expect(queryRatioStep.execute({ inputData: MONTHLY_QUERY_INPUT })).resolves.toEqual({
      value: null,
    });
    await expect(queryRankStep.execute({ inputData: MONTHLY_QUERY_INPUT })).resolves.toEqual({
      value: null,
    });
    await expect(queryInventoryStep.execute({ inputData: MONTHLY_QUERY_INPUT })).resolves.toEqual({
      value: null,
    });
  });
});

describe('切片 12 §9 第 2 / 4 / 6 / 11 步 — composeMonthlyReportStep', () => {
  function buildComposeArgs(over: {
    sales?: { current: unknown; previous: unknown; previousMissing: boolean };
    ratio?: { value: unknown };
    rank?: { value: unknown };
    inventory?: { value: unknown };
    init?: typeof MONTHLY_QUERY_INPUT;
  } = {}): {
    inputData: Record<string, unknown>;
    getInitData: () => typeof MONTHLY_QUERY_INPUT;
  } {
    return {
      inputData: {
        'query-sales-summary-monthly':
          over.sales ?? { current: SALES_SUMMARY, previous: { totalSales: 1110 }, previousMissing: false },
        'query-category-ratio-monthly': over.ratio ?? { value: CATEGORY_RATIO },
        'query-product-rank-monthly': over.rank ?? { value: PRODUCT_RANK },
        'query-inventory-overview-monthly': over.inventory ?? { value: INVENTORY },
      },
      getInitData: () => over.init ?? MONTHLY_QUERY_INPUT,
    };
  }

  it('happy → reportType=MONTHLY，dataSourceSummary.tools=4/missing=[]', async () => {
    composeMarkdownMock.mockResolvedValue(HAPPY_MONTHLY_COMPOSE);
    const out = (await composeMonthlyReportStep.execute(buildComposeArgs())) as Record<
      string,
      unknown
    >;
    expect(out.reportType).toBe('MONTHLY');
    const ds = out.dataSourceSummary as { tools: string[]; missing: string[] };
    expect(ds.tools).toEqual([
      'queryStoreSalesSummary',
      'queryCategorySalesRatio',
      'queryProductSalesRank',
      'queryInventoryOverview',
    ]);
    expect(ds.missing).toEqual([]);
  });

  it('partial missing：库存返空 → missing=["queryInventoryOverview"]', async () => {
    // 库存工具缺失时 markdown 不能包含 lowStockSkuCount / deadStockSkuCount 派生数字
    const PARTIAL_MONTHLY_MARKDOWN = [
      '# 2026-05-01 至 2026-05-31 经营月报',
      '',
      '## 本月概览',
      '本月销售额 1250 元，共 25 单，客单价 50 元；上月销售额 1110 元，环比 12.61%。',
      '## 环比分析',
      '本月较上月增长 12.61%。',
      '## 品类结构与商品 Top/滞销',
      '饮料品类占比 40%；商品 A 销售 500 元。',
      '## 库存风险',
      '该指标暂无数据（来源：queryInventoryOverview 失败）。',
      '## 下月建议',
      '加强饮料品类铺货。',
      '## 数据来源',
      '- 12.61% = (1250 - 1110) / 1110',
      '- 40% = 0.4',
    ].join('\n');
    composeMarkdownMock.mockResolvedValue({
      markdown: PARTIAL_MONTHLY_MARKDOWN,
      cards: [{ key: 'total_sales', value: 1250 }],
      abnormal: [],
    });
    const out = (await composeMonthlyReportStep.execute(
      buildComposeArgs({ inventory: { value: null } }),
    )) as Record<string, unknown>;
    const ds = out.dataSourceSummary as { tools: string[]; missing: string[] };
    expect(ds.missing).toEqual(['queryInventoryOverview']);
    expect(ds.tools).toEqual([
      'queryStoreSalesSummary',
      'queryCategorySalesRatio',
      'queryProductSalesRank',
    ]);
    expect(out.summaryMarkdown).toContain('该指标暂无数据');
  });

  it('全部 4 个工具失败 → BizError(MCP_UNAVAILABLE)', async () => {
    composeMarkdownMock.mockResolvedValue(HAPPY_MONTHLY_COMPOSE);
    await expect(
      composeMonthlyReportStep.execute(
        buildComposeArgs({
          sales: { current: null, previous: null, previousMissing: true },
          ratio: { value: null },
          rank: { value: null },
          inventory: { value: null },
        }),
      ),
    ).rejects.toMatchObject({ code: 'MCP_UNAVAILABLE' });
    expect(composeMarkdownMock).not.toHaveBeenCalled();
  });

  it('schema 首次失败 → 重试后成功；retry=true 透传到 prompt', async () => {
    composeMarkdownMock
      .mockResolvedValueOnce({ markdown: '太短', cards: [], abnormal: [] })
      .mockResolvedValueOnce(HAPPY_MONTHLY_COMPOSE);
    const out = (await composeMonthlyReportStep.execute(buildComposeArgs())) as Record<
      string,
      unknown
    >;
    expect(out.reportType).toBe('MONTHLY');
    expect(composeMarkdownMock).toHaveBeenCalledTimes(2);
    expect(
      (composeMarkdownMock.mock.calls[1]?.[0] as { template: string }).template,
    ).toContain('重试生成');
  });

  it('数字伪造两次 → BizError(NUMBER_INCONSISTENT)，月报拒发', async () => {
    composeMarkdownMock
      .mockResolvedValueOnce({
        markdown: [
          '# 2026-05-01 至 2026-05-31 经营月报',
          '',
          '## 本月概览',
          '本月销售额 9999 元，共 25 单，客单价 50 元。',
          '## 环比分析',
          '本月经营表现稳定，继续观察核心品类变化和库存压力。',
          '## 下月建议',
          '加强饮料品类铺货。',
          '## 数据来源',
        ].join('\n'),
        cards: [{ key: 'total_sales', value: 9999 }],
        abnormal: [],
      })
      .mockResolvedValueOnce({
        markdown: [
          '# 2026-05-01 至 2026-05-31 经营月报',
          '',
          '## 本月概览',
          '本月销售额 8888 元，共 25 单，客单价 50 元。',
          '## 环比分析',
          '本月经营表现稳定，继续观察核心品类变化和库存压力。',
          '## 下月建议',
          '加强饮料品类铺货。',
          '## 数据来源',
        ].join('\n'),
        cards: [{ key: 'total_sales', value: 8888 }],
        abnormal: [],
      });

    await expect(composeMonthlyReportStep.execute(buildComposeArgs())).rejects.toMatchObject({
      code: 'NUMBER_INCONSISTENT',
    });
    expect(composeMarkdownMock).toHaveBeenCalledTimes(2);
  });

  it('模糊数字措辞两次 → BizError(SCHEMA_FAIL)，月报拒发', async () => {
    composeMarkdownMock
      .mockResolvedValueOnce({
        markdown: [
          '# 2026-05-01 至 2026-05-31 经营月报',
          '',
          '## 本月概览',
          '本月约 1250 元销售额，共 25 单，客单价 50 元。',
          '## 下月建议',
          '加强饮料品类铺货。',
          '## 数据来源',
        ].join('\n'),
        cards: [{ key: 'total_sales', value: 1250 }],
        abnormal: [],
      })
      .mockResolvedValueOnce({
        markdown: [
          '# 2026-05-01 至 2026-05-31 经营月报',
          '',
          '## 本月概览',
          '本月大概 1250 元销售额，共 25 单，客单价 50 元。',
          '## 下月建议',
          '加强饮料品类铺货。',
          '## 数据来源',
        ].join('\n'),
        cards: [{ key: 'total_sales', value: 1250 }],
        abnormal: [],
      });

    await expect(composeMonthlyReportStep.execute(buildComposeArgs())).rejects.toMatchObject({
      code: 'SCHEMA_FAIL',
    });
    expect(composeMarkdownMock).toHaveBeenCalledTimes(2);
  });

  it('schema 两次失败 → BizError(SCHEMA_FAIL)，不是裸 ZodError', async () => {
    composeMarkdownMock
      .mockResolvedValueOnce({ markdown: '太短', cards: [], abnormal: [] })
      .mockResolvedValueOnce({ markdown: '仍然太短', cards: [], abnormal: [] });
    await expect(composeMonthlyReportStep.execute(buildComposeArgs())).rejects.toMatchObject({
      code: 'SCHEMA_FAIL',
    });
    expect(composeMarkdownMock).toHaveBeenCalledTimes(2);
  });

  it('composeMarkdown 两次抛出结构化生成错误 → 用 MCP 数据生成模板月报兜底，不降级成系统忙', async () => {
    composeMarkdownMock
      .mockRejectedValueOnce(new Error('No object generated: response did not match schema.'))
      .mockRejectedValueOnce(new Error('No object generated: response did not match schema.'));

    const out = (await composeMonthlyReportStep.execute(buildComposeArgs())) as Record<
      string,
      unknown
    >;

    expect(out.reportType).toBe('MONTHLY');
    expect(out.summaryMarkdown).toContain('经营月报');
    expect(out.summaryMarkdown).toContain('## 数据来源');
    expect(out.summaryMarkdown).toContain('1250');
    expect(out.summaryMarkdown).not.toContain('系统忙');
    expect(composeMarkdownMock).toHaveBeenCalledTimes(2);
  });
});

// ====================== 死锁/异常护栏 ======================

describe('切片 12 §11 自检 — mergeStrategy 失败必须立即冒泡', () => {
  it('mergeStrategy 抛错 → 不触发 mcpTools / composeMarkdown', async () => {
    mergeStrategyMock.mockRejectedValueOnce(new Error('strategy-loader-down'));
    await expect(
      generateDailyReportStep.execute({
        inputData: { merchantId: 'M001', storeId: 'S001', date: '2026-05-07' },
      }),
    ).rejects.toThrow('strategy-loader-down');
    expect(mcpToolsMock).not.toHaveBeenCalled();
    expect(composeMarkdownMock).not.toHaveBeenCalled();
  });
});

// 守门：BizError 类型一致性（避免 throw new Error 导致下游 ErrorCode 丢失）
describe('守门：抛出错误为 BizError 实例', () => {
  it('全工具失败抛出的是 BizError 实例（含 code 字段）', async () => {
    mcpToolsMock.mockResolvedValue(
      buildDailyTools({
        failTools: [
          'getStoreReportConfig',
          'queryStoreSalesSummary',
          'queryCategorySalesRatio',
          'queryProductSalesRank',
          'queryInventoryOverview',
        ],
      }),
    );
    await expect(
      generateDailyReportStep.execute({
        inputData: { merchantId: 'M001', storeId: 'S001', date: '2026-05-07' },
      }),
    ).rejects.toBeInstanceOf(BizError);
  });
});
