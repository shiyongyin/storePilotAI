/**
 * 切片 13 §9 验收 11 步对应单测
 *
 * 覆盖（任务卡 §10 全部 14 测试场景 + §9 11 步）:
 *   - 状态机 happy / 非法 / 终态不可流转（§9.1-§9.3 / §10.1-§10.3）
 *   - 跨租户硬隔离（§9.4 / §10.4）
 *   - 30 分钟过期自动 EXPIRED + CONFIRMED 不过期（§9.5 / §10.5-§10.7）
 *   - 5 分钟兜底索引 + 6 分钟边界（§9.6 / §10.8-§10.9）
 *   - markSubmitted 幂等 / 冲突（§9.7 / §10.10-§10.11）
 *   - 并发修改保护（§10.14）
 *   - 短事务 grep（§9.9 / §10.13）
 *   - items JSON.stringify(stripUndefinedDeep) + DRAFT_NOT_FOUND meta
 *   - draftId 正则、Pool 未注入兜底
 *
 * 测试基础设施:
 *   - 内存版 FakeDraftPool 模拟 mysql2 行为（INSERT/SELECT/UPDATE 全识别），
 *     可控时钟用于过期 / 5 分钟兜底窗口。
 *   - RuntimeContext 用 buildRuntimeContext 构造（与生产路径一致）。
 *
 * 注：所有 DB 行为由内存版 fake 模拟；切片 20 完整化 mysql2 pool 后会有集成测试覆盖端到端。
 * 项目当前不含 test:integration 流水线（任务卡 §9 4-8 步整合落地），
 * 本文件用 fake 还原相同语义达成 11 步验收（含覆盖率 ≥ 90%）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  BizError,
  type DraftItem,
  type DraftStatus,
} from '@storepilot/shared-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type AgentRuntime, buildRuntimeContext } from '../mastra/runtime-context.js';

import {
  TERMINAL_STATUSES,
  TRANSITIONS,
  __testInternals,
  assertDraftTransitAllowed,
  create,
  findRecentDraft,
  getByIdStrict,
  getRegisteredDraftPool,
  markSubmitted,
  newDraftId,
  parseDraftRow,
  resetDraftManagerForTest,
  setDraftPool,
  stripUndefinedDeep,
  transit,
  updateItems,
  type DraftPool,
  type DraftRow,
} from './draft-manager.js';

/* ============================================================================
 * Fake DraftPool —— 用 in-memory Map 模拟 mysql2 Pool 的最小子集
 * ========================================================================== */

interface FakeRow {
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

class FakeDraftPool implements DraftPool {
  /** 行存储（keyed by draft_id） */
  public rows = new Map<string, FakeRow>();
  /** SQL 调用历史（用于断言短事务边界 / SQL 形态） */
  public calls: Array<{ kind: 'query' | 'execute'; sql: string; params: unknown[] }> = [];
  /** 可控时钟：所有 NOW(3) 等价 = clock；调用 advance(ms) 可前推 */
  public clock = new Date('2026-05-07T01:00:00.000Z');

  advance(ms: number): void {
    this.clock = new Date(this.clock.getTime() + ms);
  }

  setClock(d: Date | string): void {
    this.clock = typeof d === 'string' ? new Date(d) : d;
  }

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
      norm.includes('merchant_id = ?') &&
      norm.includes('store_id = ?') &&
      norm.includes('LIMIT 1')
    ) {
      const [draftId, merchantId, storeId] = params as [string, string, string];
      const row = this.rows.get(draftId);
      const matched =
        row && row.merchant_id === merchantId && row.store_id === storeId ? row : null;
      return Promise.resolve([(matched ? [toDbRow(matched)] : []) as unknown as T[], undefined]);
    }

    // findRecentDraft
    if (
      norm.startsWith('SELECT') &&
      norm.includes('FROM replenishment_draft') &&
      norm.includes('user_id = ?') &&
      norm.includes(`status IN ('DRAFT', 'WAIT_CONFIRM', 'CONFIRMED')`) &&
      norm.includes('created_at > NOW(3) - INTERVAL ? MINUTE') &&
      norm.includes('ORDER BY created_at DESC') &&
      norm.includes('LIMIT 5')
    ) {
      const [merchantId, storeId, userId, withinMinutes] = params as [
        string,
        string,
        string,
        number,
      ];
      const cutoff = new Date(this.clock.getTime() - withinMinutes * 60_000);
      const matched = [...this.rows.values()]
        .filter(
          (r) =>
            r.merchant_id === merchantId &&
            r.store_id === storeId &&
            r.user_id === userId &&
            (['DRAFT', 'WAIT_CONFIRM', 'CONFIRMED'] as DraftStatus[]).includes(r.status) &&
            r.created_at > cutoff,
        )
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
        .slice(0, 5)
        .map(toDbRow);
      return Promise.resolve([matched as unknown as T[], undefined]);
    }

