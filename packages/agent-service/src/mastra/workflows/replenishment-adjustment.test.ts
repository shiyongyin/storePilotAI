/**
 * 切片 15 §9 验收 12 步对应单测（无 LLM / 无真实 MySQL）
 *
 * 覆盖（任务卡 docs/tanks/15-skill-replenishment-adjustment.md §9 / §10）：
 *   - 第 1 步：关键词匹配（"矿泉水上调 20%"）→ finalSuggestQty 真实 +20%
 *   - 第 3 步：0 匹配 → ADJUSTMENT_SKU_UNMATCHED + friendlyMessage
 *   - 第 4 步：调整次数上限（11 次 → ADJUSTMENT_TOO_MANY）
 *   - 第 5 步：adjustment_log 一行（before / after / instruction / affected_sku_ids）
 *   - 第 6 步：草稿 EXPIRED → DRAFT_EXPIRED
 *   - 第 7 步：草稿 SUBMITTED → DRAFT_ALREADY_SUBMITTED
 *   - 第 10 步：draftItems 真实更新（DraftManager.updateItems）
 *   - 第 11 步：影响列表 markdown 完整（不省略，50 SKU 列全）
 *   - 第 12 步：adjustmentTrace 累加（同 SKU 多次调整 → trace 长度 = 2）
 *   - §10.1 关键词匹配（多 SKU 矿泉水）
 *   - §10.4 / §10.5 EXPIRED / SUBMITTED 拒绝
 *   - §10.6 第 11 次调整 → ADJUSTMENT_TOO_MANY
 *   - §10.13 影响列表完整（不省略 50 行）
 *   - 任务卡 §7 MUST DO §1：先抽 AdjustmentInstruction 再修改草稿
 *   - 任务卡 §7 MUST NOT §1：LLM 不直接产出 finalSuggestQty
 *   - 任务卡 §7 MUST NOT §7：不调用任何 WRITE 工具（grep createPurchaseOrder 0 命中）
 *
 * 第 2 步（精确匹配 SKU_ID）+ 第 8 步（4 级匹配短路）+ 第 9 步（6 op 全覆盖）由
 * `matcher.test.ts` 覆盖；本文件聚焦 workflow step 级行为。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  BizError,
  type AdjustmentInstruction,
  type DraftItem,
} from '@storepilot/shared-contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AgentRuntime, buildRuntimeContext } from '../runtime-context.js';

/* ============================================================================
 * 全局 env（与 business-reports-runtime.test.ts 保持一致）
 * ========================================================================== */

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

/* ============================================================================
 * Mock：strategy-engine / instruction-extractor
 * ========================================================================== */

vi.mock('../../safety/strategy-engine.js', () => ({
  mergeStrategy: vi.fn(),
}));

vi.mock('../../skills/replenishment/instruction-extractor.js', () => ({
  extractAdjustmentInstruction: vi.fn(),
}));

type ExecuteFn = (args: Record<string, unknown>) => Promise<unknown>;

let loadActiveDraftStep: { execute: ExecuteFn };
let extractInstructionStep: { execute: ExecuteFn };
let applyInstructionStep: { execute: ExecuteFn };
let persistAdjustmentStep: { execute: ExecuteFn };
let renderAdjustmentMarkdown: (args: Record<string, unknown>) => string;
let locateDraftFn: (args: Record<string, unknown>) => Promise<unknown>;

let mergeStrategyMock: ReturnType<typeof vi.fn>;
let extractMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV_FIXTURE)) vi.stubEnv(k, v);

  ({ mergeStrategy: mergeStrategyMock } = (await import(
    '../../safety/strategy-engine.js'
  )) as unknown as { mergeStrategy: ReturnType<typeof vi.fn> });
  ({ extractAdjustmentInstruction: extractMock } = (await import(
    '../../skills/replenishment/instruction-extractor.js'
  )) as unknown as { extractAdjustmentInstruction: ReturnType<typeof vi.fn> });

  const mod = await import('./replenishment-adjustment.js');
  loadActiveDraftStep = mod.loadActiveDraftStep as unknown as { execute: ExecuteFn };
  extractInstructionStep = mod.extractInstructionStep as unknown as { execute: ExecuteFn };
  applyInstructionStep = mod.applyInstructionStep as unknown as { execute: ExecuteFn };
  persistAdjustmentStep = mod.persistAdjustmentStep as unknown as { execute: ExecuteFn };
  renderAdjustmentMarkdown = mod.renderAdjustmentMarkdown as unknown as typeof renderAdjustmentMarkdown;
  locateDraftFn = mod.locateDraft as unknown as typeof locateDraftFn;
});

