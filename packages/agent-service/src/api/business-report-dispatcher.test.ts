import { Intent } from '@storepilot/shared-contracts';
import argon2 from 'argon2';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiKeyRow, AuthPool } from '../bridge/auth.js';
import type { AgentBundle } from '../mastra/agents/index.js';
import type { DispatchArgs } from './chat-completions.js';

const TEST_API_KEY_HASH_SALT = 'salt-abcdef-1234';

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
  AGENT_API_KEY_HASH_SALT: TEST_API_KEY_HASH_SALT,
  AGENT_API_KEY_PREFIX: 'sk-agent-',
  CORS_ALLOWED_ORIGINS: 'http://localhost:3210',
};

for (const [key, value] of Object.entries(ENV_FIXTURE)) vi.stubEnv(key, value);

vi.mock('../mastra/agents/index.js', () => ({
  generalQa: { generate: vi.fn() },
  requirementCollector: { generate: vi.fn() },
  createAgentBundle: vi.fn(),
}));

vi.mock('../mastra/agents/intent-classifier.js', () => ({
  classifyIntent: vi.fn(),
}));

vi.mock('../mastra/workflows/business-daily-report.js', () => ({
  generateDailyReportStep: { execute: vi.fn() },
}));

vi.mock('../mastra/workflows/business-monthly-report.js', () => ({
  prepareMonthlyInputStep: { execute: vi.fn() },
  querySalesStep: { execute: vi.fn() },
  queryRatioStep: { execute: vi.fn() },
  queryRankStep: { execute: vi.fn() },
  queryInventoryStep: { execute: vi.fn() },
  composeMonthlyReportStep: { execute: vi.fn() },
}));

vi.mock('../mastra/workflows/replenishment-forecast.js', () => ({
  computeStep: { execute: vi.fn() },
  persistDraftStep: { execute: vi.fn() },
}));

vi.mock('../mastra/workflows/replenishment-adjustment.js', () => ({
  loadActiveDraftStep: { execute: vi.fn() },
  extractInstructionStep: { execute: vi.fn() },
  applyInstructionStep: { execute: vi.fn() },
  persistAdjustmentStep: { execute: vi.fn() },
}));

vi.mock('../safety/confirm-manager.js', () => ({
  cancelInflight: vi.fn(),
  confirmDraft: vi.fn(),
}));

vi.mock('../safety/draft-manager.js', () => ({
  findRecentDraft: vi.fn(),
}));

const { classifyIntent } = await import('../mastra/agents/intent-classifier.js');
const { generateDailyReportStep } = await import('../mastra/workflows/business-daily-report.js');
const {
  prepareMonthlyInputStep,
  querySalesStep,
  queryRatioStep,
  queryRankStep,
  queryInventoryStep,
  composeMonthlyReportStep,
} = await import('../mastra/workflows/business-monthly-report.js');
const { computeStep, persistDraftStep } = await import(
  '../mastra/workflows/replenishment-forecast.js'
);
const {
  loadActiveDraftStep,
  extractInstructionStep,
  applyInstructionStep,
  persistAdjustmentStep,
} = await import('../mastra/workflows/replenishment-adjustment.js');
const { createBusinessReportDispatcher } = await import('./business-report-dispatcher.js');
const {
  chatCompletionsRouter,
  resetDispatcherForTest,
  setDispatcher,
} = await import('./chat-completions.js');
const { cancelInflight, confirmDraft } = await import('../safety/confirm-manager.js');
const { findRecentDraft } = await import('../safety/draft-manager.js');
const {
  API_KEY_PREFIX_LENGTH,
  resetAuthPoolForTest,
  setAuthPool,
} = await import('../bridge/auth.js');
const { setSkillRegistry } = await import('../mastra/agents/skill-registry.js');

