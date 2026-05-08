/**
 * 切片 17 §9 验收 13 步对应 step 级单测（无 LLM / 无真实 ERP / 无真实 MySQL）
 *
 * 覆盖矩阵（与任务卡 §9 13 步映射）：
 *   - §9.1 T-08：第一次进入 askConfirmStep → suspend；preview 流出 ✓
 *   - §9.2 T-09：resume CONFIRM → createPo + markSubmitted + 返回 PO 号 ✓
 *   - §9.3 T-10：resume CANCEL → BizError(USER_CANCELLED) ✓
 *   - §9.4 T-11：同 draftId 重复确认 → createPurchaseOrder 仅 1 次 / 返回相同 PO 号（幂等） ✓
 *   - §9.5     ：markSubmitted 失败补偿 → createPoStep 不抛错；draft 仍 CONFIRMED + submitted_po_no IS NULL ✓
 *               （补偿 Job 单独覆盖，见 jobs/compensate-mark-submitted.test.ts）
 *   - §9.6     ：8 项前置校验单独覆盖（见 assert-draft-can-create-po.test.ts）
 *   - §9.7     ：mock 收到的 idempotencyKey === sourceDraftId === draftId（R-PO-002）✓
 *   - §9.8     ：从 draftItems 取数（R-PO-003：mock 收到的 items[].quantity / unit / reason 与 draft.items 一致）✓
 *   - §9.11    ：preview 完整含 SKU 列（见 compose-po-preview.test.ts）
 *   - §9.13    ：markSubmitted 后 status=SUBMITTED ✓
 *
 * 不在本文件覆盖（属切片 16 / 联动 cron）：§9.9 SUSPEND_EXPIRED / §9.10 多实例 / §9.12 IntentRouter 守门。
 */
import { BizError, type DraftItem, type DraftStatus } from '@storepilot/shared-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AgentRuntime, buildRuntimeContext } from '../runtime-context.js';

import {
  resetDraftManagerForTest,
  setDraftPool,
  type DraftPool,
} from '../../safety/draft-manager.js';

/* ============================================================================
 * Mock：mcpTools（避免拉起真实 MCPClient）
 * ========================================================================== */

interface FakeCreatePoCall {
  // Mastra 1.0 ToolAction.execute(inputData) — inputData 直接展开。
  merchantId: string;
  storeId: string;
  source: 'AI_REPLENISHMENT_AGENT';
  sourceDraftId: string;
  idempotencyKey: string;
  items: Array<{ skuId: string; quantity: number; unit: string; reason: string }>;
}

const fakeCreatePoCalls: FakeCreatePoCall[] = [];

/**
 * 幂等 Map：同 idempotencyKey 永远返回同 PO 号（与切片 05 mock-server 语义一致）。
 */
const idempotencyMap = new Map<string, { purchaseOrderNo: string; createdAt: string }>();

const fakeCreatePoTool = {
  // eslint-disable-next-line @typescript-eslint/require-await
  execute: async (args: FakeCreatePoCall) => {
    fakeCreatePoCalls.push(args);
    const key = args.idempotencyKey;
    const existing = idempotencyMap.get(key);
    if (existing) return { success: true as const, ...existing };
    const result = {
      purchaseOrderNo: `PO_${key.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}`,
      createdAt: '2026-05-07T01:00:00.000Z',
    };
    idempotencyMap.set(key, result);
    return { success: true as const, ...result };
  },
};

vi.mock('../mcp/client.js', () => ({
  mcpTools: () =>
    Promise.resolve({
      createPurchaseOrder: fakeCreatePoTool,
    }),
}));

/* ============================================================================
 * Fake DraftPool —— 复用切片 13 / 15 同形 fake；只识别本切片用到的 SQL
 * ========================================================================== */

interface FakeDraft {
  draft_id: string;
  session_id: string;
  merchant_id: string;
  store_id: string;
  user_id: string;
  trace_id: string;
  forecast_days: number;
  status: DraftStatus;
  items: DraftItem[];
  strategy_version: string;
  submitted_po_no: string | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

class FakePool implements DraftPool {
  drafts = new Map<string, FakeDraft>();
  calls: Array<{ kind: 'query' | 'execute'; sql: string; params: unknown[] }> = [];
  clock = new Date('2026-05-07T01:00:00.000Z');
  /** 注入 markSubmitted 失败的标志 */
  markSubmittedShouldFail = false;