/* ============================================================================
 * 共用 Fake DraftPool（覆盖 SELECT/UPDATE/INSERT replenishment_*）+ DI 装/卸
 * ========================================================================== */

import {
  resetDraftManagerForTest,
  setDraftPool,
  type DraftPool,
} from '../../safety/draft-manager.js';

interface FakeDraft {
  draft_id: string;
  session_id: string;
  merchant_id: string;
  store_id: string;
  user_id: string;
  trace_id: string;
  forecast_days: number;
  status: string;
  items: DraftItem[];
  strategy_version: string;
  submitted_po_no: string | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

interface FakeAdjustLogRow {
  adjustment_id: string;
  draft_id: string;
  user_message: string;
  target_type: string;
  target_value: string;
  adjustment_type: string;
  adjustment_rate: number | null;
  adjustment_qty: number | null;
  reason: string;
  applied: number;
  before_items_json: string;
  after_items_json: string;
  instruction_json: string;
  affected_sku_ids: string;
  created_at: Date;
}

interface FakeSession {
  session_id: string;
  active_draft_id: string | null;
}

class FakePool implements DraftPool {
  drafts = new Map<string, FakeDraft>();
  logs: FakeAdjustLogRow[] = [];
  sessions = new Map<string, FakeSession>();
  calls: Array<{ kind: 'query' | 'execute'; sql: string; params: unknown[] }> = [];
  clock = new Date('2026-05-07T01:00:00.000Z');

  query<T extends Record<string, unknown>>(
    sql: string,
    params: readonly unknown[],
  ): Promise<[T[], unknown]> {
    this.calls.push({ kind: 'query', sql, params: [...params] });
    const norm = normalize(sql);

    // SELECT active_draft_id from agent_session
    if (norm.includes('SELECT active_draft_id FROM agent_session')) {
      const [sessionId] = params as [string];
      const session = this.sessions.get(sessionId);
      return Promise.resolve([
        (session ? [{ active_draft_id: session.active_draft_id }] : []) as unknown as T[],
        undefined,
      ]);
    }

    // SELECT COUNT(*) from replenishment_adjustment_log
    if (
      norm.startsWith('SELECT COUNT(*)') &&
      norm.includes('replenishment_adjustment_log')
    ) {
      const [draftId] = params as [string];
      const cnt = this.logs.filter((r) => r.draft_id === draftId).length;
      return Promise.resolve([[{ cnt }] as unknown as T[], undefined]);
    }

    // getByIdStrict
    if (
      norm.startsWith('SELECT') &&
      norm.includes('FROM replenishment_draft') &&
      norm.includes('WHERE draft_id = ?') &&
      norm.includes('merchant_id = ?')
    ) {
      const [draftId, merchantId, storeId] = params as [string, string, string];
      const row = this.drafts.get(draftId);
      const matched =
        row && row.merchant_id === merchantId && row.store_id === storeId ? row : null;
      return Promise.resolve([(matched ? [toDbRow(matched)] : []) as unknown as T[], undefined]);
    }

    // findRecentDraft
    if (
      norm.startsWith('SELECT') &&
      norm.includes('FROM replenishment_draft') &&
      norm.includes('user_id = ?') &&
      norm.includes('INTERVAL ? MINUTE')
    ) {
      const [merchantId, storeId, userId] = params as [string, string, string];
      const matched = [...this.drafts.values()]
        .filter(
          (r) =>
            r.merchant_id === merchantId &&
            r.store_id === storeId &&
            r.user_id === userId,
        )
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      return Promise.resolve([matched.map(toDbRow) as unknown as T[], undefined]);
    }

    throw new Error(`FakePool: 未识别的 query SQL: ${norm}`);
  }

  execute(
    sql: string,
    params: readonly unknown[],
  ): Promise<[{ affectedRows: number }, unknown]> {
    this.calls.push({ kind: 'execute', sql, params: [...params] });
    const norm = normalize(sql);

    // INSERT replenishment_adjustment_log
    if (norm.startsWith('INSERT INTO replenishment_adjustment_log')) {
      const [
        adjustment_id,
        draft_id,
        user_message,
        target_type,
        target_value,
        adjustment_type,
        adjustment_rate,
        adjustment_qty,
        reason,
        before_items_json,
        after_items_json,
        instruction_json,
        affected_sku_ids,
      ] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
        number | null,
        number | null,
        string,
        string,
        string,
        string,
        string,
      ];
      this.logs.push({
        adjustment_id,
        draft_id,
        user_message,
        target_type,
        target_value,
        adjustment_type,
        adjustment_rate,
        adjustment_qty,
        reason,
        applied: 1,
        before_items_json,
        after_items_json,
        instruction_json,
        affected_sku_ids,
        created_at: this.clock,
      });
      return Promise.resolve([{ affectedRows: 1 }, undefined]);
    }

