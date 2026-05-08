/**
 * 切片 14 §9 workflow 级验收测试（无真实 LLM / MySQL / MCP）。
 *
 * 覆盖：
 *   - computeStep：mergeStrategy + queryReplenishmentBaseData + computeSku 调用链。
 *   - persistDraftStep：DraftManager.create 结构化 draftItems，compose 事务外执行，validateOutput retry。
 *   - reason 非空率：100 SKU 样本 100% 非空。
 *   - 数字一致性：非法 markdown 数字触发 retry；二次非法拒发。
 *   - Mastra 1.0 tool.execute：禁止 `{ context: ... }` 包装 inputData。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { type DraftItem } from '@storepilot/shared-contracts';
import type { ReplenishmentBaseData } from '@storepilot/shared-contracts/mcp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildRuntimeContext } from '../runtime-context.js';

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
  NUMBER_CONSISTENCY_CHECK_ENABLED: 'true',
};

vi.mock('../../safety/strategy-engine.js', () => ({
  mergeStrategy: vi.fn(),
}));

vi.mock('../mcp/client.js', () => ({
  mcpTools: vi.fn(),
}));

vi.mock('../../safety/draft-manager.js', () => ({
  create: vi.fn(),
}));

vi.mock('../../skills/replenishment/compose-markdown.js', () => ({
  composeReplenishmentMarkdown: vi.fn(),
}));

let computeStep: { execute(args: Record<string, unknown>): Promise<unknown> };
let persistDraftStep: { execute(args: Record<string, unknown>): Promise<unknown> };

let mergeStrategyMock: ReturnType<typeof vi.fn>;
let mcpToolsMock: ReturnType<typeof vi.fn>;
let draftCreateMock: ReturnType<typeof vi.fn>;
let composeMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  for (const [key, value] of Object.entries(ENV_FIXTURE)) vi.stubEnv(key, value);

  ({ mergeStrategy: mergeStrategyMock } = (await import(
    '../../safety/strategy-engine.js'
  )) as unknown as { mergeStrategy: ReturnType<typeof vi.fn> });
  ({ mcpTools: mcpToolsMock } = (await import('../mcp/client.js')) as unknown as {
    mcpTools: ReturnType<typeof vi.fn>;
  });
  ({ create: draftCreateMock } = (await import(
    '../../safety/draft-manager.js'
  )) as unknown as { create: ReturnType<typeof vi.fn> });
  ({ composeReplenishmentMarkdown: composeMock } = (await import(
    '../../skills/replenishment/compose-markdown.js'
  )) as unknown as { composeReplenishmentMarkdown: ReturnType<typeof vi.fn> });

  const mod = await import('./replenishment-forecast.js');
  computeStep = mod.computeStep as unknown as typeof computeStep;
  persistDraftStep = mod.persistDraftStep as unknown as typeof persistDraftStep;
});

beforeEach(() => {
  vi.clearAllMocks();
  mergeStrategyMock.mockResolvedValue(strategyEntry({ forecastDays: 7, safetyStockDays: 2 }));
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('切片 14 — computeStep workflow 主路径', () => {
  it('按 Mastra 1.0 形态直接展开 tool inputData，并计算 100 SKU reason 非空率', async () => {
    const execute = vi.fn().mockResolvedValue(baseData(100, 5));
    mcpToolsMock.mockResolvedValue({ queryReplenishmentBaseData: { execute } });

    const out = (await computeStep.execute({
      inputData: { merchantId: 'M001', storeId: 'S001', forecastDays: 10 },
    })) as {
      items: Array<{ finalSuggestQty: number; reason: string }>;
      forecastDays: number;
      allowedNumbersList: string[];
    };

    expect(mergeStrategyMock).toHaveBeenCalledWith({ merchantId: 'M001', storeId: 'S001' });
    expect(execute).toHaveBeenCalledWith({
      merchantId: 'M001',
      storeId: 'S001',
      forecastDays: 7,
    });
    expect(execute.mock.calls[0]?.[0]).not.toHaveProperty('context');
    expect(out.forecastDays).toBe(7);
    expect(out.items).toHaveLength(100);
    expect(out.items.filter((it) => it.reason.length > 0)).toHaveLength(100);
    expect(out.allowedNumbersList).toContain('5');
    expect(out.allowedNumbersList).toContain(String(out.items[0]!.finalSuggestQty));
  });

  it('MCP 查询失败时映射为 MCP_UNAVAILABLE', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('mcp down'));
    mcpToolsMock.mockResolvedValue({ queryReplenishmentBaseData: { execute } });

    await expect(
      computeStep.execute({
        inputData: { merchantId: 'M001', storeId: 'S001' },
      }),
    ).rejects.toMatchObject({ code: 'MCP_UNAVAILABLE' });
  });
});

describe('切片 14 — persistDraftStep workflow 主路径', () => {
  it('落结构化 draftItems 后再事务外 compose，并返回 validated output', async () => {
    const inputData = computeOutput();
    draftCreateMock.mockResolvedValue(draftFrom(inputData.items.map(toDraftItem)));
    composeMock.mockResolvedValue(validCompose());

    const out = (await persistDraftStep.execute({
      inputData,
      requestContext: runtimeContext(),
    })) as { draftId: string; items: DraftItem[]; summaryMarkdown: string };

    expect(draftCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess_001',
        merchantId: 'M001',
        storeId: 'S001',
        userId: 'U001',
        traceId: 'trace_001',
        forecastDays: 7,
        items: inputData.items.map(toDraftItem),
        strategyVersion: 'M0-S0-P1',
      }),
    );
    expect(composeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        draftId: 'drf_abcdefghijklmnop',
        draftItems: inputData.items,
      }),
    );
    expect(draftCreateMock.mock.invocationCallOrder[0]).toBeLessThan(
      composeMock.mock.invocationCallOrder[0]!,
    );
    expect(out.items).toEqual(inputData.items.map(toDraftItem));
    expect(out.summaryMarkdown).toContain('建议 48 瓶');
  });

  it('首次 markdown 含非法数字时触发 retry，一次 retry 后成功', async () => {
    const inputData = computeOutput();
    draftCreateMock.mockResolvedValue(draftFrom(inputData.items.map(toDraftItem)));
    composeMock
      .mockResolvedValueOnce({
        markdown: '# 补货建议\n\n矿泉水 建议 9999 瓶。\n\n## 数据来源\n9999 = 9999',
        cards: [],
        abnormal: [],
      })
      .mockResolvedValueOnce(validCompose());

    const out = (await persistDraftStep.execute({
      inputData,
      requestContext: runtimeContext(),
    })) as { summaryMarkdown: string };

    expect(composeMock).toHaveBeenCalledTimes(2);
    const retryComposeInput = composeMock.mock.calls[1]?.[0] as unknown;
    expect(retryComposeInput).toMatchObject({ prompt: { retry: true } });
    expect(out.summaryMarkdown).toContain('建议 48 瓶');
  });

  it('二次 markdown 仍含非法数字时抛 NUMBER_INCONSISTENT', async () => {
    const inputData = computeOutput();
    draftCreateMock.mockResolvedValue(draftFrom(inputData.items.map(toDraftItem)));
    composeMock
      .mockResolvedValueOnce({
        markdown: '# 补货建议\n\n矿泉水 建议 9999 瓶。\n\n## 数据来源\n9999 = 9999',
        cards: [],
        abnormal: [],
      })
      .mockResolvedValueOnce({
        markdown: '# 补货建议\n\n矿泉水 建议 8888 瓶。\n\n## 数据来源\n8888 = 8888',
        cards: [],
        abnormal: [],
      });

    await expect(
      persistDraftStep.execute({
        inputData,
        requestContext: runtimeContext(),
      }),
    ).rejects.toMatchObject({ code: 'NUMBER_INCONSISTENT' });
    expect(composeMock).toHaveBeenCalledTimes(2);
  });
});

describe('切片 14 — 静态红线', () => {
  it('workflow 不调用 createPurchaseOrder，也不使用 Mastra 0.x context 包装 MCP input', () => {
    const src = readFileSync(
      fileURLToPath(import.meta.url).replace(/\.workflow\.test\.ts$/, '.ts'),
      'utf8',
    );
    const uncommented = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(uncommented).not.toMatch(/\bcreatePurchaseOrder\b/);
    expect(uncommented).not.toMatch(/queryReplenishmentBaseData\.execute\s*\(\s*\{\s*context\s*:/);
  });
});

function strategyEntry(args: { forecastDays: number; safetyStockDays: number }) {
  return {
    version: 'M0-S0-P1',
    degraded: false,
    merged: {
      enabledSkills: ['replenishment_forecast'],
      replenishmentPolicy: {
        forecastDays: args.forecastDays,
        safetyStockDays: args.safetyStockDays,
        requireConfirmBeforePurchaseOrder: true,
        allowAutoPurchaseOrder: false,
        forecastMethod: 'weighted_moving_average',
      },
      reportPolicy: {
        maxSummaryChars: 8000,
        maxCards: 12,
      },
      safetyPolicy: {
        requireUserConfirmForWrite: true,
        maxAdjustmentsPerDraft: 10,
        majorAdjustmentRatio: 0.5,
        draftAutoExpireMinutes: 30,
      },
    },
  };
}

function baseData(count: number, forecastDays: number): ReplenishmentBaseData {
  return {
    merchantId: 'M001',
    storeId: 'S001',
    forecastDays,
    contextFactors: { isHolidayUpcoming: false, weatherTrend: 'UNKNOWN' },
    items: Array.from({ length: count }, (_, i) => ({
      skuId: `SKU${String(i + 1).padStart(3, '0')}`,
      skuName: `测试 SKU ${i + 1}`,
      unit: '瓶',
      recentSalesByDay: [5, 5, 5, 5, 5, 5, 5],
      onHandQty: 0,
      inTransitQty: 0,
      leadTimeDays: 2,
      packSize: 1,
      category: '饮料',
    })),
  };
}

function computeOutput() {
  const items = [
    {
      skuId: 'SKU_WATER',
      skuName: '矿泉水',
      unit: '瓶',
      baseSuggestQty: 38,
      finalSuggestQty: 48,
      reason: '近 7/14/30 日均销 5/5/5，加权日均 5，节假日因子 1，公式建议 38，最终建议 48。',
      riskLevel: 'LOW' as const,
      adjustmentTrace: [],
    },
  ];
  return {
    items,
    strategyVersion: 'M0-S0-P1',
    strategyDegraded: false,
    forecastDays: 7,
    contextFactors: { isHolidayUpcoming: false },
    allowedNumbersList: ['0', '1', '5', '7', '38', '48'],
  };
}

function toDraftItem(it: (ReturnType<typeof computeOutput>['items'])[number]): DraftItem {
  return {
    skuId: it.skuId,
    skuName: it.skuName,
    unit: it.unit,
    baseSuggestQty: it.baseSuggestQty,
    finalSuggestQty: it.finalSuggestQty,
    reason: it.reason,
    adjustmentTrace: it.adjustmentTrace,
  };
}

function draftFrom(items: DraftItem[]) {
  return {
    draftId: 'drf_abcdefghijklmnop',
    sessionId: 'sess_001',
    merchantId: 'M001',
    storeId: 'S001',
    userId: 'U001',
    traceId: 'trace_001',
    forecastDays: 7,
    status: 'DRAFT',
    items,
    strategyVersion: 'M0-S0-P1',
    expiresAt: new Date('2026-05-07T01:30:00.000Z'),
    createdAt: new Date('2026-05-07T01:00:00.000Z'),
    updatedAt: new Date('2026-05-07T01:00:00.000Z'),
  };
}

function validCompose() {
  return {
    markdown: '# 补货建议\n\n矿泉水 建议 48 瓶。\n\n## 数据来源\n48 = 48',
    cards: [{ key: 'total_suggest_qty', value: 48 }],
    abnormal: [],
  };
}

function runtimeContext() {
  return buildRuntimeContext({
    traceId: 'trace_001',
    sessionId: 'sess_001',
    merchantId: 'M001',
    storeId: 'S001',
    userId: 'U001',
    apiKeyPrefix: 'sk-agent-test',
    requestStartedAt: Date.now(),
  });
}