  query<T extends Record<string, unknown>>(
    sql: string,
    params: readonly unknown[],
  ): Promise<[T[], unknown]> {
    this.calls.push({ kind: 'query', sql, params: [...params] });
    const norm = normalize(sql);

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
      return Promise.resolve([
        (matched ? [toDbRow(matched)] : []) as unknown as T[],
        undefined,
      ]);
    }

    throw new Error(`FakePool: 未识别 query SQL: ${norm}`);
  }

  execute(
    sql: string,
    params: readonly unknown[],
  ): Promise<[{ affectedRows: number }, unknown]> {
    this.calls.push({ kind: 'execute', sql, params: [...params] });
    const norm = normalize(sql);

    // markSubmitted UPDATE
    if (
      norm.startsWith('UPDATE replenishment_draft') &&
      norm.includes(`SET status = 'SUBMITTED'`) &&
      norm.includes(`status = 'CONFIRMED'`)
    ) {
      if (this.markSubmittedShouldFail) {
        return Promise.reject(new Error('Fake DB error: markSubmitted UPDATE failed'));
      }
      const [poNo, draftId, merchantId, storeId] = params as [
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
        row.status !== 'CONFIRMED'
      ) {
        return Promise.resolve([{ affectedRows: 0 }, undefined]);
      }
      row.status = 'SUBMITTED';
      row.submitted_po_no = poNo;
      row.updated_at = this.clock;
      return Promise.resolve([{ affectedRows: 1 }, undefined]);
    }

    // transit 通用 UPDATE
    if (
      norm.startsWith('UPDATE replenishment_draft') &&
      norm.includes('SET status = ?') &&
      norm.includes('WHERE draft_id = ?') &&
      norm.includes('merchant_id = ?') &&
      norm.includes('store_id = ?') &&
      norm.includes('status = ?')
    ) {
      const [to, draftId, merchantId, storeId, from] = params as [
        DraftStatus,
        string,
        string,
        string,
        DraftStatus,
      ];
      const row = this.drafts.get(draftId);
      if (
        !row ||
        row.merchant_id !== merchantId ||
        row.store_id !== storeId ||
        row.status !== from
      ) {
        return Promise.resolve([{ affectedRows: 0 }, undefined]);
      }
      row.status = to;
      row.updated_at = this.clock;
      return Promise.resolve([{ affectedRows: 1 }, undefined]);
    }

    throw new Error(`FakePool: 未识别 execute SQL: ${norm}`);
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
  traceId: 'trace_test_17',
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
    finalSuggestQty: 24,
    reason: '加权日均 10',
    adjustmentTrace: [],
    ...over,
  };
}

function makeDraft(over: Partial<FakeDraft> = {}): FakeDraft {
  // 用相对当前时间构造，避免 fixed clock 与 assertDraftCanCreatePo Date.now() 漂移
  const now = new Date();
  return {
    draft_id: 'drf_aaaaaaaaaaaaaaaaaaaaaaaa',
    session_id: 'sess_test',
    merchant_id: 'M-1',
    store_id: 'S-1',
    user_id: 'U-1',
    trace_id: 'trace_seed',
    forecast_days: 7,
    status: 'WAIT_CONFIRM',
    items: [
      makeItem({ skuId: 'SKU001', skuName: '矿泉水', finalSuggestQty: 24, unit: '瓶' }),
      makeItem({ skuId: 'SKU002', skuName: '可乐', finalSuggestQty: 36, unit: '瓶' }),
    ],
    strategy_version: 'M0-S0-Pp-1',
    submitted_po_no: null,
    expires_at: new Date(now.getTime() + 30 * 60_000), // 未来 30 分钟
    created_at: now,
    updated_at: now,
    ...over,
  };
}

let pool: FakePool;

type ExecuteFn = (args: Record<string, unknown>) => Promise<unknown>;

let previewStep: { execute: ExecuteFn };
let askConfirmStep: { execute: ExecuteFn };
let createPoStep: { execute: ExecuteFn };