    // UPDATE replenishment_draft SET items = CAST(? AS JSON) ...
    if (
      norm.startsWith('UPDATE replenishment_draft') &&
      norm.includes('SET items = CAST(? AS JSON)') &&
      norm.includes("status IN ('DRAFT', 'WAIT_CONFIRM', 'CONFIRMED')")
    ) {
      const [itemsJson, draftId, merchantId, storeId] = params as [
        string,
        string,
        string,
        string,
      ];
      const row = this.drafts.get(draftId);
      if (
        !row ||
        row.merchant_id !== merchantId ||
        row.store_id !== storeId ||
        !['DRAFT', 'WAIT_CONFIRM', 'CONFIRMED'].includes(row.status)
      ) {
        return Promise.resolve([{ affectedRows: 0 }, undefined]);
      }
      row.items = JSON.parse(itemsJson) as DraftItem[];
      row.updated_at = this.clock;
      return Promise.resolve([{ affectedRows: 1 }, undefined]);
    }

    // INSERT replenishment_draft（用例不直接调；create 走 draft-manager 单测覆盖，此处兜底）
    if (norm.startsWith('INSERT INTO replenishment_draft')) {
      // 简化：忽略，单测不通过 create 路径
      return Promise.resolve([{ affectedRows: 1 }, undefined]);
    }