    throw new Error(`FakeDraftPool: 未识别的 query SQL: ${norm}`);
  }

  execute(
    sql: string,
    params: readonly unknown[],
  ): Promise<[{ affectedRows: number }, unknown]> {
    this.calls.push({ kind: 'execute', sql, params: [...params] });
    const norm = normalize(sql);

    // INSERT (create)
    if (norm.startsWith('INSERT INTO replenishment_draft')) {
      const [
        draftId,
        sessionId,
        merchantId,
        storeId,
        userId,
        traceId,
        forecastDays,
        itemsJson,
        strategyVersion,
      ] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
        number,
        string,
        string,
      ];
      const items = JSON.parse(itemsJson) as DraftItem[];
      this.rows.set(draftId, {
        draft_id: draftId,
        session_id: sessionId,
        merchant_id: merchantId,
        store_id: storeId,
        user_id: userId,
        trace_id: traceId,
        forecast_days: forecastDays,
        status: 'DRAFT',
        items,
        strategy_version: strategyVersion,
        submitted_po_no: null,
        expires_at: new Date(this.clock.getTime() + 30 * 60_000),
        created_at: this.clock,
        updated_at: this.clock,
      });
      return Promise.resolve([{ affectedRows: 1 }, undefined]);
    }

    // updateItems UPDATE（切片 15）—— 必须在 transit 通用之前匹配
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
      const row = this.rows.get(draftId);
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

    // markSubmitted UPDATE（必须先匹配，因为通用 transit UPDATE 也以 SET status= 开头）
    if (
      norm.startsWith('UPDATE replenishment_draft') &&
      norm.includes(`SET status = 'SUBMITTED'`) &&
      norm.includes(`status = 'CONFIRMED'`)
    ) {
      const [poNo, draftId, merchantId, storeId] = params as [
        string,
        string,
        string,
        string,
      ];
      const row = this.rows.get(draftId);
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

    // 过期 Job（必须先匹配，避免 transit 通用 SET status = ? 落入这里）
    if (
      norm.startsWith('UPDATE replenishment_draft') &&
      norm.includes(`SET status = 'EXPIRED'`) &&
      norm.includes(`status IN ('DRAFT', 'WAIT_CONFIRM')`) &&
      norm.includes('updated_at < NOW(3) - INTERVAL 30 MINUTE') &&
      norm.includes('LIMIT ?')
    ) {
      const [limit] = params as [number];
      const cutoff = new Date(this.clock.getTime() - 30 * 60_000);
      let count = 0;
      for (const r of this.rows.values()) {
        if (count >= limit) break;
        if (
          (r.status === 'DRAFT' || r.status === 'WAIT_CONFIRM') &&
          r.updated_at < cutoff
        ) {
          r.status = 'EXPIRED';
          r.updated_at = this.clock;
          count += 1;
        }
      }
      return Promise.resolve([{ affectedRows: count }, undefined]);
    }

    // transit 通用 UPDATE
    if (
      norm.startsWith('UPDATE replenishment_draft') &&
      norm.includes('SET status = ?') &&
      norm.includes('updated_at = NOW(3)') &&
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
      const row = this.rows.get(draftId);
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

    throw new Error(`FakeDraftPool: 未识别的 execute SQL: ${norm}`);
  }
}