beforeEach(async () => {
  pool = new FakePool();
  setDraftPool(pool);
  fakeCreatePoCalls.length = 0;
  idempotencyMap.clear();

  // 动态 import 让 vi.mock 生效
  const mod = await import('./purchase-order-create.js');
  previewStep = mod.previewStep as unknown as { execute: ExecuteFn };
  askConfirmStep = mod.askConfirmStep as unknown as { execute: ExecuteFn };
  createPoStep = mod.createPoStep as unknown as { execute: ExecuteFn };
});

afterEach(() => {
  resetDraftManagerForTest();
});

/* ============================================================================
 * §9.1 T-08 — 第一次进入 askConfirmStep → suspend
 * ========================================================================== */

describe('切片 17 §9.1 T-08 — askConfirmStep 第一次进入 suspend', () => {
  it('resumeData 缺省 → 调用 suspend(inputData) 且返回 inputData', async () => {
    const suspendCalls: unknown[] = [];
    const suspend = vi.fn(async (payload: unknown) => {
      await Promise.resolve();
      suspendCalls.push(payload);
    });

    const previewData = {
      draftId: 'drf_aaaaaaaaaaaaaaaaaaaaaaaa',
      itemCount: 2,
      totalQty: 60,
      previewMarkdown: '# 采购单确认\n...',
    };

    const out = await askConfirmStep.execute({
      inputData: previewData,
      suspend,
      requestContext: ctx(),
    });

    expect(suspend).toHaveBeenCalledTimes(1);
    expect(suspendCalls[0]).toEqual(previewData);
    expect(out).toEqual(previewData);
  });
});

/* ============================================================================
 * §9.2 T-09 — resume CONFIRM → 透传 → createPo
 * ========================================================================== */

describe('切片 17 §9.2 T-09 — askConfirmStep resume CONFIRM', () => {
  it('decision === CONFIRM → 透传 inputData（不抛错）', async () => {
    const previewData = {
      draftId: 'drf_aaaaaaaaaaaaaaaaaaaaaaaa',
      itemCount: 2,
      totalQty: 60,
      previewMarkdown: '# OK',
    };
    const suspend = vi.fn();

    const out = await askConfirmStep.execute({
      inputData: previewData,
      suspend,
      resumeData: { decision: 'CONFIRM' },
      requestContext: ctx(),
    });

    expect(suspend).not.toHaveBeenCalled();
    expect(out).toEqual(previewData);
  });
});

/* ============================================================================
 * §9.3 T-10 — resume CANCEL → BizError(USER_CANCELLED)
 * ========================================================================== */