    throw new Error(`FakePool: 未识别的 execute SQL: ${norm}`);
  }
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function toDbRow(r: FakeDraft): Record<string, unknown> {
  return {
    draft_id: r.draft_id,
    session_id: r.session_id,
    merchant_id: r.merchant_id,
    store_id: r.store_id,
    user_id: r.user_id,
    trace_id: r.trace_id,
    forecast_days: r.forecast_days,
    status: r.status,
    items: r.items,
    strategy_version: r.strategy_version,
    submitted_po_no: r.submitted_po_no,
    expires_at: r.expires_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/* ============================================================================
 * Fixtures
 * ========================================================================== */

const RUNTIME: AgentRuntime = {
  traceId: 'trace_test_15',
  sessionId: 'sess_test',
  merchantId: 'M-1',
  storeId: 'S-1',
  userId: 'U-1',
  apiKeyPrefix: 'sk-agent-test',
  requestStartedAt: 0,
};

function ctx(input: AgentRuntime = RUNTIME) {
  return buildRuntimeContext(input);
}

function makeItem(over: Partial<DraftItem> = {}): DraftItem {
  return {
    skuId: 'SKU001',
    skuName: '矿泉水 550ml',
    unit: '瓶',
    baseSuggestQty: 100,
    finalSuggestQty: 100,
    reason: '加权日均 10',
    adjustmentTrace: [],
    ...over,
  };
}

function makeDraft(over: Partial<FakeDraft> = {}): FakeDraft {
  const now = new Date('2026-05-07T01:00:00.000Z');
  return {
    draft_id: 'drf_aaaaaaaaaaaaaaaaaaaaaaaa',
    session_id: 'sess_test',
    merchant_id: 'M-1',
    store_id: 'S-1',
    user_id: 'U-1',
    trace_id: 'trace_seed',
    forecast_days: 7,
    status: 'DRAFT',
    items: [
      makeItem({ skuId: 'SKU001', skuName: '矿泉水 550ml', finalSuggestQty: 100 }),
      makeItem({ skuId: 'SKU002', skuName: '矿泉水 1.5L', finalSuggestQty: 50 }),
      makeItem({ skuId: 'SKU003', skuName: '可乐 500ml', finalSuggestQty: 30 }),
    ],
    strategy_version: 'M0-S0-Pp-1',
    submitted_po_no: null,
    expires_at: new Date(now.getTime() + 30 * 60_000),
    created_at: now,
    updated_at: now,
    ...over,
  };
}

function makeInstruction(over: Partial<AdjustmentInstruction> = {}): AdjustmentInstruction {
  return {
    adjustmentId: 'adj_test_1',
    draftId: 'drf_aaaaaaaaaaaaaaaaaaaaaaaa',
    userMessage: '矿泉水上调 20%',
    targetType: 'SKU_KEYWORD',
    targetValue: '矿泉水',
    adjustmentType: 'INCREASE_RATE',
    adjustmentRate: 0.2,
    reason: '老板要求矿泉水上调 20%',
    createdAt: '2026-05-07T01:00:00.000Z',
    ...over,
  };
}

function strategyEntry(maxAdjustments = 10) {
  return {
    merged: {
      enabledSkills: [],
      replenishmentPolicy: {
        forecastDays: 7,
        safetyStockDays: 2,
        requireConfirmBeforePurchaseOrder: true,
        allowAutoPurchaseOrder: false as const,
        forecastMethod: 'weighted_moving_average' as const,
      },
      reportPolicy: { maxSummaryChars: 8000, maxCards: 12 },
      safetyPolicy: {
        requireUserConfirmForWrite: true as const,
        maxAdjustmentsPerDraft: maxAdjustments,
        majorAdjustmentRatio: 0.5,
        draftAutoExpireMinutes: 30,
      },
    },
    version: 'M0-S0-Pp-1',
    degraded: false,
  };
}

let pool: FakePool;

beforeEach(() => {
  pool = new FakePool();
  setDraftPool(pool);
  mergeStrategyMock.mockReset();
  extractMock.mockReset();
});

afterEach(() => {
  resetDraftManagerForTest();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

/* ============================================================================
 * §9.6 — 草稿 EXPIRED → DRAFT_EXPIRED
 * ========================================================================== */

describe('切片 15 §9.6 §10.4 — 草稿 EXPIRED → DRAFT_EXPIRED', () => {
  it('EXPIRED 草稿 → 抛 DRAFT_EXPIRED + meta', async () => {
    const draft = makeDraft({ status: 'EXPIRED' });
    pool.drafts.set(draft.draft_id, draft);
    mergeStrategyMock.mockResolvedValue(strategyEntry(10));

    await expect(
      loadActiveDraftStep.execute({
        inputData: {
          sessionId: 'sess_test',
          userMessage: '矿泉水上调 20%',
          draftId: draft.draft_id,
        },
        requestContext: ctx(),
      }),
    ).rejects.toMatchObject({ code: 'DRAFT_EXPIRED' });
  });
});

/* ============================================================================
 * §9.7 — 草稿 SUBMITTED → DRAFT_ALREADY_SUBMITTED
 * ========================================================================== */

describe('切片 15 §9.7 §10.5 — 草稿 SUBMITTED → DRAFT_ALREADY_SUBMITTED', () => {
  it('SUBMITTED 草稿 → 抛 DRAFT_ALREADY_SUBMITTED', async () => {
    const draft = makeDraft({ status: 'SUBMITTED', submitted_po_no: 'PO123' });
    pool.drafts.set(draft.draft_id, draft);
    mergeStrategyMock.mockResolvedValue(strategyEntry(10));

    await expect(
      loadActiveDraftStep.execute({
        inputData: {
          sessionId: 'sess_test',
          userMessage: '矿泉水上调 20%',
          draftId: draft.draft_id,
        },
        requestContext: ctx(),
      }),
    ).rejects.toMatchObject({ code: 'DRAFT_ALREADY_SUBMITTED' });
  });

  it('CANCELLED 草稿 → DRAFT_NOT_FOUND', async () => {
    const draft = makeDraft({ status: 'CANCELLED' });
    pool.drafts.set(draft.draft_id, draft);
    mergeStrategyMock.mockResolvedValue(strategyEntry(10));

    await expect(
      loadActiveDraftStep.execute({
        inputData: {
          sessionId: 'sess_test',
          userMessage: '矿泉水上调 20%',
          draftId: draft.draft_id,
        },
        requestContext: ctx(),
      }),
    ).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' });
  });
});

/* ============================================================================
 * §9.4 §10.6 — 调整次数上限
 * ========================================================================== */

describe('切片 15 §9.4 §10.6 — 调整次数上限', () => {
  it('已写 10 次（>= maxAdjustmentsPerDraft=10）→ ADJUSTMENT_TOO_MANY', async () => {
    const draft = makeDraft({ status: 'DRAFT' });
    pool.drafts.set(draft.draft_id, draft);
    // 预填 10 条 log
    for (let i = 0; i < 10; i++) {
      pool.logs.push({
        adjustment_id: `adj_${i}`,
        draft_id: draft.draft_id,
        user_message: 'x',
        target_type: 'ALL',
        target_value: '',
        adjustment_type: 'EXCLUDE',
        adjustment_rate: null,
        adjustment_qty: null,
        reason: 'r',
        applied: 1,
        before_items_json: '[]',
        after_items_json: '[]',
        instruction_json: '{}',
        affected_sku_ids: '[]',
        created_at: new Date(),
      });
    }
    mergeStrategyMock.mockResolvedValue(strategyEntry(10));

    await expect(
      loadActiveDraftStep.execute({
        inputData: {
          sessionId: 'sess_test',
          userMessage: '矿泉水上调 20%',
          draftId: draft.draft_id,
        },
        requestContext: ctx(),
      }),
    ).rejects.toMatchObject({ code: 'ADJUSTMENT_TOO_MANY' });
  });

  it('已写 9 次 + 上限 10 → 通过（剩余 1 次）', async () => {
    const draft = makeDraft({ status: 'DRAFT' });
    pool.drafts.set(draft.draft_id, draft);
    for (let i = 0; i < 9; i++) {
      pool.logs.push({
        adjustment_id: `adj_${i}`,
        draft_id: draft.draft_id,
        user_message: 'x',
        target_type: 'ALL',
        target_value: '',
        adjustment_type: 'EXCLUDE',
        adjustment_rate: null,
        adjustment_qty: null,
        reason: 'r',
        applied: 1,
        before_items_json: '[]',
        after_items_json: '[]',
        instruction_json: '{}',
        affected_sku_ids: '[]',
        created_at: new Date(),
      });
    }
    mergeStrategyMock.mockResolvedValue(strategyEntry(10));

    const out = (await loadActiveDraftStep.execute({
      inputData: {
        sessionId: 'sess_test',
        userMessage: '矿泉水上调 20%',
        draftId: draft.draft_id,
      },
      requestContext: ctx(),
    })) as Record<string, unknown>;

    expect(out.maxAdjustmentsPerDraft).toBe(10);
    expect(out.currentAdjustmentCount).toBe(9);
  });
});

/* ============================================================================
 * §9.1 §10.1 — 关键词匹配（"矿泉水上调 20%"）
 * ========================================================================== */

describe('切片 15 §9.1 §10.1 — 关键词匹配 → finalSuggestQty 真实 +20%', () => {
  it('关键词"矿泉水"命中 SKU001 / SKU002 → 各上调 20%', async () => {
    const draft = makeDraft();
    pool.drafts.set(draft.draft_id, draft);
    mergeStrategyMock.mockResolvedValue(strategyEntry(10));
    extractMock.mockResolvedValue(makeInstruction());

    // step1
    const step1 = (await loadActiveDraftStep.execute({
      inputData: {
        sessionId: 'sess_test',
        userMessage: '矿泉水上调 20%',
        draftId: draft.draft_id,
      },
      requestContext: ctx(),
    })) as Record<string, unknown>;

    // step2
    const step2 = (await extractInstructionStep.execute({
      inputData: step1,
      requestContext: ctx(),
    })) as Record<string, unknown>;
    expect(extractMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: '矿泉水上调 20%',
        draftId: draft.draft_id,
      }),
    );

    // step3
    const step3 = (await applyInstructionStep.execute({
      inputData: step2,
      requestContext: ctx(),
    })) as Record<string, unknown>;
    expect(step3.affectedSkuIds).toEqual(['SKU001', 'SKU002']);
    const after = step3.afterItems as DraftItem[];
    const bySku = new Map(after.map((it) => [it.skuId, it] as const));
    expect(bySku.get('SKU001')?.finalSuggestQty).toBe(120); // 100 × 1.2
    expect(bySku.get('SKU002')?.finalSuggestQty).toBe(60); //  50 × 1.2
    expect(bySku.get('SKU003')?.finalSuggestQty).toBe(30); // 未受影响

    // step4
    const step4 = (await persistAdjustmentStep.execute({
      inputData: step3,
      requestContext: ctx(),
    })) as Record<string, unknown>;
    expect(step4.affectedCount).toBe(2);
    expect(step4.remainingAdjustments).toBe(9);
    expect(step4.summaryMarkdown).toContain('## 影响的 SKU');
    expect(step4.summaryMarkdown).toContain('SKU001');
    expect(step4.summaryMarkdown).toContain('SKU002');

    // §9.10：draftItems 真实更新
    const persisted = pool.drafts.get(draft.draft_id);
    expect(persisted?.items.find((it) => it.skuId === 'SKU001')?.finalSuggestQty).toBe(120);
    expect(persisted?.items.find((it) => it.skuId === 'SKU002')?.finalSuggestQty).toBe(60);

    // §9.5：adjustment_log 一行
    expect(pool.logs).toHaveLength(1);
    const log = pool.logs[0]!;
    expect(log.draft_id).toBe(draft.draft_id);
    expect(log.adjustment_type).toBe('INCREASE_RATE');
    expect(log.adjustment_rate).toBe(0.2);
    expect(JSON.parse(log.before_items_json)).toHaveLength(3);
    expect(JSON.parse(log.after_items_json)).toHaveLength(3);
    expect(JSON.parse(log.instruction_json)).toMatchObject({
      adjustmentType: 'INCREASE_RATE',
      adjustmentRate: 0.2,
    });
    expect(JSON.parse(log.affected_sku_ids)).toEqual(['SKU001', 'SKU002']);
  });
});

/* ============================================================================
 * §9.3 §10.3 — 0 匹配 → ADJUSTMENT_SKU_UNMATCHED
 * ========================================================================== */

describe('切片 15 §9.3 §10.3 — 0 匹配拒绝', () => {
  it('"调高 SKUXXX"（不存在）→ ADJUSTMENT_SKU_UNMATCHED 且不修改 draft / 不写 log', async () => {
    const draft = makeDraft();
    pool.drafts.set(draft.draft_id, draft);
    mergeStrategyMock.mockResolvedValue(strategyEntry(10));
    extractMock.mockResolvedValue(
      makeInstruction({
        targetType: 'SKU_KEYWORD',
        targetValue: '不存在的商品 ABCDEFG',
        adjustmentType: 'INCREASE_RATE',
        adjustmentRate: 0.2,
      }),
    );

    const step1 = await loadActiveDraftStep.execute({
      inputData: {
        sessionId: 'sess_test',
        userMessage: '调高不存在的商品 ABCDEFG',
        draftId: draft.draft_id,
      },
      requestContext: ctx(),
    });
    const step2 = await extractInstructionStep.execute({
      inputData: step1 as Record<string, unknown>,
      requestContext: ctx(),
    });

    await expect(
      applyInstructionStep.execute({
        inputData: step2 as Record<string, unknown>,
        requestContext: ctx(),
      }),
    ).rejects.toMatchObject({ code: 'ADJUSTMENT_SKU_UNMATCHED' });

    // 不修改 draft
    expect(pool.drafts.get(draft.draft_id)?.items[0]?.finalSuggestQty).toBe(100);
    // 不写 log
    expect(pool.logs).toHaveLength(0);
  });
});

/* ============================================================================
 * §9.12 — adjustmentTrace 累加
 * ========================================================================== */

describe('切片 15 §9.12 §10.12 — adjustmentTrace 累加（同 SKU 多次调整 → 长度=2）', () => {
  it('两次调整后 trace 长度 = 2', async () => {
    const draft = makeDraft();
    pool.drafts.set(draft.draft_id, draft);
    mergeStrategyMock.mockResolvedValue(strategyEntry(10));

    // round 1：上调 20%
    extractMock.mockResolvedValueOnce(makeInstruction({ adjustmentRate: 0.2 }));
    const r1s1 = await loadActiveDraftStep.execute({
      inputData: {
        sessionId: 'sess_test',
        userMessage: '矿泉水上调 20%',
        draftId: draft.draft_id,
      },
      requestContext: ctx(),
    });
    const r1s2 = await extractInstructionStep.execute({
      inputData: r1s1 as Record<string, unknown>,
      requestContext: ctx(),
    });
    const r1s3 = await applyInstructionStep.execute({
      inputData: r1s2 as Record<string, unknown>,
      requestContext: ctx(),
    });
    await persistAdjustmentStep.execute({
      inputData: r1s3 as Record<string, unknown>,
      requestContext: ctx(),
    });

    // round 2：再下调 10%
    extractMock.mockResolvedValueOnce(
      makeInstruction({
        adjustmentId: 'adj_test_2',
        adjustmentType: 'DECREASE_RATE',
        adjustmentRate: 0.1,
        createdAt: '2026-05-07T01:01:00.000Z',
      }),
    );
    const r2s1 = await loadActiveDraftStep.execute({
      inputData: {
        sessionId: 'sess_test',
        userMessage: '矿泉水下调 10%',
        draftId: draft.draft_id,
      },
      requestContext: ctx(),
    });
    const r2s2 = await extractInstructionStep.execute({
      inputData: r2s1 as Record<string, unknown>,
      requestContext: ctx(),
    });
    const r2s3 = await applyInstructionStep.execute({
      inputData: r2s2 as Record<string, unknown>,
      requestContext: ctx(),
    });
    await persistAdjustmentStep.execute({
      inputData: r2s3 as Record<string, unknown>,
      requestContext: ctx(),
    });

    // 检查 SKU001 的 trace 长度
    const persisted = pool.drafts.get(draft.draft_id);
    const sku001 = persisted?.items.find((it) => it.skuId === 'SKU001');
    expect(sku001?.adjustmentTrace).toHaveLength(2);
    expect(sku001?.adjustmentTrace[0]).toContain('INCREASE_RATE(0.2)');
    expect(sku001?.adjustmentTrace[1]).toContain('DECREASE_RATE(0.1)');

    // 两条 log
    expect(pool.logs).toHaveLength(2);
    expect(pool.logs[1]!.adjustment_type).toBe('DECREASE_RATE');
  });
});

/* ============================================================================
 * §9.11 §10.13 — 影响列表 markdown 完整（不省略）
 * ========================================================================== */

describe('切片 15 §9.11 §10.13 — 影响列表 markdown 完整', () => {
  it('50 SKU 全部受影响 → markdown 列出全部 50 行（不省略）', () => {
    const beforeItems: DraftItem[] = [];
    const afterItems: DraftItem[] = [];
    const affectedSkuIds: string[] = [];
    for (let i = 0; i < 50; i++) {
      const skuId = `SKU${String(i + 1).padStart(3, '0')}`;
      beforeItems.push(makeItem({ skuId, skuName: `测试 SKU ${i + 1}`, finalSuggestQty: 100 }));
      afterItems.push(makeItem({ skuId, skuName: `测试 SKU ${i + 1}`, finalSuggestQty: 90 }));
      affectedSkuIds.push(skuId);
    }
    const md = renderAdjustmentMarkdown({
      instruction: makeInstruction({ targetType: 'ALL', targetValue: '' }),
      beforeItems,
      afterItems,
      affectedSkuIds,
      remaining: 5,
    });
    expect(md).toContain('## 影响的 SKU');
    for (const skuId of affectedSkuIds) {
      expect(md, `markdown 必须列出 ${skuId}（不省略）`).toContain(skuId);
    }
    // 确保不出现"以下省略" / "..." / "其它"等省略词
    expect(md).not.toMatch(/省略|\.\.\.|其(它|他)/);
  });

  it('markdown 含调整摘要 + 调整后 finalSuggestQty', () => {
    const md = renderAdjustmentMarkdown({
      instruction: makeInstruction({
        targetType: 'SKU_KEYWORD',
        targetValue: '矿泉水',
        adjustmentType: 'INCREASE_RATE',
        adjustmentRate: 0.2,
      }),
      beforeItems: [makeItem({ skuId: 'SKU001', finalSuggestQty: 100 })],
      afterItems: [makeItem({ skuId: 'SKU001', finalSuggestQty: 120 })],
      affectedSkuIds: ['SKU001'],
      remaining: 9,
    });
    expect(md).toContain('SKU001');
    expect(md).toContain('100');
    expect(md).toContain('120');
    expect(md).toContain('20%');
    expect(md).toContain('# 补货调整结果');
  });
});

/* ============================================================================
 * locateDraft：active_draft_id / findRecentDraft 兜底
 * ========================================================================== */

describe('locateDraft — 两级兜底（active_draft_id → findRecentDraft）', () => {
  it('显式 draftId 优先', async () => {
    const draft = makeDraft();
    pool.drafts.set(draft.draft_id, draft);
    const found = (await locateDraftFn({
      explicitDraftId: draft.draft_id,
      sessionId: 'sess_test',
      runtimeContext: ctx(),
    })) as { draftId: string };
    expect(found.draftId).toBe(draft.draft_id);
  });

  it('未传 draftId → 用 agent_session.active_draft_id', async () => {
    const draft = makeDraft();
    pool.drafts.set(draft.draft_id, draft);
    pool.sessions.set('sess_test', {
      session_id: 'sess_test',
      active_draft_id: draft.draft_id,
    });
    const found = (await locateDraftFn({
      sessionId: 'sess_test',
      runtimeContext: ctx(),
    })) as { draftId: string };
    expect(found.draftId).toBe(draft.draft_id);
  });

  it('agent_session 无记录 → findRecentDraft 兜底', async () => {
    const draft = makeDraft();
    pool.drafts.set(draft.draft_id, draft);
    const found = (await locateDraftFn({
      sessionId: 'sess_unknown',
      runtimeContext: ctx(),
    })) as { draftId: string };
    expect(found.draftId).toBe(draft.draft_id);
  });

  it('完全找不到 → DRAFT_NOT_FOUND + 友好消息', async () => {
    await expect(
      locateDraftFn({
        sessionId: 'sess_nothing',
        runtimeContext: ctx(),
      }),
    ).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' });
  });

  it('findRecentDraft 仅返回终态草稿 → 仍 DRAFT_NOT_FOUND（跳过 EXPIRED/SUBMITTED/CANCELLED）', async () => {
    const draft = makeDraft({ status: 'EXPIRED' });
    pool.drafts.set(draft.draft_id, draft);
    await expect(
      locateDraftFn({
        sessionId: 'sess_only_terminal',
        runtimeContext: ctx(),
      }),
    ).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' });
  });
});

/* ============================================================================
 * 任务卡 §7 MUST NOT §7 — Workflow 不得调用 createPurchaseOrder（grep 守门）
 * ========================================================================== */

describe('切片 15 §7 MUST NOT §7 — Workflow 源文件不得 import / 调用 createPurchaseOrder', () => {
  /**
   * 剥离单行 // 与块 /\* ... *\/ 注释，保留代码体。
   * 业务红线是"不调用写工具"——注释里出现 createPurchaseOrder（用于澄清 MUST NOT）允许；
   * 真正的代码体（import / 调用）必须 0 命中。
   */
  function stripComments(src: string): string {
    let s = src.replace(/\/\*[\s\S]*?\*\//g, '');
    s = s
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    return s;
  }

  it('replenishment-adjustment.ts 代码体（去注释）不出现 createPurchaseOrder', () => {
    const text = readFileSync(
      fileURLToPath(new URL('./replenishment-adjustment.ts', import.meta.url)),
      'utf8',
    );
    expect(stripComments(text)).not.toMatch(/createPurchaseOrder/);
  });

  it('matcher.ts / instruction-extractor.ts 代码体（去注释）不出现 createPurchaseOrder', () => {
    const matcherSrc = readFileSync(
      fileURLToPath(new URL('../../skills/replenishment/matcher.ts', import.meta.url)),
      'utf8',
    );
    const extractorSrc = readFileSync(
      fileURLToPath(
        new URL('../../skills/replenishment/instruction-extractor.ts', import.meta.url),
      ),
      'utf8',
    );
    expect(stripComments(matcherSrc)).not.toMatch(/createPurchaseOrder/);
    expect(stripComments(extractorSrc)).not.toMatch(/createPurchaseOrder/);
  });
});

/* ============================================================================
 * 任务卡 §7 MUST NOT §1 — instruction-extractor 不得让 LLM 直接产出 finalSuggestQty
 * ========================================================================== */

describe('切片 15 §7 MUST NOT §1 — LLM 不得直接产出 finalSuggestQty', () => {
  it('instruction-extractor.ts 抽取 schema 不含 finalSuggestQty 字段', () => {
    const text = readFileSync(
      fileURLToPath(
        new URL('../../skills/replenishment/instruction-extractor.ts', import.meta.url),
      ),
      'utf8',
    );
    // schema 字段定义不允许出现 finalSuggestQty（注释行通过 .test 也不会命中，因为我们用 schema 字段断言）
    const schemaSection = text.match(/ExtractedInstructionCore[\s\S]+?\}\)/)?.[0] ?? '';
    expect(schemaSection, 'LLM 抽取 schema 不应含 finalSuggestQty').not.toMatch(
      /finalSuggestQty/,
    );
  });

  it('adjustment-extractor.prompt.ts 明确禁止 LLM 输出 finalSuggestQty', () => {
    const text = readFileSync(
      fileURLToPath(
        new URL('../../prompts/adjustment-extractor.prompt.ts', import.meta.url),
      ),
      'utf8',
    );
    expect(text).toMatch(/不得输出.*finalSuggestQty|不得输出 finalSuggestQty/);
  });
});

/* ============================================================================
 * BizError friendlyMessage — ADJUSTMENT_SKU_UNMATCHED 中文话术
 * ========================================================================== */

describe('BizError 友好话术 — ADJUSTMENT_SKU_UNMATCHED / ADJUSTMENT_TOO_MANY', () => {
  it('ADJUSTMENT_SKU_UNMATCHED 抛错对象包含 code', () => {
    const err = new BizError('ADJUSTMENT_SKU_UNMATCHED', '没找到匹配商品');
    expect(err.code).toBe('ADJUSTMENT_SKU_UNMATCHED');
  });

  it('ADJUSTMENT_TOO_MANY 抛错对象包含 code', () => {
    const err = new BizError('ADJUSTMENT_TOO_MANY', '已达调整上限');
    expect(err.code).toBe('ADJUSTMENT_TOO_MANY');
  });
});