const classifyIntentMock = vi.mocked(classifyIntent);
const dailyExecuteMock = vi.mocked(generateDailyReportStep.execute);
const prepareMonthlyMock = vi.mocked(prepareMonthlyInputStep.execute);
const querySalesMock = vi.mocked(querySalesStep.execute);
const queryRatioMock = vi.mocked(queryRatioStep.execute);
const queryRankMock = vi.mocked(queryRankStep.execute);
const queryInventoryMock = vi.mocked(queryInventoryStep.execute);
const composeMonthlyMock = vi.mocked(composeMonthlyReportStep.execute);
const replenishmentComputeMock = vi.mocked(computeStep.execute);
const replenishmentPersistMock = vi.mocked(persistDraftStep.execute);
const adjustmentLoadMock = vi.mocked(loadActiveDraftStep.execute);
const adjustmentExtractMock = vi.mocked(extractInstructionStep.execute);
const adjustmentApplyMock = vi.mocked(applyInstructionStep.execute);
const adjustmentPersistMock = vi.mocked(persistAdjustmentStep.execute);
const cancelInflightMock = vi.mocked(cancelInflight);
const confirmDraftMock = vi.mocked(confirmDraft);
const findRecentDraftMock = vi.mocked(findRecentDraft);

interface RuntimeContextLike {
  get(key: string): unknown;
}

type DispatcherAgentsForTest = Pick<AgentBundle, 'generalQa' | 'requirementCollector'>;

function expectTenantRuntimeContext(value: unknown): asserts value is RuntimeContextLike {
  expect(typeof value).toBe('object');
  expect(value).not.toBeNull();
  expect(typeof (value as { get?: unknown }).get).toBe('function');
  const ctx = value as RuntimeContextLike;
  expect(ctx.get('sessionId')).toBe('sess_01HZ000000000000000000');
  expect(ctx.get('merchantId')).toBe('M001');
  expect(ctx.get('storeId')).toBe('S001');
  expect(ctx.get('userId')).toBe('boss-001');
  expect(ctx.get('apiKeyPrefix')).toBe('sk-agent-test');
}

class FakeAuthPool implements AuthPool {
  public readonly rows = new Map<number, ApiKeyRow & { last_used_at: Date | null }>();

  insert(row: ApiKeyRow & { last_used_at?: Date | null }): void {
    this.rows.set(row.id, { ...row, last_used_at: row.last_used_at ?? null });
  }

  query<T extends Record<string, unknown>>(
    sql: string,
    params: readonly unknown[],
  ): Promise<[T[], unknown]> {
    const norm = sql.replace(/\s+/g, ' ').trim();
    if (
      /SELECT .* FROM agent_api_key WHERE api_key_prefix = \? AND status = 'ENABLED'/i.test(norm)
    ) {
      const prefix = params[0];
      const rows: ApiKeyRow[] = [];
      for (const row of this.rows.values()) {
        if (row.api_key_prefix === prefix && row.status === 'ENABLED') {
          rows.push({
            id: row.id,
            api_key_hash: row.api_key_hash,
            api_key_prefix: row.api_key_prefix,
            merchant_id: row.merchant_id,
            store_id: row.store_id,
            user_id: row.user_id,
            status: row.status,
            expires_at: row.expires_at,
          });
        }
      }
      return Promise.resolve([rows as unknown as T[], undefined]);
    }
    throw new Error(`FakeAuthPool: 未识别的 query SQL: ${norm}`);
  }

  execute(sql: string, params: readonly unknown[]): Promise<[{ affectedRows: number }, unknown]> {
    void sql;
    void params;
    return Promise.resolve([{ affectedRows: 0 }, undefined]);
  }
}

const PLAINTEXT_API_KEY = 'sk-agent-test1234567890abcdefghijklmnopqrstuvwxyz0';
const VALID_AUTH_HEADER = `Bearer ${PLAINTEXT_API_KEY}`;

function buildSseApp(): Hono {
  const app = new Hono();
  app.route('/v1', chatCompletionsRouter);
  return app;
}

async function seedValidKey(pool: FakeAuthPool): Promise<void> {
  const hash = await argon2.hash(PLAINTEXT_API_KEY, {
    type: argon2.argon2id,
    secret: Buffer.from(TEST_API_KEY_HASH_SALT),
  });
  pool.insert({
    id: 1,
    api_key_hash: hash,
    api_key_prefix: PLAINTEXT_API_KEY.slice(0, API_KEY_PREFIX_LENGTH),
    merchant_id: 'M001',
    store_id: 'S001',
    user_id: 'boss-001',
    status: 'ENABLED',
    expires_at: null,
  });
}