/** 把 SQL 标准化为单行单空格，便于 includes 匹配（仅在 FakeDraftPool 内使用） */
function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function toDbRow(r: FakeRow): DraftRow {
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
 * 测试 fixtures
 * ========================================================================== */

const RUNTIME_A: AgentRuntime = {
  traceId: 'trace_test_A',
  sessionId: 'sess_A',
  merchantId: 'M-A',
  storeId: 'S-A',
  userId: 'U-A',
  apiKeyPrefix: 'sk-agent-aaaa',
  requestStartedAt: 0,
};
const RUNTIME_B: AgentRuntime = {
  ...RUNTIME_A,
  traceId: 'trace_test_B',
  sessionId: 'sess_B',
  merchantId: 'M-B',
  storeId: 'S-B',
  userId: 'U-B',
  apiKeyPrefix: 'sk-agent-bbbb',
};

function ctx(input: AgentRuntime = RUNTIME_A) {
  return buildRuntimeContext(input);
}

function sampleItems(): DraftItem[] {
  return [
    {
      skuId: 'SKU-1',
      skuName: '可乐',
      unit: '瓶',
      baseSuggestQty: 10,
      finalSuggestQty: 12,
      reason: '上周热销',
      adjustmentTrace: [],
    },
    {
      skuId: 'SKU-2',
      skuName: '雪碧',
      unit: '瓶',
      baseSuggestQty: 5,
      finalSuggestQty: 5,
      reason: '保持',
      adjustmentTrace: [],
    },
  ];
}

async function seedConfirmedDraft(pool: FakeDraftPool): Promise<string> {
  const draft = await create({
    sessionId: 'sess_A',
    merchantId: 'M-A',
    storeId: 'S-A',
    userId: 'U-A',
    traceId: 'trace_x',
    forecastDays: 7,
    items: sampleItems(),
    strategyVersion: 'M0-S0-Pp-1',
  });
  await transit({ draftId: draft.draftId, from: 'DRAFT', to: 'WAIT_CONFIRM', runtimeContext: ctx() });
  await transit({
    draftId: draft.draftId,
    from: 'WAIT_CONFIRM',
    to: 'CONFIRMED',
    runtimeContext: ctx(),
  });
  void pool;
  return draft.draftId;
}

let pool: FakeDraftPool;

beforeEach(() => {
  pool = new FakeDraftPool();
  setDraftPool(pool);
});

afterEach(() => {
  resetDraftManagerForTest();
});

/* ============================================================================
 * §9.1 / §10.1 — 状态机 happy path
 * ========================================================================== */

describe('safety/draft-manager — 状态机 happy', () => {
  it('DRAFT → WAIT_CONFIRM → CONFIRMED → SUBMITTED 全成功', async () => {
    const draft = await create({
      sessionId: 'sess_A',
      merchantId: 'M-A',
      storeId: 'S-A',
      userId: 'U-A',
      traceId: 'trace_x',
      forecastDays: 7,
      items: sampleItems(),
      strategyVersion: 'v1',
    });
    expect(draft.status).toBe('DRAFT');
    expect(draft.draftId).toMatch(/^drf_[a-z0-9]{16,32}$/);

    await transit({
      draftId: draft.draftId,
      from: 'DRAFT',
      to: 'WAIT_CONFIRM',
      runtimeContext: ctx(),
    });
    let cur = await getByIdStrict(draft.draftId, ctx());
    expect(cur.status).toBe('WAIT_CONFIRM');

    await transit({
      draftId: draft.draftId,
      from: 'WAIT_CONFIRM',
      to: 'CONFIRMED',
      runtimeContext: ctx(),
    });
    cur = await getByIdStrict(draft.draftId, ctx());
    expect(cur.status).toBe('CONFIRMED');

    await markSubmitted(draft.draftId, 'PO-1001', ctx());
    cur = await getByIdStrict(draft.draftId, ctx());
    expect(cur.status).toBe('SUBMITTED');
    expect(cur.submittedPoNo).toBe('PO-1001');
  });

  it('DRAFT → CANCELLED 终止（用户主动取消）', async () => {
    const draft = await create({
      sessionId: 'sess_A',
      merchantId: 'M-A',
      storeId: 'S-A',
      userId: 'U-A',
      traceId: 'trace_x',
      forecastDays: 7,
      items: sampleItems(),
      strategyVersion: 'v1',
    });
    await transit({
      draftId: draft.draftId,
      from: 'DRAFT',
      to: 'CANCELLED',
      runtimeContext: ctx(),
    });
    const cur = await getByIdStrict(draft.draftId, ctx());
    expect(cur.status).toBe('CANCELLED');
  });

  it('CONFIRMED → FAILED（采购单创建失败的兜底）', async () => {
    const id = await seedConfirmedDraft(pool);
    await transit({
      draftId: id,
      from: 'CONFIRMED',
      to: 'FAILED',
      runtimeContext: ctx(),
    });
    expect((await getByIdStrict(id, ctx())).status).toBe('FAILED');
  });
});

/* ============================================================================
 * §9.2 / §10.2 — 非法流转
 * ========================================================================== */

describe('safety/draft-manager — 非法流转抛 SCHEMA_FAIL', () => {
  it('CONFIRMED → DRAFT 抛 SCHEMA_FAIL', () => {
    expect(() => assertDraftTransitAllowed('CONFIRMED', 'DRAFT')).toThrowError(
      /非法状态流转 CONFIRMED -> DRAFT/,
    );
  });

  it('DRAFT → CONFIRMED 抛 SCHEMA_FAIL（必须经 WAIT_CONFIRM）', () => {
    expect(() => assertDraftTransitAllowed('DRAFT', 'CONFIRMED')).toThrow();
  });

  it('DRAFT → SUBMITTED 抛 SCHEMA_FAIL', () => {
    expect(() => assertDraftTransitAllowed('DRAFT', 'SUBMITTED')).toThrow();
  });

  it('WAIT_CONFIRM → SUBMITTED 抛 SCHEMA_FAIL', () => {
    expect(() => assertDraftTransitAllowed('WAIT_CONFIRM', 'SUBMITTED')).toThrow();
  });

  it('transit 在状态机非法时不打 DB（先校验后查询）', async () => {
    const draft = await create({
      sessionId: 'sess_A',
      merchantId: 'M-A',
      storeId: 'S-A',
      userId: 'U-A',
      traceId: 'trace_x',
      forecastDays: 7,
      items: sampleItems(),
      strategyVersion: 'v1',
    });
    pool.calls.length = 0;
    await expect(
      transit({
        draftId: draft.draftId,
        from: 'DRAFT',
        to: 'CONFIRMED',
        runtimeContext: ctx(),
      }),
    ).rejects.toThrow(/非法状态流转/);
    // 状态机失败后不应触发 UPDATE
    expect(pool.calls.filter((c) => c.kind === 'execute').length).toBe(0);
  });
});

/* ============================================================================
 * §9.3 / §10.3 — 终态不可流转
 * ========================================================================== */

describe('safety/draft-manager — 终态不可流转', () => {
  for (const term of ['SUBMITTED', 'EXPIRED', 'CANCELLED', 'FAILED'] as DraftStatus[]) {
    it(`终态 ${term} 不可流转到任何状态`, () => {
      const targets: DraftStatus[] = [
        'DRAFT',
        'WAIT_CONFIRM',
        'CONFIRMED',
        'SUBMITTED',
        'EXPIRED',
        'CANCELLED',
        'FAILED',
      ];
      for (const to of targets) {
        expect(() => assertDraftTransitAllowed(term, to)).toThrow();
      }
    });
  }

  it('TRANSITIONS 4 终态全部映射空数组', () => {
    expect(TRANSITIONS.get('SUBMITTED')).toEqual([]);
    expect(TRANSITIONS.get('EXPIRED')).toEqual([]);
    expect(TRANSITIONS.get('CANCELLED')).toEqual([]);
    expect(TRANSITIONS.get('FAILED')).toEqual([]);
  });

  it('TERMINAL_STATUSES Set 包含且仅包含 4 终态', () => {
    expect(TERMINAL_STATUSES.size).toBe(4);
    for (const s of ['SUBMITTED', 'EXPIRED', 'CANCELLED', 'FAILED'] as DraftStatus[]) {
      expect(TERMINAL_STATUSES.has(s)).toBe(true);
    }
    for (const s of ['DRAFT', 'WAIT_CONFIRM', 'CONFIRMED'] as DraftStatus[]) {
      expect(TERMINAL_STATUSES.has(s)).toBe(false);
    }
  });
});

/* ============================================================================
 * §9.4 / §10.4 — 跨租户硬隔离
 * ========================================================================== */

describe('safety/draft-manager — 跨租户硬隔离', () => {
  it('商家 A 用 B 的 draftId 查询 → DRAFT_NOT_FOUND', async () => {
    const draftA = await create({
      sessionId: 'sess_A',
      merchantId: 'M-A',
      storeId: 'S-A',
      userId: 'U-A',
      traceId: 'trace_x',
      forecastDays: 7,
      items: sampleItems(),
      strategyVersion: 'v1',
    });
    await expect(getByIdStrict(draftA.draftId, ctx(RUNTIME_B))).rejects.toMatchObject({
      code: 'DRAFT_NOT_FOUND',
    });
  });

  it('跨租户 transit → SCHEMA_FAIL（affectedRows=0）', async () => {
    const draftA = await create({
      sessionId: 'sess_A',
      merchantId: 'M-A',
      storeId: 'S-A',
      userId: 'U-A',
      traceId: 'trace_x',
      forecastDays: 7,
      items: sampleItems(),
      strategyVersion: 'v1',
    });
    await expect(
      transit({
        draftId: draftA.draftId,
        from: 'DRAFT',
        to: 'WAIT_CONFIRM',
        runtimeContext: ctx(RUNTIME_B),
      }),
    ).rejects.toMatchObject({ code: 'SCHEMA_FAIL' });
  });

  it('getByIdStrict 抛错时 meta 含 draftId / merchantId / storeId（便于审计）', async () => {
    try {
      await getByIdStrict('drf_nonexistent000000000', ctx());
      expect.fail('should throw');
    } catch (e) {
      expect((e as { code: string }).code).toBe('DRAFT_NOT_FOUND');
      expect((e as { meta: Record<string, unknown> }).meta.draftId).toBe(
        'drf_nonexistent000000000',
      );
      expect((e as { meta: Record<string, unknown> }).meta.merchantId).toBe('M-A');
      expect((e as { meta: Record<string, unknown> }).meta.storeId).toBe('S-A');
    }
  });

  it('getByIdStrict SQL 必须同时带 merchant_id 与 store_id（防遗漏）', async () => {
    const draft = await create({
      sessionId: 'sess_A',
      merchantId: 'M-A',
      storeId: 'S-A',
      userId: 'U-A',
      traceId: 'trace_x',
      forecastDays: 7,
      items: sampleItems(),
      strategyVersion: 'v1',
    });
    pool.calls.length = 0;
    await getByIdStrict(draft.draftId, ctx());
    const sql = pool.calls.at(-1)!.sql;
    expect(sql).toMatch(/merchant_id\s*=\s*\?/i);
    expect(sql).toMatch(/store_id\s*=\s*\?/i);
    expect(sql).toMatch(/draft_id\s*=\s*\?/i);
    expect(sql).toMatch(/LIMIT\s+1/i);
  });
});

/* ============================================================================
 * §9.5 / §10.5-§10.7 — 30 分钟过期 + CONFIRMED 不过期（由 expireDraftsJob 单测覆盖完整路径）
 * ========================================================================== */

describe('safety/draft-manager — 30 分钟过期边界', () => {
  it('刚创建 → expires_at 在 30 分钟后', async () => {
    const draft = await create({
      sessionId: 'sess_A',
      merchantId: 'M-A',
      storeId: 'S-A',
      userId: 'U-A',
      traceId: 'trace_x',
      forecastDays: 7,
      items: sampleItems(),
      strategyVersion: 'v1',
    });
    const expiresAt = new Date(draft.expiresAt).getTime();
    const createdAt = new Date(draft.createdAt).getTime();
    expect(expiresAt - createdAt).toBeGreaterThanOrEqual(29 * 60_000);
    expect(expiresAt - createdAt).toBeLessThanOrEqual(31 * 60_000);
  });

  it('INSERT 语句中 expires_at 表达式为 NOW(3) + INTERVAL 30 MINUTE', async () => {
    await create({
      sessionId: 'sess_A',
      merchantId: 'M-A',
      storeId: 'S-A',
      userId: 'U-A',
      traceId: 'trace_x',
      forecastDays: 7,
      items: sampleItems(),
      strategyVersion: 'v1',
    });
    const insert = pool.calls.find((c) => c.sql.includes('INSERT INTO replenishment_draft'));
    expect(insert).toBeDefined();
    expect(normalizeSql(insert!.sql)).toContain('NOW(3) + INTERVAL 30 MINUTE');
  });
});

/* ============================================================================
 * §9.6 / §10.8-§10.9 — 5 分钟兜底索引
 * ========================================================================== */

describe('safety/draft-manager — findRecentDraft 5 分钟兜底', () => {
  it('sessionId 漂移：5 分钟内未提交草稿可被找回（status DRAFT/WAIT_CONFIRM/CONFIRMED）', async () => {
    pool.setClock('2026-05-07T01:00:00.000Z');
    // 4 分钟前创建
    pool.advance(-4 * 60_000);
    const draft = await create({
      sessionId: 'sess_A_old',
      merchantId: 'M-A',
      storeId: 'S-A',
      userId: 'U-A',
      traceId: 'trace_x',
      forecastDays: 7,
      items: sampleItems(),
      strategyVersion: 'v1',
    });
    pool.advance(4 * 60_000);

    const recent = await findRecentDraft(ctx(), 5);
    expect(recent.length).toBe(1);
    const [first] = recent;
    expect(first).toBeDefined();
    expect(first?.draftId).toBe(draft.draftId);
  });

  it('6 分钟前的草稿不返回（兜底窗口外）', async () => {
    pool.setClock('2026-05-07T01:00:00.000Z');
    pool.advance(-6 * 60_000);
    await create({
      sessionId: 'sess_A_old',
      merchantId: 'M-A',
      storeId: 'S-A',
      userId: 'U-A',
      traceId: 'trace_x',
      forecastDays: 7,
      items: sampleItems(),
      strategyVersion: 'v1',
    });
    pool.advance(6 * 60_000);

    expect((await findRecentDraft(ctx(), 5)).length).toBe(0);
  });

  it('终态草稿（CANCELLED / SUBMITTED / EXPIRED / FAILED）不参与兜底', async () => {
    const draft = await create({
      sessionId: 'sess_A',
      merchantId: 'M-A',
      storeId: 'S-A',
      userId: 'U-A',
      traceId: 'trace_x',
      forecastDays: 7,
      items: sampleItems(),
      strategyVersion: 'v1',
    });
    await transit({
      draftId: draft.draftId,
      from: 'DRAFT',
      to: 'CANCELLED',
      runtimeContext: ctx(),
    });
    expect((await findRecentDraft(ctx(), 5)).length).toBe(0);
  });

  it('跨租户：商家 B 不会看到商家 A 的草稿', async () => {
    await create({
      sessionId: 'sess_A',
      merchantId: 'M-A',
      storeId: 'S-A',
      userId: 'U-A',
      traceId: 'trace_x',
      forecastDays: 7,
      items: sampleItems(),
      strategyVersion: 'v1',
    });
    expect((await findRecentDraft(ctx(RUNTIME_B), 5)).length).toBe(0);
  });

  it('SQL 命中 idx_draft_tenant_recent 三字段 + INTERVAL ? MINUTE', async () => {
    pool.calls.length = 0;
    await findRecentDraft(ctx(), 5);
    const last = pool.calls.at(-1)!;
    const sql = normalizeSql(last.sql);
    expect(sql).toContain('merchant_id = ?');
    expect(sql).toContain('store_id = ?');
    expect(sql).toContain('user_id = ?');
    expect(sql).toContain("status IN ('DRAFT', 'WAIT_CONFIRM', 'CONFIRMED')");
    expect(sql).toContain('created_at > NOW(3) - INTERVAL ? MINUTE');
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(sql).toContain('LIMIT 5');
    expect(last.params).toEqual(['M-A', 'S-A', 'U-A', 5]);
  });

  it('LIMIT 5：超过 5 条只返回最近 5 条', async () => {
    pool.setClock('2026-05-07T01:00:00.000Z');
    for (let i = 0; i < 7; i += 1) {
      pool.advance(-(i * 100));
      await create({
        sessionId: `sess_${i}`,
        merchantId: 'M-A',
        storeId: 'S-A',
        userId: 'U-A',
        traceId: `trace_${i}`,
        forecastDays: 7,
        items: sampleItems(),
        strategyVersion: 'v1',
      });
      pool.advance(i * 100);
    }
    expect((await findRecentDraft(ctx(), 5)).length).toBe(5);
  });

  it('默认 withinMinutes=5（不传第二参数）', async () => {
    pool.calls.length = 0;
    await findRecentDraft(ctx());
    const last = pool.calls.at(-1)!;
    expect(last.params.at(-1)).toBe(5);
  });
});

/* ============================================================================
 * §9.7 / §10.10-§10.11 — markSubmitted 幂等 + 冲突
 * ========================================================================== */

describe('safety/draft-manager — markSubmitted 幂等', () => {
  it('CONFIRMED → markSubmitted PO1 → 再 markSubmitted PO1：第二次无 UPDATE', async () => {
    const id = await seedConfirmedDraft(pool);
    await markSubmitted(id, 'PO-1001', ctx());
    pool.calls.length = 0;
    await markSubmitted(id, 'PO-1001', ctx());
    // 仅 SELECT，不 UPDATE
    expect(pool.calls.filter((c) => c.kind === 'execute').length).toBe(0);
    const after = await getByIdStrict(id, ctx());
    expect(after.status).toBe('SUBMITTED');
    expect(after.submittedPoNo).toBe('PO-1001');
  });

  it('已 SUBMITTED PO1 后再 markSubmitted PO2 → DRAFT_ALREADY_SUBMITTED', async () => {
    const id = await seedConfirmedDraft(pool);
    await markSubmitted(id, 'PO-1001', ctx());
    await expect(markSubmitted(id, 'PO-2002', ctx())).rejects.toMatchObject({
      code: 'DRAFT_ALREADY_SUBMITTED',
    });
  });

  it('未 CONFIRMED 直接 markSubmitted → SCHEMA_FAIL（状态机非法）', async () => {
    const draft = await create({
      sessionId: 'sess_A',
      merchantId: 'M-A',
      storeId: 'S-A',
      userId: 'U-A',
      traceId: 'trace_x',
      forecastDays: 7,
      items: sampleItems(),
      strategyVersion: 'v1',
    });
    await expect(markSubmitted(draft.draftId, 'PO-1', ctx())).rejects.toMatchObject({
      code: 'SCHEMA_FAIL',
    });
  });

  it('跨租户 markSubmitted → DRAFT_NOT_FOUND（getByIdStrict 拦截）', async () => {
    const id = await seedConfirmedDraft(pool);
    await expect(markSubmitted(id, 'PO-1', ctx(RUNTIME_B))).rejects.toMatchObject({
      code: 'DRAFT_NOT_FOUND',
    });
  });

  it('markSubmitted UPDATE WHERE 必须含 status = CONFIRMED（防止"先读后写"窗口被并发流转）', async () => {
    const id = await seedConfirmedDraft(pool);
    pool.calls.length = 0;
    await markSubmitted(id, 'PO-X', ctx());
    const updateCall = pool.calls.find(
      (c) => c.kind === 'execute' && c.sql.includes(`SET status = 'SUBMITTED'`),
    );
    expect(updateCall).toBeDefined();
    expect(normalizeSql(updateCall!.sql)).toContain("status = 'CONFIRMED'");
  });

  it('markSubmitted 在 SELECT 后、UPDATE 前被并发改 → SCHEMA_FAIL（UPDATE affectedRows=0 兜底）', async () => {
    const id = await seedConfirmedDraft(pool);
    // 注入"SELECT 后改状态"的 hook：包装原 query，让其在第一次 getByIdStrict
    // 返回 CONFIRMED 视图后立刻把内存行改成 FAILED；
    // 此时 markSubmitted 走完 assertDraftTransitAllowed('CONFIRMED','SUBMITTED') 进入 UPDATE，
    // UPDATE WHERE status='CONFIRMED' 已不满足 → affectedRows=0 → 触发末段 SCHEMA_FAIL 分支。
    const originalQuery = pool.query.bind(pool);
    pool.query = ((sql: string, params: readonly unknown[]) =>
      originalQuery(sql, params).then((res) => {
        const row = pool.rows.get(id);
        if (row && row.status === 'CONFIRMED') row.status = 'FAILED';
        return res;
      })) as typeof pool.query;

    await expect(markSubmitted(id, 'PO-X', ctx())).rejects.toMatchObject({
      code: 'SCHEMA_FAIL',
    });
  });

  it('markSubmitted 在 SELECT 之前已被改成非 CONFIRMED → 状态机 SCHEMA_FAIL（提前拦截）', async () => {
    const id = await seedConfirmedDraft(pool);
    pool.rows.get(id)!.status = 'FAILED';
    await expect(markSubmitted(id, 'PO-1', ctx())).rejects.toMatchObject({
      code: 'SCHEMA_FAIL',
    });
  });
});

/* ============================================================================
 * §10.14 — 并发修改保护（affectedRows=0 抛 SCHEMA_FAIL）
 * ========================================================================== */

describe('safety/draft-manager — 并发修改保护', () => {
  it('两个事务同时 transit DRAFT → WAIT_CONFIRM：第二个抛 SCHEMA_FAIL', async () => {
    const draft = await create({
      sessionId: 'sess_A',
      merchantId: 'M-A',
      storeId: 'S-A',
      userId: 'U-A',
      traceId: 'trace_x',
      forecastDays: 7,
      items: sampleItems(),
      strategyVersion: 'v1',
    });
    await transit({
      draftId: draft.draftId,
      from: 'DRAFT',
      to: 'WAIT_CONFIRM',
      runtimeContext: ctx(),
    });
    // 第二个事务还在用旧 from='DRAFT' 调用 → affectedRows=0
    await expect(
      transit({
        draftId: draft.draftId,
        from: 'DRAFT',
        to: 'WAIT_CONFIRM',
        runtimeContext: ctx(),
      }),
    ).rejects.toMatchObject({ code: 'SCHEMA_FAIL' });
  });

  it('transit 不存在的 draftId → SCHEMA_FAIL（不暴露存在与否，避免侧信道）', async () => {
    await expect(
      transit({
        draftId: 'drf_doesnotexist00000000',
        from: 'DRAFT',
        to: 'WAIT_CONFIRM',
        runtimeContext: ctx(),
      }),
    ).rejects.toMatchObject({ code: 'SCHEMA_FAIL' });
  });
});

/* ============================================================================
 * items JSON / stripUndefinedDeep
 * ========================================================================== */

describe('safety/draft-manager — items 序列化 / stripUndefinedDeep', () => {
  it('items 入库走 JSON.stringify(stripUndefinedDeep)：嵌套 undefined 字段不入库', async () => {
    const items = [
      {
        skuId: 'SKU-3',
        skuName: '矿泉水',
        unit: '瓶',
        baseSuggestQty: 6,
        finalSuggestQty: 6,
        reason: 'ok',
        adjustmentTrace: [],
        // 故意混入 undefined 字段（DraftItem schema 没有，但运行时存在的杂质）
        extra: undefined,
      } as unknown as DraftItem,
    ];
    await create({
      sessionId: 'sess_A',
      merchantId: 'M-A',
      storeId: 'S-A',
      userId: 'U-A',
      traceId: 'trace_x',
      forecastDays: 7,
      items,
      strategyVersion: 'v1',
    });
    const insert = pool.calls.find((c) => c.sql.includes('INSERT INTO replenishment_draft'))!;
    const itemsJson = insert.params[7] as string;
    expect(itemsJson).toContain('SKU-3');
    expect(itemsJson).not.toContain('"extra"');
  });

  it('stripUndefinedDeep：null 保留 / undefined 剥离 / 数组 undefined 剥离', () => {
    const v = stripUndefinedDeep({
      a: 1,
      b: undefined,
      c: null,
      d: [1, undefined, 2, { x: undefined, y: 3 }],
      nested: { k: undefined, n: { z: 4 } },
    } as Record<string, unknown>);
    expect(v).toEqual({
      a: 1,
      c: null,
      d: [1, 2, { y: 3 }],
      nested: { n: { z: 4 } },
    });
  });

  it('stripUndefinedDeep：Date / Buffer / 类对象不递归', () => {
    const d = new Date();
    const v = stripUndefinedDeep({ d });
    expect(v.d).toBe(d);
  });

  it('parseDraftRow：items 列字符串与数组双形兼容', () => {
    const base = {
      draft_id: 'drf_aaaa1111bbbb2222cccc',
      session_id: 'S',
      merchant_id: 'M',
      store_id: 'St',
      user_id: 'U',
      trace_id: 'T',
      forecast_days: 7,
      status: 'DRAFT' as DraftStatus,
      strategy_version: 'v',
      submitted_po_no: null,
      expires_at: new Date('2026-05-07T01:30:00.000Z'),
      created_at: new Date('2026-05-07T01:00:00.000Z'),
      updated_at: new Date('2026-05-07T01:00:00.000Z'),
    };
    const fromArr = parseDraftRow({ ...base, items: sampleItems() });
    const fromStr = parseDraftRow({ ...base, items: JSON.stringify(sampleItems()) });
    expect(fromArr.items).toEqual(fromStr.items);
  });

  it('parseDraftRow：items 字符串解析失败时退化为空数组（防止 LLM 反解析）', () => {
    const v = parseDraftRow({
      draft_id: 'drf_aaaa1111bbbb2222cccc',
      session_id: 'S',
      merchant_id: 'M',
      store_id: 'St',
      user_id: 'U',
      trace_id: 'T',
      forecast_days: 7,
      status: 'DRAFT',
      items: 'not-json{{{',
      strategy_version: 'v',
      submitted_po_no: null,
      expires_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(v.items).toEqual([]);
  });

  it('parseDraftRow：items 字符串 JSON 但非数组 → 空数组', () => {
    const v = parseDraftRow({
      draft_id: 'drf_aaaa1111bbbb2222cccc',
      session_id: 'S',
      merchant_id: 'M',
      store_id: 'St',
      user_id: 'U',
      trace_id: 'T',
      forecast_days: 7,
      status: 'DRAFT',
      items: '{"a":1}',
      strategy_version: 'v',
      submitted_po_no: null,
      expires_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(v.items).toEqual([]);
  });

  it('parseDraftRow：expires_at / created_at / updated_at Date / string 双形归一', () => {
    const dateForm = parseDraftRow({
      draft_id: 'drf_aaaa1111bbbb2222cccc',
      session_id: 'S',
      merchant_id: 'M',
      store_id: 'St',
      user_id: 'U',
      trace_id: 'T',
      forecast_days: 7,
      status: 'DRAFT',
      items: [],
      strategy_version: 'v',
      submitted_po_no: null,
      expires_at: new Date('2026-05-07T01:30:00.000Z'),
      created_at: new Date('2026-05-07T01:00:00.000Z'),
      updated_at: new Date('2026-05-07T01:00:00.000Z'),
    });
    const stringForm = parseDraftRow({
      draft_id: 'drf_aaaa1111bbbb2222cccc',
      session_id: 'S',
      merchant_id: 'M',
      store_id: 'St',
      user_id: 'U',
      trace_id: 'T',
      forecast_days: 7,
      status: 'DRAFT',
      items: [],
      strategy_version: 'v',
      submitted_po_no: null,
      expires_at: '2026-05-07T01:30:00.000Z',
      created_at: '2026-05-07T01:00:00.000Z',
      updated_at: '2026-05-07T01:00:00.000Z',
    });
    expect(dateForm.expiresAt).toBe(stringForm.expiresAt);
    expect(dateForm.createdAt).toBe(stringForm.createdAt);
  });
});

/* ============================================================================
 * §9.9 — 短事务 grep
 * ========================================================================== */

describe('safety/draft-manager — 短事务边界（grep）', () => {
  const here = fileURLToPath(new URL('./draft-manager.ts', import.meta.url));
  const src = readFileSync(here, 'utf8');

  it('源文件不出现 BEGIN / START TRANSACTION（任务卡 §9.9）', () => {
    expect(src).not.toMatch(/\bBEGIN\b/);
    expect(src).not.toMatch(/\bSTART\s+TRANSACTION\b/i);
  });

  it('源文件不出现 await mcp / openai / anthropic / llm（避免事务内 await 上游）', () => {
    expect(src).not.toMatch(/await\s+[^;]*\b(mcp|openai|anthropic|llm)\b/i);
  });

  it('源文件不 import @mastra/mcp / @ai-sdk / openai（业务安全层零上游依赖）', () => {
    expect(src).not.toMatch(/from\s+['"]@mastra\/mcp['"]/);
    expect(src).not.toMatch(/from\s+['"]@ai-sdk\//);
    expect(src).not.toMatch(/from\s+['"]openai['"]/);
  });
});

/* ============================================================================
 * Pool DI / 兜底
 * ========================================================================== */

describe('safety/draft-manager — Pool DI / 兜底', () => {
  it('未注入 Pool → create 抛错（防生产忘记 bootstrap）', async () => {
    resetDraftManagerForTest();
    const caught: unknown = await create({
      sessionId: 'S',
      merchantId: 'M',
      storeId: 'St',
      userId: 'U',
      traceId: 'T',
      forecastDays: 7,
      items: [],
      strategyVersion: 'v',
    }).catch((err: unknown) => err);
    expect(caught).toBeInstanceOf(BizError);
    if (!(caught instanceof BizError)) throw new Error('expected BizError');
    expect(caught.code).toBe('INTERNAL_ERROR');
    expect(caught.message).toMatch(/DraftPool 未注入/);
  });

  it('getRegisteredDraftPool 返回当前注入的 pool', () => {
    expect(getRegisteredDraftPool()).toBe(pool);
  });

  it('__testInternals.getRegisteredPool 在 reset 后返回 null', () => {
    resetDraftManagerForTest();
    expect(__testInternals.getRegisteredPool()).toBeNull();
  });

  it('newDraftId 输出符合 ReplenishmentDraft.draftId 正则', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(newDraftId()).toMatch(/^drf_[a-z0-9]{16,32}$/);
    }
  });
});

/* ============================================================================
 * updateItems —— 切片 15 调整 SSOT 写回 items
 * ========================================================================== */

describe('safety/draft-manager — updateItems（切片 15 调整 SSOT）', () => {
  it('DRAFT 状态可写：affectedRows=1，items 写入并刷新 updated_at', async () => {
    const draft = await create({
      sessionId: 'sess_U1',
      merchantId: 'M-A',
      storeId: 'S-A',
      userId: 'U-A',
      traceId: 'trace_u1',
      forecastDays: 7,
      items: sampleItems(),
      strategyVersion: 'v1',
    });
    const before = await getByIdStrict(draft.draftId, ctx());
    pool.advance(1500);

    const newItems: DraftItem[] = sampleItems().map((it) => ({
      ...it,
      finalSuggestQty: it.finalSuggestQty + 1,
      adjustmentTrace: [...(it.adjustmentTrace ?? []), 'INCREASE_QTY +1'],
    }));

    const affected = await updateItems({
      draftId: draft.draftId,
      items: newItems,
      runtimeContext: ctx(),
    });
    expect(affected).toBe(1);

    const after = await getByIdStrict(draft.draftId, ctx());
    expect(after.items).toEqual(newItems);
    expect(new Date(after.updatedAt).getTime()).toBeGreaterThan(
      new Date(before.updatedAt).getTime(),
    );
  });

  it('WAIT_CONFIRM / CONFIRMED 也可写（切片 15 允许调整后未提交的草稿）', async () => {
    const a = await create({
      sessionId: 'sess_U2',
      merchantId: 'M-A',
      storeId: 'S-A',
      userId: 'U-A',
      traceId: 'trace_u2',
      forecastDays: 7,
      items: sampleItems(),
      strategyVersion: 'v1',
    });
    await transit({
      draftId: a.draftId,
      from: 'DRAFT',
      to: 'WAIT_CONFIRM',
      runtimeContext: ctx(),
    });
    const aff1 = await updateItems({
      draftId: a.draftId,
      items: sampleItems(),
      runtimeContext: ctx(),
    });
    expect(aff1).toBe(1);

    await transit({
      draftId: a.draftId,
      from: 'WAIT_CONFIRM',
      to: 'CONFIRMED',
      runtimeContext: ctx(),
    });
    const aff2 = await updateItems({
      draftId: a.draftId,
      items: sampleItems(),
      runtimeContext: ctx(),
    });
    expect(aff2).toBe(1);
  });

  it('终态 SUBMITTED / EXPIRED / CANCELLED / FAILED 不可写：affectedRows=0', async () => {
    const submittedId = await seedConfirmedDraft(pool);
    await markSubmitted(submittedId, 'PO-U2', ctx());
    expect((await getByIdStrict(submittedId, ctx())).status).toBe('SUBMITTED');
    const aff = await updateItems({
      draftId: submittedId,
      items: sampleItems(),
      runtimeContext: ctx(),
    });
    expect(aff).toBe(0);

    const exp = await create({
      sessionId: 'sess_U3',
      merchantId: 'M-A',
      storeId: 'S-A',
      userId: 'U-A',
      traceId: 'trace_u3',
      forecastDays: 7,
      items: sampleItems(),
      strategyVersion: 'v1',
    });
    await transit({
      draftId: exp.draftId,
      from: 'DRAFT',
      to: 'EXPIRED',
      runtimeContext: ctx(),
    });
    const affExp = await updateItems({
      draftId: exp.draftId,
      items: sampleItems(),
      runtimeContext: ctx(),
    });
    expect(affExp).toBe(0);

    const cancelled = await create({
      sessionId: 'sess_U3b',
      merchantId: 'M-A',
      storeId: 'S-A',
      userId: 'U-A',
      traceId: 'trace_u3b',
      forecastDays: 7,
      items: sampleItems(),
      strategyVersion: 'v1',
    });
    await transit({
      draftId: cancelled.draftId,
      from: 'DRAFT',
      to: 'CANCELLED',
      runtimeContext: ctx(),
    });
    const affCancel = await updateItems({
      draftId: cancelled.draftId,
      items: sampleItems(),
      runtimeContext: ctx(),
    });
    expect(affCancel).toBe(0);
  });

  it('跨租户硬隔离：merchant/store 不一致时 affectedRows=0', async () => {
    const draft = await create({
      sessionId: 'sess_U4',
      merchantId: 'M-A',
      storeId: 'S-A',
      userId: 'U-A',
      traceId: 'trace_u4',
      forecastDays: 7,
      items: sampleItems(),
      strategyVersion: 'v1',
    });
    const aff = await updateItems({
      draftId: draft.draftId,
      items: sampleItems(),
      runtimeContext: ctx(RUNTIME_B),
    });
    expect(aff).toBe(0);
    // 原 items 必须未被改写
    const after = await getByIdStrict(draft.draftId, ctx());
    expect(after.items).toEqual(sampleItems());
  });

  it('items 中的 undefined 字段会被 stripUndefinedDeep 清理，不写入 NULL 噪音', async () => {
    const draft = await create({
      sessionId: 'sess_U5',
      merchantId: 'M-A',
      storeId: 'S-A',
      userId: 'U-A',
      traceId: 'trace_u5',
      forecastDays: 7,
      items: sampleItems(),
      strategyVersion: 'v1',
    });
    const dirty: DraftItem[] = [
      {
        skuId: 'SKU-X',
        skuName: '清洁',
        unit: '瓶',
        baseSuggestQty: 1,
        finalSuggestQty: 2,
        reason: 'r',
        adjustmentTrace: ['INCREASE_QTY +1'],
        // 故意带 undefined 字段（不在 schema 内的 sentinel）
        ...({ ghostField: undefined } as Record<string, unknown>),
      },
    ];
    pool.calls.length = 0;
    const aff = await updateItems({
      draftId: draft.draftId,
      items: dirty,
      runtimeContext: ctx(),
    });
    expect(aff).toBe(1);
    const lastCall = pool.calls.at(-1);
    expect(lastCall).toBeTruthy();
    expect(lastCall!.sql).toMatch(/SET items = CAST\(\? AS JSON\)/);
    // 序列化后不应包含 ghostField
    expect(lastCall!.params[0]).not.toMatch(/ghostField/);
  });

  it('SQL 形态：UPDATE 仅命中 (DRAFT|WAIT_CONFIRM|CONFIRMED) 三态白名单', async () => {
    const draft = await create({
      sessionId: 'sess_U6',
      merchantId: 'M-A',
      storeId: 'S-A',
      userId: 'U-A',
      traceId: 'trace_u6',
      forecastDays: 7,
      items: sampleItems(),
      strategyVersion: 'v1',
    });
    pool.calls.length = 0;
    await updateItems({
      draftId: draft.draftId,
      items: sampleItems(),
      runtimeContext: ctx(),
    });
    const sql = normalizeSql(pool.calls.at(-1)!.sql);
    expect(sql).toMatch(/UPDATE replenishment_draft/);
    expect(sql).toMatch(/SET items = CAST\(\? AS JSON\), updated_at = NOW\(3\)/);
    expect(sql).toMatch(/WHERE draft_id = \? AND merchant_id = \? AND store_id = \?/);
    expect(sql).toMatch(/status IN \('DRAFT', 'WAIT_CONFIRM', 'CONFIRMED'\)/);
  });
});

/* ============================================================================
 * §11 idx_draft_tenant_recent 命中（SQL 形态守门，承担任务卡 §9 第 11 步）
 * ========================================================================== */

describe('safety/draft-manager — idx_draft_tenant_recent 命中', () => {
  it('findRecentDraft 的 SQL WHERE 顺序匹配 idx_draft_tenant_recent (merchant_id, store_id, user_id, created_at)', async () => {
    pool.calls.length = 0;
    await findRecentDraft(ctx(), 5);
    const sql = normalizeSql(pool.calls.at(-1)!.sql);
    // 索引最左前缀依次为 merchant_id → store_id → user_id → created_at；
    // 我们的 WHERE 顺序对优化器友好且与 idx_draft_tenant_recent 完全一致
    const idxMerchant = sql.indexOf('merchant_id = ?');
    const idxStore = sql.indexOf('store_id = ?');
    const idxUser = sql.indexOf('user_id = ?');
    const idxCreated = sql.indexOf('created_at > NOW(3) - INTERVAL ? MINUTE');
    expect(idxMerchant).toBeGreaterThan(-1);
    expect(idxStore).toBeGreaterThan(idxMerchant);
    expect(idxUser).toBeGreaterThan(idxStore);
    expect(idxCreated).toBeGreaterThan(idxUser);
  });
});

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}