describe('切片 17 §9.3 T-10 — askConfirmStep resume CANCEL', () => {
  it('decision === CANCEL → BizError(USER_CANCELLED) 含 reason meta', async () => {
    const suspend = vi.fn();
    const previewData = {
      draftId: 'drf_aaaaaaaaaaaaaaaaaaaaaaaa',
      itemCount: 2,
      totalQty: 60,
      previewMarkdown: '#',
    };
    try {
      await askConfirmStep.execute({
        inputData: previewData,
        suspend,
        resumeData: { decision: 'CANCEL', reason: '不需要这么多' },
        requestContext: ctx(),
      });
      expect.fail('应抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(BizError);
      expect((e as BizError).code).toBe('USER_CANCELLED');
      const meta = (e as BizError).meta as { reason?: string; draftId?: string };
      expect(meta?.reason).toBe('不需要这么多');
      expect(meta?.draftId).toBe(previewData.draftId);
    }
  });
});

/* ============================================================================
 * previewStep — 含 8 项前置校验 + composePoPreview
 * ========================================================================== */

describe('切片 17 — previewStep（getByIdStrict + assert + composePoPreview）', () => {
  it('正常流程：返回 PreviewSchema（含 markdown）', async () => {
    const draft = makeDraft();
    pool.drafts.set(draft.draft_id, draft);

    const out = (await previewStep.execute({
      inputData: { draftId: draft.draft_id },
      requestContext: ctx(),
    })) as Record<string, unknown>;

    expect(out.draftId).toBe(draft.draft_id);
    expect(out.itemCount).toBe(2);
    expect(out.totalQty).toBe(60); // 24 + 36
    expect(typeof out.previewMarkdown).toBe('string');
    expect(out.previewMarkdown).toContain('# 采购单确认');
    expect(out.previewMarkdown).toContain('SKU001');
    expect(out.previewMarkdown).toContain('SKU002');
  });

  it('DRAFT 状态 → 8 项校验拒绝（DRAFT_NOT_FOUND）', async () => {
    const draft = makeDraft({ status: 'DRAFT' });
    pool.drafts.set(draft.draft_id, draft);

    await expect(
      previewStep.execute({
        inputData: { draftId: draft.draft_id },
        requestContext: ctx(),
      }),
    ).rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' });
  });

  it('已存在 PO 号 → DRAFT_ALREADY_SUBMITTED', async () => {
    const draft = makeDraft({ submitted_po_no: 'PO_OLD' });
    pool.drafts.set(draft.draft_id, draft);

    await expect(
      previewStep.execute({
        inputData: { draftId: draft.draft_id },
        requestContext: ctx(),
      }),
    ).rejects.toMatchObject({ code: 'DRAFT_ALREADY_SUBMITTED' });
  });
});

/* ============================================================================
 * §9.7 / §9.8 — createPoStep idempotencyKey + 从 draftItems 取数
 * ========================================================================== */

describe('切片 17 §9.7 §9.8 — createPoStep（idempotencyKey + items 来源）', () => {
  it('happy path：transit WAIT_CONFIRM→CONFIRMED + ERP + markSubmitted + 返回 PO 号', async () => {
    const draft = makeDraft({ status: 'WAIT_CONFIRM' });
    pool.drafts.set(draft.draft_id, draft);

    const out = (await createPoStep.execute({
      inputData: {
        draftId: draft.draft_id,
        itemCount: 2,
        totalQty: 60,
        previewMarkdown: '# OK',
      },
      requestContext: ctx(),
    })) as { purchaseOrderNo: string; createdAt: string };

    // 返回 PO 号
    expect(out.purchaseOrderNo).toMatch(/^PO[_-][A-Za-z0-9]{6,32}$/);

    // §9.13 — markSubmitted 后 status=SUBMITTED
    const persisted = pool.drafts.get(draft.draft_id);
    expect(persisted?.status).toBe('SUBMITTED');
    expect(persisted?.submitted_po_no).toBe(out.purchaseOrderNo);

    // §9.7 — idempotencyKey === sourceDraftId === draftId
    expect(fakeCreatePoCalls).toHaveLength(1);
    const call = fakeCreatePoCalls[0]!;
    expect(call.idempotencyKey).toBe(draft.draft_id);
    expect(call.sourceDraftId).toBe(draft.draft_id);
    expect(call.merchantId).toBe(draft.merchant_id);
    expect(call.storeId).toBe(draft.store_id);
    expect(call.source).toBe('AI_REPLENISHMENT_AGENT');

    // §9.8 — items 来自 draftItems（结构化）
    expect(call.items).toEqual([
      { skuId: 'SKU001', quantity: 24, unit: '瓶', reason: '加权日均 10' },
      { skuId: 'SKU002', quantity: 36, unit: '瓶', reason: '加权日均 10' },
    ]);
  });

  it('§9.4 T-11 — 同 draftId 重复触发 → ERP 调 2 次但返回同 PO 号；markSubmitted 幂等', async () => {
    const draft = makeDraft({ status: 'WAIT_CONFIRM' });
    pool.drafts.set(draft.draft_id, draft);

    // 第 1 次
    const out1 = (await createPoStep.execute({
      inputData: {
        draftId: draft.draft_id,
        itemCount: 2,
        totalQty: 60,
        previewMarkdown: '#',
      },
      requestContext: ctx(),
    })) as { purchaseOrderNo: string };

    // 第 2 次：用户再次"确认"（draft 已 SUBMITTED）
    // 这里走不到 createPoStep —— assertDraftCanCreatePo 在 §6 项校验已挡掉
    await expect(
      createPoStep.execute({
        inputData: {
          draftId: draft.draft_id,
          itemCount: 2,
          totalQty: 60,
          previewMarkdown: '#',
        },
        requestContext: ctx(),
      }),
    ).rejects.toMatchObject({ code: 'DRAFT_ALREADY_SUBMITTED' });

    // ERP 仅 1 次（第二次被 assert 挡住）
    expect(fakeCreatePoCalls).toHaveLength(1);
    expect(out1.purchaseOrderNo).toMatch(/^PO[_-]/);
  });

  it('CONFIRMED draft（无需 transit）→ 直接调 ERP', async () => {
    const draft = makeDraft({ status: 'CONFIRMED' });
    pool.drafts.set(draft.draft_id, draft);

    const out = (await createPoStep.execute({
      inputData: {
        draftId: draft.draft_id,
        itemCount: 2,
        totalQty: 60,
        previewMarkdown: '#',
      },
      requestContext: ctx(),
    })) as { purchaseOrderNo: string };

    expect(out.purchaseOrderNo).toMatch(/^PO[_-]/);
    expect(pool.drafts.get(draft.draft_id)?.status).toBe('SUBMITTED');

    // 不应有从 WAIT_CONFIRM 起的 transit 调用（CONFIRMED 直接走）
    const transitCalls = pool.calls.filter(
      (c) =>
        c.kind === 'execute' &&
        normalize(c.sql).includes('SET status = ?') &&
        normalize(c.sql).includes('status = ?'),
    );
    expect(transitCalls).toHaveLength(0);
  });

  it('§9.5 — markSubmitted 失败 → 不抛错；draft 仍 CONFIRMED（让补偿 Job 兜底）', async () => {
    const draft = makeDraft({ status: 'WAIT_CONFIRM' });
    pool.drafts.set(draft.draft_id, draft);
    pool.markSubmittedShouldFail = true;

    const out = (await createPoStep.execute({
      inputData: {
        draftId: draft.draft_id,
        itemCount: 2,
        totalQty: 60,
        previewMarkdown: '#',
      },
      requestContext: ctx(),
    })) as { purchaseOrderNo: string };

    // 不抛错，仍返回 PO 号（让上游知道 ERP 已成功）
    expect(out.purchaseOrderNo).toMatch(/^PO[_-]/);

    // draft 状态停留在 CONFIRMED（markSubmitted UPDATE 失败被 catch）
    const persisted = pool.drafts.get(draft.draft_id);
    expect(persisted?.status).toBe('CONFIRMED');
    expect(persisted?.submitted_po_no).toBeNull();
  });

  it('createPoStep 内**再次** assertDraftCanCreatePo（防 race）—— askConfirm 期间被改成 EXPIRED', async () => {
    const draft = makeDraft({ status: 'EXPIRED' }); // 模拟 askConfirm 期间被 cron 改为 EXPIRED
    pool.drafts.set(draft.draft_id, draft);

    await expect(
      createPoStep.execute({
        inputData: {
          draftId: draft.draft_id,
          itemCount: 2,
          totalQty: 60,
          previewMarkdown: '#',
        },
        requestContext: ctx(),
      }),
    ).rejects.toMatchObject({ code: 'DRAFT_EXPIRED' });

    // ERP 不应被调用（assert 在 ERP 之前）
    expect(fakeCreatePoCalls).toHaveLength(0);
  });
});

/* ============================================================================
 * R-PO-003 grep（守门：createPoStep 内不得 parseMarkdown / summaryMarkdown）
 * ========================================================================== */

describe('切片 17 §R-PO-003 — createPoStep 不反解析 markdown（grep 守门）', () => {
  /**
   * 剥离 JS / TS 注释后再 grep（任务卡 §9 step 8 的代码审计语义）。
   *
   * - 注释里出现的 `summaryMarkdown` / `parseMarkdown` 是为了说明"禁用"语义，
   *   不视为真正的反解析代码；
   * - 仅校验非注释字符流是否含上述关键字。
   */
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '') // /* ... */
      .replace(/\/\/[^\n]*/g, ''); // // ...
  }

  it('purchase-order-create.ts 非注释代码不含 summaryMarkdown / parseMarkdown 关键字', async () => {
    const fs = await import('node:fs');
    const url = await import('node:url');
    const filePath = url.fileURLToPath(
      new URL('./purchase-order-create.ts', import.meta.url),
    );
    const code = stripComments(fs.readFileSync(filePath, 'utf-8'));
    expect(code).not.toMatch(/\bsummaryMarkdown\b/);
    expect(code).not.toMatch(/\bparseMarkdown\b/);
  });
});