function buildArgs(message: string): DispatchArgs {
  return {
    body: {
      model: 'store-agent-v1',
      stream: true,
      messages: [{ role: 'user', content: message }],
    },
    auth: {
      ok: true,
      merchantId: 'M001',
      storeId: 'S001',
      userId: 'boss-001',
      apiKeyPrefix: 'sk-agent-test',
    },
    sessionId: 'sess_01HZ000000000000000000',
    traceId: 'trace_01HZ00000000000000000000',
    abortSignal: new AbortController().signal,
  };
}

function buildSseRequest(message: string): Request {
  return new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: VALID_AUTH_HEADER,
      'Content-Type': 'application/json',
      'X-Trace-Id': 'trace_01HZ00000000000000000000',
    },
    body: JSON.stringify({
      model: 'store-agent-v1',
      stream: true,
      messages: [{ role: 'user', content: message }],
    }),
  });
}

async function collectSseContent(res: Response): Promise<string> {
  expect(res.body).toBeTruthy();
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const chunks: string[] = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLines = block
        .split(/\r\n|\r|\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim());
      const data = dataLines.join('\n');
      if (data === '[DONE]' || !data.startsWith('{')) continue;
      const payload = JSON.parse(data) as {
        choices: Array<{ delta: { content?: string } }>;
      };
      const content = payload.choices[0]?.delta.content;
      if (content !== undefined) chunks.push(content);
    }
  }

  return chunks.join('');
}

