/**
 * 切片 15 §7 MUST DO §1 / §11 自检 — instruction-extractor 单测
 *
 * 覆盖：
 *   - assembleAdjustmentInstruction：核心字段 → 完整 AdjustmentInstruction 装配 + Zod 校验
 *   - normalizeRate / normalizeQty：op-aware 字段裁剪（避免无意义字段）
 *   - 空 targetValue / EXCLUDE op 通过 schema 校验
 *   - draftId / userMessage / adjustmentId 由本文件控制（不让 LLM 编造）
 *
 * LLM 调用本身用 vi.mock('ai') 跳过（与 compose-markdown 同模式），保证单测毫秒级跑完。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AdjustmentInstruction,
} from '@storepilot/shared-contracts';

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

vi.mock('ai', () => ({
  generateObject: vi.fn(),
}));
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => ({
    chat: vi.fn(() => ({ name: 'fake-model' })),
  })),
  openai: vi.fn(() => ({ name: 'fake-model' })),
}));

let extractAdjustmentInstruction: typeof import('./instruction-extractor.js')['extractAdjustmentInstruction'];
let testInternals: typeof import('./instruction-extractor.js')['__test_only__'];
let generateObjectMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV_FIXTURE)) vi.stubEnv(k, v);
  ({ generateObject: generateObjectMock } = (await import('ai')) as unknown as {
    generateObject: ReturnType<typeof vi.fn>;
  });
  ({ extractAdjustmentInstruction, __test_only__: testInternals } = await import(
    './instruction-extractor.js'
  ));
});

beforeEach(() => {
  generateObjectMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('assembleAdjustmentInstruction — 核心字段装配 + Zod 校验', () => {
  it('INCREASE_RATE：保留 rate，丢弃 qty', () => {
    const result = testInternals.assembleAdjustmentInstruction({
      core: {
        targetType: 'SKU_KEYWORD',
        targetValue: '矿泉水',
        adjustmentType: 'INCREASE_RATE',
        adjustmentRate: 0.2,
        adjustmentQty: 999, // 应被丢弃
        reason: '矿泉水上调 20%',
      },
      args: {
        userMessage: '矿泉水上调 20%',
        draftId: 'drf_aaaaaaaaaaaaaaaaaaaaaaaa',
        draftItemNames: ['SKU001 矿泉水'],
        now: () => '2026-05-07T01:00:00.000+00:00',
        idGenerator: () => 'adj_fixed_1',
      },
    });
    expect(result.adjustmentType).toBe('INCREASE_RATE');
    expect(result.adjustmentRate).toBe(0.2);
    expect(result.adjustmentQty).toBeUndefined();
    expect(result.adjustmentId).toBe('adj_fixed_1');
    expect(result.draftId).toBe('drf_aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(result.userMessage).toBe('矿泉水上调 20%');
    expect(result.createdAt).toBe('2026-05-07T01:00:00.000+00:00');
    // Zod 校验
    expect(() => AdjustmentInstruction.parse(result)).not.toThrow();
  });

  it('DECREASE_QTY：保留 qty，丢弃 rate', () => {
    const result = testInternals.assembleAdjustmentInstruction({
      core: {
        targetType: 'ALL',
        targetValue: '',
        adjustmentType: 'DECREASE_QTY',
        adjustmentRate: 0.5, // 应被丢弃
        adjustmentQty: 20,
        reason: '少要 20',
      },
      args: {
        userMessage: 'x',
        draftId: 'drf_aaaaaaaaaaaaaaaaaaaaaaaa',
        draftItemNames: [],
        now: () => '2026-05-07T01:00:00.000+00:00',
        idGenerator: () => 'adj_fixed_2',
      },
    });
    expect(result.adjustmentRate).toBeUndefined();
    expect(result.adjustmentQty).toBe(20);
  });

  it('EXCLUDE：rate / qty 都丢弃', () => {
    const result = testInternals.assembleAdjustmentInstruction({
      core: {
        targetType: 'SKU_KEYWORD',
        targetValue: '矿泉水',
        adjustmentType: 'EXCLUDE',
        adjustmentRate: 0.5,
        adjustmentQty: 100,
        reason: '不要了',
      },
      args: {
        userMessage: '不要矿泉水了',
        draftId: 'drf_aaaaaaaaaaaaaaaaaaaaaaaa',
        draftItemNames: [],
        now: () => '2026-05-07T01:00:00.000+00:00',
        idGenerator: () => 'adj_fixed_3',
      },
    });
    expect(result.adjustmentRate).toBeUndefined();
    expect(result.adjustmentQty).toBeUndefined();
  });

  it('SET_QTY：保留 qty，丢弃 rate', () => {
    const result = testInternals.assembleAdjustmentInstruction({
      core: {
        targetType: 'SKU_ID',
        targetValue: 'SKU001',
        adjustmentType: 'SET_QTY',
        adjustmentRate: null,
        adjustmentQty: 100,
        reason: 'set 100',
      },
      args: {
        userMessage: '设置为 100',
        draftId: 'drf_aaaaaaaaaaaaaaaaaaaaaaaa',
        draftItemNames: [],
        now: () => '2026-05-07T01:00:00.000+00:00',
        idGenerator: () => 'adj_fixed_4',
      },
    });
    expect(result.adjustmentQty).toBe(100);
    expect(result.adjustmentRate).toBeUndefined();
  });

  it('rate / qty 为 null → 视为 undefined（不进入对象）', () => {
    const result = testInternals.assembleAdjustmentInstruction({
      core: {
        targetType: 'SKU_KEYWORD',
        targetValue: '矿泉水',
        adjustmentType: 'INCREASE_RATE',
        adjustmentRate: null,
        adjustmentQty: null,
        reason: 'r',
      },
      args: {
        userMessage: 'x',
        draftId: 'drf_aaaaaaaaaaaaaaaaaaaaaaaa',
        draftItemNames: [],
        now: () => '2026-05-07T01:00:00.000+00:00',
        idGenerator: () => 'adj_fixed_5',
      },
    });
    expect(result.adjustmentRate).toBeUndefined();
    expect(result.adjustmentQty).toBeUndefined();
  });

  it('targetValue 默认空字符串（ALL 路径）', () => {
    const result = testInternals.assembleAdjustmentInstruction({
      core: {
        targetType: 'ALL',
        targetValue: '',
        adjustmentType: 'DECREASE_RATE',
        adjustmentRate: 0.1,
        reason: '全部下调 10%',
      },
      args: {
        userMessage: '全部下调 10%',
        draftId: 'drf_aaaaaaaaaaaaaaaaaaaaaaaa',
        draftItemNames: [],
        now: () => '2026-05-07T01:00:00.000+00:00',
        idGenerator: () => 'adj_fixed_6',
      },
    });
    expect(result.targetType).toBe('ALL');
    expect(result.targetValue).toBe('');
  });
});

describe('normalizeRate / normalizeQty — op-aware 字段裁剪', () => {
  it('INCREASE_RATE 保留 rate', () => {
    expect(
      testInternals.normalizeRate({
        targetType: 'SKU_ID',
        targetValue: 'x',
        adjustmentType: 'INCREASE_RATE',
        adjustmentRate: 0.3,
        reason: 'r',
      }),
    ).toBe(0.3);
  });

  it('INCREASE_QTY 丢弃 rate', () => {
    expect(
      testInternals.normalizeRate({
        targetType: 'SKU_ID',
        targetValue: 'x',
        adjustmentType: 'INCREASE_QTY',
        adjustmentRate: 0.3,
        reason: 'r',
      }),
    ).toBeUndefined();
  });

  it('SET_QTY 保留 qty', () => {
    expect(
      testInternals.normalizeQty({
        targetType: 'SKU_ID',
        targetValue: 'x',
        adjustmentType: 'SET_QTY',
        adjustmentQty: 100,
        reason: 'r',
      }),
    ).toBe(100);
  });

  it('INCREASE_RATE 丢弃 qty', () => {
    expect(
      testInternals.normalizeQty({
        targetType: 'SKU_ID',
        targetValue: 'x',
        adjustmentType: 'INCREASE_RATE',
        adjustmentQty: 100,
        reason: 'r',
      }),
    ).toBeUndefined();
  });
});

describe('extractAdjustmentInstruction — LLM 抽取（mock）', () => {
  it('happy：generateObject 返回合法对象 → AdjustmentInstruction.parse 通过', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        targetType: 'SKU_KEYWORD',
        targetValue: '矿泉水',
        adjustmentType: 'INCREASE_RATE',
        adjustmentRate: 0.2,
        adjustmentQty: null,
        reason: '老板要求矿泉水上调 20%',
      },
    });
    const result = await extractAdjustmentInstruction({
      userMessage: '矿泉水上调 20%',
      draftId: 'drf_aaaaaaaaaaaaaaaaaaaaaaaa',
      draftItemNames: ['SKU001 矿泉水 550ml'],
      now: () => '2026-05-07T01:00:00.000+00:00',
      idGenerator: () => 'adj_test',
    });
    expect(result.adjustmentRate).toBe(0.2);
    expect(result.draftId).toBe('drf_aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(result.adjustmentId).toBe('adj_test');
  });

  it('schema 失败 → 重试 1 次；第二次成功', async () => {
    // 第一次抽出无效 targetType → ZodError
    generateObjectMock.mockRejectedValueOnce(new Error('schema fail'));
    generateObjectMock.mockResolvedValueOnce({
      object: {
        targetType: 'ALL',
        targetValue: '',
        adjustmentType: 'DECREASE_RATE',
        adjustmentRate: 0.1,
        adjustmentQty: null,
        reason: 'retry success',
      },
    });
    const result = await extractAdjustmentInstruction({
      userMessage: '全部下调 10%',
      draftId: 'drf_aaaaaaaaaaaaaaaaaaaaaaaa',
      draftItemNames: [],
      now: () => '2026-05-07T01:00:00.000+00:00',
      idGenerator: () => 'adj_retry',
    });
    expect(result.targetType).toBe('ALL');
    expect(generateObjectMock).toHaveBeenCalledTimes(2);
    // 第二次 prompt 应含 retry 标志
    const secondCallArg = generateObjectMock.mock.calls[1]?.[0] as
      | { system?: string }
      | undefined;
    const secondCallSystem = String(secondCallArg?.system ?? '');
    expect(secondCallSystem).toMatch(/重试抽取|修复上次输出/);
  });

  it('两次都失败 → BizError(SCHEMA_FAIL)', async () => {
    generateObjectMock.mockRejectedValue(new Error('schema fail'));
    await expect(
      extractAdjustmentInstruction({
        userMessage: '错误请求',
        draftId: 'drf_aaaaaaaaaaaaaaaaaaaaaaaa',
        draftItemNames: [],
      }),
    ).rejects.toMatchObject({ code: 'SCHEMA_FAIL' });
  });
});