describe('business-report-dispatcher', () => {
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetAuthPoolForTest();
    resetDispatcherForTest();
    setSkillRegistry(null);
  });

  it('BUSINESS_DAILY_REPORT → 调日报 step，并把 markdown/cards/dataSourceSummary 写入 finalText', async () => {
    classifyIntentMock.mockResolvedValue({
      intent: Intent.BUSINESS_DAILY_REPORT,
      confidence: 0.95,
      reason: 'daily',
    });
    dailyExecuteMock.mockResolvedValue({
      reportType: 'DAILY',
      summaryMarkdown: '# 2026-05-07 经营日报\n\n销售额 1250 元。\n\n## 数据来源',
      cards: [{ key: 'total_sales', value: 1250 }],
      abnormalInsights: [],
      dataSourceSummary: { tools: ['queryStoreSalesSummary'], elapsedMs: 12, missing: [] },
    });

    const dispatcher = createBusinessReportDispatcher({
      now: () => new Date('2026-05-07T01:00:00.000Z'),
    });
    const result = await dispatcher(buildArgs('今天 S001 卖得怎么样'));

    expect(dailyExecuteMock).toHaveBeenCalledWith({
      inputData: { merchantId: 'M001', storeId: 'S001', date: '2026-05-07' },
    });
    expect(result.finalText).toContain('# 2026-05-07 经营日报');
    expect(result.finalText).toContain('## 指标卡片');
    expect(result.finalText).toContain('total_sales: 1250');
    expect(result.finalText).toContain('## 数据源摘要');
    expect(result.finalText).toContain('queryStoreSalesSummary');
  });

  it('GENERAL_QA → 使用注入的 generalQa 并把 agentId=generalQa 写入 RuntimeContext', async () => {
    classifyIntentMock.mockResolvedValue({
      intent: Intent.GENERAL_QA,
      confidence: 0.95,
      reason: 'general',
    });
    const injectedGeneralQa = {
      generate: vi.fn().mockResolvedValue({ text: '注入实例回答' }),
    };
    const defaultGeneralQa = await import('../mastra/agents/index.js').then((m) => m.generalQa);

    const dispatcher = createBusinessReportDispatcher({
      agents: {
        generalQa: injectedGeneralQa,
        requirementCollector: { generate: vi.fn() },
      } as unknown as DispatcherAgentsForTest,
    });
    const result = await dispatcher(buildArgs('毛利率是什么意思'));

    expect(result.finalText).toBe('注入实例回答');
    expect(injectedGeneralQa.generate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(defaultGeneralQa.generate)).not.toHaveBeenCalled();
    const call = injectedGeneralQa.generate.mock.calls[0]?.[1] as {
      requestContext: RuntimeContextLike;
    };
    expectTenantRuntimeContext(call.requestContext);
    expect(call.requestContext.get('agentId')).toBe('generalQa');
  });

  it('COLLECT_REQUIREMENT → 使用注入的 requirementCollector 且不写入 agentId', async () => {
    classifyIntentMock.mockResolvedValue({
      intent: Intent.COLLECT_REQUIREMENT,
      confidence: 0.95,
      reason: 'requirement',
    });
    const injectedRequirementCollector = {
      generate: vi.fn().mockResolvedValue({ text: '已收到' }),
    };

    const dispatcher = createBusinessReportDispatcher({
      agents: {
        generalQa: { generate: vi.fn() },
        requirementCollector: injectedRequirementCollector,
      } as unknown as DispatcherAgentsForTest,
    });
    const result = await dispatcher(buildArgs('我想要会员积分功能'));

    expect(result.finalText).toBe('已收到');
    const call = injectedRequirementCollector.generate.mock.calls[0]?.[1] as {
      requestContext: RuntimeContextLike;
    };
    expectTenantRuntimeContext(call.requestContext);
    expect(call.requestContext.get('agentId')).toBeUndefined();
  });

  it('BUSINESS_MONTHLY_REPORT → 并行执行 4 query step 后 compose，输出完整 markdown/cards/dataSourceSummary', async () => {
    classifyIntentMock.mockResolvedValue({
      intent: Intent.BUSINESS_MONTHLY_REPORT,
      confidence: 0.95,
      reason: 'monthly',
    });
    const prepared = {
      merchantId: 'M001',
      storeId: 'S001',
      month: '2026-05',
      reportPolicy: { maxSummaryChars: 8000, maxCards: 12 },
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      prevStartDate: '2026-04-01',
      prevEndDate: '2026-04-30',
    };
    prepareMonthlyMock.mockResolvedValue(prepared);
    querySalesMock.mockResolvedValue({
      current: { totalSales: 1250 },
      previous: { totalSales: 1110 },
      previousMissing: false,
    });
    queryRatioMock.mockResolvedValue({ value: { categories: [] } });
    queryRankMock.mockResolvedValue({ value: { products: [] } });
    queryInventoryMock.mockResolvedValue({ value: { lowStockSkuCount: 3 } });
    const monthlyWorkflowOutput = {
      reportType: 'MONTHLY' as const,
      summaryMarkdown: '# 2026-05 经营月报\n\n## 下月建议\n继续优化。\n\n## 数据来源',
      cards: [{ key: 'total_sales', value: 1250 }],
      abnormalInsights: ['低库存 SKU 3 个'],
      dataSourceSummary: { tools: ['queryStoreSalesSummary'], elapsedMs: 20, missing: [] },
    };
    composeMonthlyMock.mockResolvedValue(monthlyWorkflowOutput);

    const dispatcher = createBusinessReportDispatcher({
      now: () => new Date('2026-05-07T01:00:00.000Z'),
    });
    const result = await dispatcher(buildArgs('看一下本月月报'));

    expect(prepareMonthlyMock).toHaveBeenCalledWith({
      inputData: { merchantId: 'M001', storeId: 'S001', month: '2026-05' },
    });
    expect(querySalesMock).toHaveBeenCalledWith({ inputData: prepared });
    const composeCall = composeMonthlyMock.mock.calls[0]?.[0] as {
      inputData: Record<string, unknown>;
      getInitData: () => unknown;
    };
    expect(composeCall.inputData).toEqual({
      'query-sales-summary-monthly': {
        current: { totalSales: 1250 },
        previous: { totalSales: 1110 },
        previousMissing: false,
      },
      'query-category-ratio-monthly': { value: { categories: [] } },
      'query-product-rank-monthly': { value: { products: [] } },
      'query-inventory-overview-monthly': { value: { lowStockSkuCount: 3 } },
    });
    expect(composeCall.getInitData()).toBe(prepared);
    expect(result.finalText).toContain('# 2026-05 经营月报');
    expect(result.finalText).toContain('## 异常洞察');
    expect(result.finalText).toContain('低库存 SKU 3 个');
    expect(result.finalText).toContain('## 数据源摘要');
  });

  it('REPLENISHMENT_PLAN → 接通切片 14 compute/persist workflow，并用 RuntimeContext 生成草稿', async () => {
    classifyIntentMock.mockResolvedValue({
      intent: Intent.REPLENISHMENT_PLAN,
      confidence: 0.95,
      reason: 'replenishment',
    });
    const computed = {
      items: [{ skuId: 'SKU_WATER', finalSuggestQty: 48, reason: '近 7 日均销 5' }],
      strategyVersion: 'M0-S0-P1',
      strategyDegraded: false,
      forecastDays: 7,
      contextFactors: { isHolidayUpcoming: false },
      allowedNumbersList: ['5', '7', '48'],
    };
    replenishmentComputeMock.mockResolvedValue(computed);
    replenishmentPersistMock.mockResolvedValue({
      draftId: 'drf_abcdefghijklmnop',
      status: 'DRAFT',
      summaryMarkdown: '# 补货建议\n\n矿泉水 建议 48 瓶。\n\n## 数据来源\n48 = 48',
      cards: [{ key: 'total_suggest_qty', value: 48 }],
      abnormalInsights: [],
      items: [],
      strategyVersion: 'M0-S0-P1',
      forecastDays: 7,
      dataSourceSummary: { tools: ['queryReplenishmentBaseData'], elapsedMs: 15 },
    });

    const dispatcher = createBusinessReportDispatcher();
    const result = await dispatcher(buildArgs('算一份 7 天补货'));

    expect(replenishmentComputeMock).toHaveBeenCalledWith({
      inputData: { merchantId: 'M001', storeId: 'S001', forecastDays: 7 },
    });
    const persistCall = replenishmentPersistMock.mock.calls[0]?.[0] as {
      inputData: unknown;
      requestContext: unknown;
    };
    expect(persistCall.inputData).toBe(computed);
    expectTenantRuntimeContext(persistCall.requestContext);
    expect(result.finalText).toContain('# 补货建议');
    expect(result.finalText).toContain('total_suggest_qty: 48');
    expect(result.finalText).toContain('queryReplenishmentBaseData');
  });

  it('CONFIRM_CREATE_PURCHASE_ORDER → 找到最近草稿后调用 ConfirmManager.confirmDraft resume HITL', async () => {
    classifyIntentMock.mockResolvedValue({
      intent: Intent.CONFIRM_CREATE_PURCHASE_ORDER,
      confidence: 0.95,
      reason: 'confirm-po',
    });
    findRecentDraftMock.mockResolvedValue([
      {
        draftId: 'drf_confirm_aaaaaaaaaaaa',
        sessionId: 'sess_01HZ000000000000000000',
        merchantId: 'M001',
        storeId: 'S001',
        userId: 'boss-001',
        traceId: 'trace_seed',
        forecastDays: 7,
        status: 'WAIT_CONFIRM',
        items: [],
        strategyVersion: 'M0-S0-P1',
        submittedPoNo: null,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    confirmDraftMock.mockResolvedValue({
      kind: 'CONFIRMED',
      result: { purchaseOrderNo: 'PO_CONFIRM_000001' },
    });

    const dispatcher = createBusinessReportDispatcher();
    const result = await dispatcher(buildArgs('确认生成采购单'));

    expect(confirmDraftMock).toHaveBeenCalledTimes(1);
    const call = confirmDraftMock.mock.calls[0]?.[0] as {
      draftId: string;
      runtimeContext: unknown;
    };
    expect(call.draftId).toBe('drf_confirm_aaaaaaaaaaaa');
    expectTenantRuntimeContext(call.runtimeContext);
    expect(result.finalText).toContain('PO_CONFIRM_000001');
    expect(result.finalText).not.toContain('由切片 17 完整化');
  });

  it('CONFIRM_CREATE_PURCHASE_ORDER → 无 active run 时返回 purchase_order_create preview/suspend 预览', async () => {
    classifyIntentMock.mockResolvedValue({
      intent: Intent.CONFIRM_CREATE_PURCHASE_ORDER,
      confidence: 0.95,
      reason: 'confirm-po',
    });
    findRecentDraftMock.mockResolvedValue([
      {
        draftId: 'drf_preview_aaaaaaaaaaaa',
        sessionId: 'sess_01HZ000000000000000000',
        merchantId: 'M001',
        storeId: 'S001',
        userId: 'boss-001',
        traceId: 'trace_seed',
        forecastDays: 7,
        status: 'WAIT_CONFIRM',
        items: [],
        strategyVersion: 'M0-S0-P1',
        submittedPoNo: null,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    confirmDraftMock.mockResolvedValue({
      kind: 'PREVIEW_FIRST',
      preview: '# 采购单确认\n\n请回复"确认"以创建采购单，或"取消"以放弃。',
    });

    const dispatcher = createBusinessReportDispatcher();
    const result = await dispatcher(buildArgs('确认生成采购单'));

    expect(confirmDraftMock).toHaveBeenCalledTimes(1);
    expect(result.finalText).toContain('# 采购单确认');
    expect(result.finalText).toContain('请回复"确认"以创建采购单');
    expect(result.finalText).not.toBe('请先回复"确认"以创建采购单');
  });

  it('CANCEL_REPLENISHMENT_DRAFT → 调 ConfirmManager.cancelInflight(USER_CANCEL)', async () => {
    classifyIntentMock.mockResolvedValue({
      intent: Intent.CANCEL_REPLENISHMENT_DRAFT,
      confidence: 0.95,
      reason: 'cancel',
    });
    cancelInflightMock.mockResolvedValue(undefined);

    const dispatcher = createBusinessReportDispatcher();
    const result = await dispatcher(buildArgs('取消'));

    expect(cancelInflightMock).toHaveBeenCalledWith({
      sessionId: 'sess_01HZ000000000000000000',
      reason: 'USER_CANCEL',
    });
    expect(result.finalText).toContain('已为您取消');
  });

  it('CANCEL_REPLENISHMENT_DRAFT → 即使 purchase_order_create 灰度关闭也允许取消本地草稿/确认态', async () => {
    const { createInMemorySkillRegistry, setSkillRegistry } = await import(
      '../mastra/agents/skill-registry.js'
    );
    setSkillRegistry(
      createInMemorySkillRegistry([
        {
          skillCode: 'purchase_order_create',
          status: 'gray',
          riskLevel: 'HIGH',
          version: '1.0.0',
        },
      ]),
    );
    classifyIntentMock.mockResolvedValue({
      intent: Intent.CANCEL_REPLENISHMENT_DRAFT,
      confidence: 0.95,
      reason: 'cancel',
    });
    cancelInflightMock.mockResolvedValue(undefined);

    const dispatcher = createBusinessReportDispatcher();
    const result = await dispatcher(buildArgs('取消'));

    expect(cancelInflightMock).toHaveBeenCalledWith({
      sessionId: 'sess_01HZ000000000000000000',
      reason: 'USER_CANCEL',
    });
    expect(result.finalText).toContain('已为您取消');
    expect(result.finalText).not.toContain('暂未开放');
    setSkillRegistry(null);
  });

  it('ADJUST_REPLENISHMENT_DRAFT → 串接切片 15 调整 workflow steps 并返回调整 markdown', async () => {
    classifyIntentMock.mockResolvedValue({
      intent: Intent.ADJUST_REPLENISHMENT_DRAFT,
      confidence: 0.95,
      reason: 'adjust',
    });
    const loaded = {
      draftId: 'drf_01',
      status: 'DRAFT',
      forecastDays: 7,
      strategyVersion: 'P1-M0-S0',
      maxAdjustmentsPerDraft: 5,
      currentAdjustmentCount: 0,
      items: [],
      sessionId: 'sess_01HZ000000000000000000',
      userMessage: '调整矿泉水上调 20%',
    };
    const extracted = { ...loaded, instruction: { targetValue: '矿泉水' } };
    const applied = {
      ...extracted,
      beforeItems: [],
      affectedSkuIds: ['SKU_WATER'],
      afterItems: [],
    };
    adjustmentLoadMock.mockResolvedValue(loaded);
    adjustmentExtractMock.mockResolvedValue(extracted);
    adjustmentApplyMock.mockResolvedValue(applied);
    adjustmentPersistMock.mockResolvedValue({
      draftId: 'drf_01',
      status: 'DRAFT',
      adjustmentId: 'adj_01',
      affectedSkuIds: ['SKU_WATER'],
      affectedCount: 1,
      remainingAdjustments: 4,
      summaryMarkdown: '# 补货调整结果\n\n## 影响的 SKU\n\n| SKU_WATER | 矿泉水 |',
      items: [],
    });

    const dispatcher = createBusinessReportDispatcher();
    const result = await dispatcher(buildArgs('调整矿泉水上调 20%'));

    expect(adjustmentLoadMock).toHaveBeenCalledWith({
      inputData: {
        sessionId: 'sess_01HZ000000000000000000',
        userMessage: '调整矿泉水上调 20%',
      },
      requestContext: expect.any(Object) as unknown,
    });
    expect(adjustmentExtractMock).toHaveBeenCalledWith({
      inputData: loaded,
      requestContext: expect.any(Object) as unknown,
    });
    expect(adjustmentApplyMock).toHaveBeenCalledWith({
      inputData: extracted,
      requestContext: expect.any(Object) as unknown,
    });
    expect(adjustmentPersistMock).toHaveBeenCalledWith({
      inputData: applied,
      requestContext: expect.any(Object) as unknown,
    });
    const adjustmentCalls = [
      adjustmentLoadMock.mock.calls[0]?.[0],
      adjustmentExtractMock.mock.calls[0]?.[0],
      adjustmentApplyMock.mock.calls[0]?.[0],
      adjustmentPersistMock.mock.calls[0]?.[0],
    ];
    for (const callArgs of adjustmentCalls) {
      expectTenantRuntimeContext((callArgs as { requestContext?: unknown })?.requestContext);
    }
    expect(result.finalText).toContain('# 补货调整结果');
    expect(result.finalText).toContain('SKU_WATER');
    expect(result.finalText).not.toContain('尚未完整接入');
  });

  it('SSE /v1/chat/completions → BUSINESS_DAILY_REPORT 输出 markdown/cards/dataSourceSummary', async () => {
    const pool = new FakeAuthPool();
    setAuthPool(pool);
    await seedValidKey(pool);
    classifyIntentMock.mockResolvedValue({
      intent: Intent.BUSINESS_DAILY_REPORT,
      confidence: 0.95,
      reason: 'daily',
    });
    dailyExecuteMock.mockResolvedValue({
      reportType: 'DAILY',
      summaryMarkdown: '# 2026-05-07 经营日报\n\n销售额 1250 元。\n\n## 数据来源',
      cards: [{ key: 'total_sales', value: 1250 }],
      abnormalInsights: [],
      dataSourceSummary: { tools: ['queryStoreSalesSummary'], elapsedMs: 12, missing: [] },
    });
    setDispatcher(
      createBusinessReportDispatcher({
        now: () => new Date('2026-05-07T01:00:00.000Z'),
      }),
    );

    const res = await buildSseApp().fetch(buildSseRequest('今天 S001 卖得怎么样'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');

    const content = await collectSseContent(res);
    expect(content).toContain('# 2026-05-07 经营日报');
    expect(content).toContain('## 指标卡片');
    expect(content).toContain('total_sales: 1250');
    expect(content).toContain('## 数据源摘要');
    expect(content).toContain('queryStoreSalesSummary');
  });

  it('SSE /v1/chat/completions → BUSINESS_MONTHLY_REPORT 输出月报 markdown/cards/abnormal/dataSourceSummary', async () => {
    const pool = new FakeAuthPool();
    setAuthPool(pool);
    await seedValidKey(pool);
    classifyIntentMock.mockResolvedValue({
      intent: Intent.BUSINESS_MONTHLY_REPORT,
      confidence: 0.95,
      reason: 'monthly',
    });
    const prepared = {
      merchantId: 'M001',
      storeId: 'S001',
      month: '2026-05',
      reportPolicy: { maxSummaryChars: 8000, maxCards: 12 },
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      prevStartDate: '2026-04-01',
      prevEndDate: '2026-04-30',
    };
    prepareMonthlyMock.mockResolvedValue(prepared);
    querySalesMock.mockResolvedValue({
      current: { totalSales: 1250 },
      previous: { totalSales: 1110 },
      previousMissing: false,
    });
    queryRatioMock.mockResolvedValue({ value: { categories: [] } });
    queryRankMock.mockResolvedValue({ value: { products: [] } });
    queryInventoryMock.mockResolvedValue({ value: { lowStockSkuCount: 3 } });
    composeMonthlyMock.mockResolvedValue({
      reportType: 'MONTHLY',
      summaryMarkdown: '# 2026-05 经营月报\n\n## 下月建议\n继续优化。\n\n## 数据来源',
      cards: [{ key: 'total_sales', value: 1250 }],
      abnormalInsights: ['低库存 SKU 3 个'],
      dataSourceSummary: { tools: ['queryStoreSalesSummary'], elapsedMs: 20, missing: [] },
    });
    setDispatcher(
      createBusinessReportDispatcher({
        now: () => new Date('2026-05-07T01:00:00.000Z'),
      }),
    );

    const res = await buildSseApp().fetch(buildSseRequest('看一下本月月报'));
    expect(res.status).toBe(200);

    const content = await collectSseContent(res);
    expect(content).toContain('# 2026-05 经营月报');
    expect(content).toContain('## 下月建议');
    expect(content).toContain('## 指标卡片');
    expect(content).toContain('## 异常洞察');
    expect(content).toContain('低库存 SKU 3 个');
    expect(content).toContain('## 数据源摘要');
  });

  it('SSE /v1/chat/completions → REPLENISHMENT_PLAN 输出补货草稿 markdown', async () => {
    const pool = new FakeAuthPool();
    setAuthPool(pool);
    await seedValidKey(pool);
    classifyIntentMock.mockResolvedValue({
      intent: Intent.REPLENISHMENT_PLAN,
      confidence: 0.95,
      reason: 'replenishment',
    });
    replenishmentComputeMock.mockResolvedValue({
      items: [{ skuId: 'SKU_WATER', finalSuggestQty: 48, reason: '近 7 日均销 5' }],
      strategyVersion: 'M0-S0-P1',
      strategyDegraded: false,
      forecastDays: 7,
      contextFactors: { isHolidayUpcoming: false },
      allowedNumbersList: ['5', '7', '48'],
    });
    replenishmentPersistMock.mockResolvedValue({
      draftId: 'drf_abcdefghijklmnop',
      status: 'DRAFT',
      summaryMarkdown: '# 补货建议\n\n矿泉水 建议 48 瓶。\n\n## 数据来源\n48 = 48',
      cards: [{ key: 'total_suggest_qty', value: 48 }],
      abnormalInsights: [],
      items: [],
      strategyVersion: 'M0-S0-P1',
      forecastDays: 7,
      dataSourceSummary: { tools: ['queryReplenishmentBaseData'], elapsedMs: 15 },
    });
    setDispatcher(createBusinessReportDispatcher());

    const res = await buildSseApp().fetch(buildSseRequest('算一份 7 天补货'));
    expect(res.status).toBe(200);

    const content = await collectSseContent(res);
    expect(content).toContain('# 补货建议');
    expect(content).toContain('矿泉水 建议 48 瓶');
    expect(content).toContain('total_suggest_qty: 48');
    expect(content).not.toContain('尚未完整接入桥接层');
  });

  it('SSE /v1/chat/completions → CONFIRM_CREATE_PURCHASE_ORDER resume 并返回 PO 号', async () => {
    const pool = new FakeAuthPool();
    setAuthPool(pool);
    await seedValidKey(pool);
    classifyIntentMock.mockResolvedValue({
      intent: Intent.CONFIRM_CREATE_PURCHASE_ORDER,
      confidence: 0.95,
      reason: 'confirm-po',
    });
    findRecentDraftMock.mockResolvedValue([
      {
        draftId: 'drf_confirm_aaaaaaaaaaaa',
        sessionId: 'sess_01HZ000000000000000000',
        merchantId: 'M001',
        storeId: 'S001',
        userId: 'boss-001',
        traceId: 'trace_seed',
        forecastDays: 7,
        status: 'WAIT_CONFIRM',
        items: [],
        strategyVersion: 'M0-S0-P1',
        submittedPoNo: null,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    confirmDraftMock.mockResolvedValue({
      kind: 'CONFIRMED',
      result: { purchaseOrderNo: 'PO_CONFIRM_000001' },
    });
    setDispatcher(createBusinessReportDispatcher());

    const res = await buildSseApp().fetch(buildSseRequest('确认生成采购单'));
    expect(res.status).toBe(200);

    const content = await collectSseContent(res);
    expect(confirmDraftMock).toHaveBeenCalledTimes(1);
    expect(content).toContain('PO_CONFIRM_000001');
    expect(content).not.toContain('由切片 17 完整化');
  });
});
