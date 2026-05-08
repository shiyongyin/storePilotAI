/**
 * 切片 16 §9 验收 step 1-4 / 7 / 8 / 11 — ConfirmManager 单测（5 边界 + resume 锁 + 不在事务内 await）
 *
 * 覆盖（任务卡 §10 全部 8 测试场景）:
 *   1. happy: preview → 确认 → CONFIRMED + 锁释放
 *   2. cancel: preview → 取消 → CANCELLED 路径
 *   3. 边界 3: 3 条并发"确认" → 仅 1 条 RESUMED；其余 2 条 RESUME_RACE 幂等
 *   4. 边界 4: 多实例并发 → FOR UPDATE 串行化（fake 用 transaction 队列模拟）
 *   5. 边界 1: 抢占（intent 不属于 CONFIRM/CANCEL） → cancelInflight + tick.kind=CANCELLED
 *   6. 边界 2: 30 分钟过期 → cancelInflight + tick.kind=EXPIRED
 *   7. 边界 5: sessionId 漂移 → DraftManager.findRecentDraft 兜底找回
 *   8. 锁租约 10s: 模拟锁泄漏 → 10s 后下条请求可继续（不死锁）
 *
 * 守门项：
 *   - resume 锁释放：confirmDraft 完成后 UPDATE resume_locked_at = NULL
 *   - 不在事务内 await mastra.resume：transaction 回调内不触发 resume；resume 在 then 块
 *   - cancelInflight 错误 swallow：mastra.resume 抛错不阻断后续清理
 *   - 重复确认 RESUME_RACE 幂等返回（不重复创建采购单）
 *   - tickAtUserMessage 异常 fallback NONE（不阻断业务）
 *
 * 测试基础设施：
 *   - FakeConfirmPool：内存 agent_session + transaction 序列化（保证 FOR UPDATE 排他语义）
 *   - FakeMastraResolver：可注入 resume(args) hook（支持 throw / delay / count）
 *   - DraftManager 复用 draft-manager.test.ts 的 FakeDraftPool 形态：本测试自带最简版
 */
import {
  BizError,
  Intent,
  type DraftItem,
  type DraftStatus,
  type IntentCode,
} from '@storepilot/shared-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildRuntimeContext,
  type AgentRuntime,
  type RuntimeContext,
} from '../mastra/runtime-context.js';

import {
  HITL_WORKFLOW_ID,
  PREEMPT_MARKDOWN_PREFIX,
  RESUME_LOCK_LEASE_MS,
  cancelInflight,
  confirmDraft,
  isHitlConfirmFamily,
  resetConfirmManagerForTest,
  setConfirmManagerPool,
  setPurchaseOrderStarter,
  setMastraResolver,
  tickAtUserMessage,
  type ConfirmManagerPool,
  type ConfirmTx,
  type MastraResolver,
  type PurchaseOrderStarter,
  type StartPurchaseOrderPreviewArgs,
  type StartPurchaseOrderPreviewResult,
  type WorkflowHandle,
  type WorkflowResumeArgs,
} from './confirm-manager.js';
import {
  resetDraftManagerForTest,
  setDraftPool,
  type DraftPool,
} from './draft-manager.js';

/* ============================================================================
 * Fake DraftPool —— 仅识别 getByIdStrict / findRecentDraft / INSERT replenishment_draft
 * ========================================================================== */

interface FakeDraftRow {
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

class FakeDraftPoolImpl implements DraftPool {
  public rows = new Map<string, FakeDraftRow>();
  public clock = new Date('2026-05-07T01:00:00.000Z');

  insert(row: Partial<FakeDraftRow> & Pick<FakeDraftRow, 'draft_id'>): void {
    const now = this.clock;
    const filled: FakeDraftRow = {
      draft_id: row.draft_id,
      session_id: row.session_id ?? 'sess_default',
      merchant_id: row.merchant_id ?? 'M001',
      store_id: row.store_id ?? 'S001',
      user_id: row.user_id ?? 'boss-001',
      trace_id: row.trace_id ?? 'trace_default',
      forecast_days: row.forecast_days ?? 7,
      status: row.status ?? 'WAIT_CONFIRM',
      items: row.items ?? [],
      strategy_version: row.strategy_version ?? 'P1-M0-S0',
      submitted_po_no: row.submitted_po_no ?? null,
      expires_at: row.expires_at ?? new Date(now.getTime() + 30 * 60_000),
      created_at: row.created_at ?? now,
      updated_at: row.updated_at ?? now,
    };
    this.rows.set(filled.draft_id, filled);
  }

  query<T extends Record<string, unknown>>(
    sql: string,
    params: readonly unknown[],
  ): Promise<[T[], unknown]> {
    const norm = sql.replace(/\s+/g, ' ').trim();
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
        row && row.merchant_id === merchantId && row.store_id === storeId
          ? [toDbRow(row)]
          : [];
      return Promise.resolve([matched as unknown as T[], undefined]);
    }
    // findRecentDraft
    if (
      norm.startsWith('SELECT') &&
      norm.includes('FROM replenishment_draft') &&
      norm.includes('user_id = ?') &&
      norm.includes('status IN') &&
      norm.includes('created_at > NOW(3) - INTERVAL ? MINUTE')
    ) {
      const [merchantId, storeId, userId, withinMinutes] = params as [
        string,
        string,
        string,
        number,
      ];
      const cutoff = new Date(this.clock.getTime() - withinMinutes * 60_000);
      const matched = [...this.rows.values()].filter(
        (r) =>
          r.merchant_id === merchantId &&
          r.store_id === storeId &&
          r.user_id === userId &&
          ['DRAFT', 'WAIT_CONFIRM', 'CONFIRMED'].includes(r.status) &&
          r.created_at > cutoff,
      );
      matched.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      return Promise.resolve([
        matched.slice(0, 5).map(toDbRow) as unknown as T[],
        undefined,
      ]);
    }
    throw new Error(`FakeDraftPoolImpl: 未识别 SQL: ${norm}`);
  }

  execute(
    sql: string,
    params: readonly unknown[],
  ): Promise<[{ affectedRows: number }, unknown]> {
    const norm = sql.replace(/\s+/g, ' ').trim();
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
    return Promise.resolve([{ affectedRows: 0 }, undefined]);
  }
}

function toDbRow(r: FakeDraftRow): Record<string, unknown> {
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
 * Fake ConfirmManagerPool —— 内存 agent_session + 事务序列化
 * ========================================================================== */

interface FakeSessionRow {
  session_id: string;
  merchant_id: string;
  current_store_id: string;
  user_id: string;
  active_run_id: string | null;
  active_run_step: string | null;
  active_run_expires_at: Date | null;
  resume_locked_at: Date | null;
  active_draft_id: string | null;
}

class FakeConfirmPool implements ConfirmManagerPool {
  public sessions = new Map<string, FakeSessionRow>();
  public suspendedRuns = new Set<string>();
  public deletedSuspendRuns: string[] = [];
  public clearedActiveRuns: string[] = [];
  public executeCalls: Array<{ sql: string; params: unknown[] }> = [];
  public queryCalls: Array<{ sql: string; params: unknown[] }> = [];
  public txQueue: Array<() => Promise<unknown>> = [];

  // 事务执行序列化锁 —— 确保 transaction(fn) 像 SELECT FOR UPDATE 一样串行
  private txRunning = false;

  insertSession(row: Partial<FakeSessionRow> & Pick<FakeSessionRow, 'session_id'>): void {
    const filled: FakeSessionRow = {
      session_id: row.session_id,
      merchant_id: row.merchant_id ?? 'M001',
      current_store_id: row.current_store_id ?? 'S001',
      user_id: row.user_id ?? 'boss-001',
      active_run_id: row.active_run_id ?? null,
      active_run_step: row.active_run_step ?? null,
      active_run_expires_at: row.active_run_expires_at ?? null,
      resume_locked_at: row.resume_locked_at ?? null,
      active_draft_id: row.active_draft_id ?? null,
    };
    this.sessions.set(filled.session_id, filled);
  }

  insertSuspendRun(runId: string): void {
    this.suspendedRuns.add(runId);
  }

  query<T extends Record<string, unknown>>(
    sql: string,
    params: readonly unknown[],
  ): Promise<[T[], unknown]> {
    this.queryCalls.push({ sql, params: [...params] });
    const norm = sql.replace(/\s+/g, ' ').trim();
    if (
      norm.startsWith('SELECT') &&
      norm.includes('FROM agent_session') &&
      norm.includes('WHERE session_id = ?') &&
      norm.includes('LIMIT 1')
    ) {
      const [sessionId] = params as [string];
      const row = this.sessions.get(sessionId);
      return Promise.resolve([(row ? [toSessionDbRow(row)] : []) as unknown as T[], undefined]);
    }
    throw new Error(`FakeConfirmPool: 未识别 query SQL: ${norm}`);
  }

  execute(
    sql: string,
    params: readonly unknown[],
  ): Promise<[{ affectedRows: number }, unknown]> {
    this.executeCalls.push({ sql, params: [...params] });
    const norm = sql.replace(/\s+/g, ' ').trim();
    // 注意：cancelInflight 的 UPDATE 同时含 active_run_id = NULL 与 resume_locked_at = NULL
    // 必须先匹配按 active_run_id 清场的语义，再匹配只清锁的释放语义
    if (
      norm.startsWith('UPDATE agent_session') &&
      norm.includes('active_run_id = NULL') &&
      norm.includes('WHERE active_run_id = ?')
    ) {
      const [runId] = params as [string];
      this.clearedActiveRuns.push(runId);
      let count = 0;
      for (const row of this.sessions.values()) {
        if (row.active_run_id === runId) {
          row.active_run_id = null;
          row.active_run_step = null;
          row.active_run_expires_at = null;
          row.resume_locked_at = null;
          count += 1;
        }
      }
      return Promise.resolve([{ affectedRows: count }, undefined]);
    }
    if (
      norm.startsWith('UPDATE agent_session') &&
      norm.includes('resume_locked_at = NULL') &&
      norm.includes('WHERE session_id = ?')
    ) {
      const [sessionId] = params as [string];
      const row = this.sessions.get(sessionId);
      if (row) {
        row.resume_locked_at = null;
        return Promise.resolve([{ affectedRows: 1 }, undefined]);
      }
      return Promise.resolve([{ affectedRows: 0 }, undefined]);
    }
    if (norm.startsWith('DELETE FROM mastra_workflow_suspend WHERE run_id = ?')) {
      const [runId] = params as [string];
      this.deletedSuspendRuns.push(runId);
      const had = this.suspendedRuns.delete(runId);
      return Promise.resolve([{ affectedRows: had ? 1 : 0 }, undefined]);
    }
    if (norm.startsWith('INSERT INTO mastra_workflow_suspend')) {
      const [runId] = params as [string];
      this.suspendedRuns.add(runId);
      return Promise.resolve([{ affectedRows: 1 }, undefined]);
    }
    if (norm.startsWith('INSERT INTO agent_session')) {
      const [
        sessionId,
        ,
        merchantId,
        storeId,
        userId,
        draftId,
        runId,
        step,
      ] = params as [string, string, string, string, string, string, string, string];
      this.sessions.set(sessionId, {
        session_id: sessionId,
        merchant_id: merchantId,
        current_store_id: storeId,
        user_id: userId,
        active_run_id: runId,
        active_run_step: step,
        active_run_expires_at: new Date(Date.now() + 30 * 60_000),
        resume_locked_at: null,
        active_draft_id: draftId,
      });
      return Promise.resolve([{ affectedRows: 1 }, undefined]);
    }
    throw new Error(`FakeConfirmPool: 未识别 execute SQL: ${norm}`);
  }

  async transaction<T>(fn: (tx: ConfirmTx) => Promise<T>): Promise<T> {
    // 序列化事务：模拟 SELECT FOR UPDATE 行锁
    if (this.txRunning) {
      await new Promise<void>((resolve) => {
        this.txQueue.push(() => {
          resolve();
          return Promise.resolve();
        });
      });
    }
    this.txRunning = true;

    const tx: ConfirmTx = {
      query: <U extends Record<string, unknown>>(
        sql: string,
        params: readonly unknown[],
      ): Promise<[U[], unknown]> => {
        this.queryCalls.push({ sql, params: [...params] });
        const norm = sql.replace(/\s+/g, ' ').trim();
        // FOR UPDATE 读 agent_session
        if (
          norm.startsWith('SELECT') &&
          norm.includes('FROM agent_session') &&
          norm.includes('WHERE session_id = ?') &&
          norm.includes('FOR UPDATE')
        ) {
          const [sessionId] = params as [string];
          const row = this.sessions.get(sessionId);
          return Promise.resolve([
            (row ? [toSessionDbRow(row)] : []) as unknown as U[],
            undefined,
          ]);
        }
        throw new Error(`FakeConfirmPool tx: 未识别 query SQL: ${norm}`);
      },
      execute: (
        sql: string,
        params: readonly unknown[],
      ): Promise<[{ affectedRows: number }, unknown]> => {
        this.executeCalls.push({ sql, params: [...params] });
        const norm = sql.replace(/\s+/g, ' ').trim();
        if (
          norm.startsWith('UPDATE agent_session') &&
          norm.includes('resume_locked_at = NOW(3)')
        ) {
          const [sessionId] = params as [string];
          const row = this.sessions.get(sessionId);
          if (row) {
            row.resume_locked_at = new Date();
            return Promise.resolve([{ affectedRows: 1 }, undefined]);
          }
          return Promise.resolve([{ affectedRows: 0 }, undefined]);
        }
        throw new Error(`FakeConfirmPool tx: 未识别 execute SQL: ${norm}`);
      },
    };

    try {
      const result = await fn(tx);
      return result;
    } finally {
      this.txRunning = false;
      const next = this.txQueue.shift();
      if (next) void next();
    }
  }
}

function toSessionDbRow(r: FakeSessionRow): Record<string, unknown> {
  return {
    session_id: r.session_id,
    merchant_id: r.merchant_id,
    current_store_id: r.current_store_id,
    user_id: r.user_id,
    active_run_id: r.active_run_id,
    active_run_step: r.active_run_step,
    active_run_expires_at: r.active_run_expires_at,
    resume_locked_at: r.resume_locked_at,
    active_draft_id: r.active_draft_id,
  };
}

/* ============================================================================
 * Fake MastraResolver
 * ========================================================================== */

class FakeMastraResolver implements MastraResolver {
  public resumeCalls: WorkflowResumeArgs[] = [];
  public resumeImpl: (args: WorkflowResumeArgs) => Promise<unknown> = (args) =>
    Promise.resolve({ ok: true, runId: args.runId });

  getWorkflow(workflowId: string): WorkflowHandle {
    if (workflowId !== HITL_WORKFLOW_ID) {
      throw new Error(`FakeMastraResolver: workflowId mismatch: ${workflowId}`);
    }
    return {
      resume: async (args: WorkflowResumeArgs) => {
        this.resumeCalls.push(args);
        return this.resumeImpl(args);
      },
    };
  }
}

class FakePurchaseOrderStarter implements PurchaseOrderStarter {
  public startCalls: StartPurchaseOrderPreviewArgs[] = [];
  public startImpl: (
    args: StartPurchaseOrderPreviewArgs,
  ) => Promise<{
    runId: string;
    step: string;
    previewMarkdown: string;
    suspendPayload: unknown;
  }> = (args) => Promise.resolve({
    runId: `run_preview_${args.draftId}`,
    step: 'ask-confirm',
    previewMarkdown: `# 采购单确认\n\n草稿：${args.draftId}`,
    suspendPayload: {
      draftId: args.draftId,
      itemCount: 1,
      totalQty: 1,
      previewMarkdown: `# 采购单确认\n\n草稿：${args.draftId}`,
    },
  });

  async startPreview(args: StartPurchaseOrderPreviewArgs): Promise<StartPurchaseOrderPreviewResult> {
    this.startCalls.push(args);
    return this.startImpl(args);
  }
}

/* ============================================================================
 * 公共 setup
 * ========================================================================== */

let confirmPool: FakeConfirmPool;
let draftPool: FakeDraftPoolImpl;
let mastra: FakeMastraResolver;
let starter: FakePurchaseOrderStarter;

const SESSION_ID = 'sess_test_0001';
const RUN_ID = 'run_test_0001';
const STEP_ID = 'askConfirm';
const DRAFT_ID = 'drf_aaaaaaaaaaaaaaaaaaaaaa01';

function buildCtx(overrides: Partial<AgentRuntime> = {}): RuntimeContext<AgentRuntime> {
  return buildRuntimeContext({
    traceId: overrides.traceId ?? 'trace_test_xxxxxxxxxxxxxxxxxxxxxxxxxx',
    sessionId: overrides.sessionId ?? SESSION_ID,
    merchantId: overrides.merchantId ?? 'M001',
    storeId: overrides.storeId ?? 'S001',
    userId: overrides.userId ?? 'boss-001',
    apiKeyPrefix: overrides.apiKeyPrefix ?? 'sk-agent-test',
    requestStartedAt: overrides.requestStartedAt ?? Date.now(),
  });
}

beforeEach(() => {
  confirmPool = new FakeConfirmPool();
  draftPool = new FakeDraftPoolImpl();
  mastra = new FakeMastraResolver();
  starter = new FakePurchaseOrderStarter();
  setConfirmManagerPool(confirmPool);
  setMastraResolver(mastra);
  setPurchaseOrderStarter(starter);
  setDraftPool(draftPool);
});

afterEach(() => {
  resetConfirmManagerForTest();
  resetDraftManagerForTest();
  vi.useRealTimers();
});

/* ============================================================================
 * §10.1-§10.2 happy / cancel
 * ========================================================================== */

describe('confirm-manager — happy / cancel', () => {
  it('happy: confirmDraft → mastra.resume(CONFIRM) + 锁释放', async () => {
    confirmPool.insertSession({
      session_id: SESSION_ID,
      active_run_id: RUN_ID,
      active_run_step: STEP_ID,
      active_run_expires_at: new Date(Date.now() + 10 * 60_000),
    });
    draftPool.insert({ draft_id: DRAFT_ID });

    const ctx = buildCtx();
    const result = await confirmDraft({ draftId: DRAFT_ID, runtimeContext: ctx });
    expect(result.kind).toBe('CONFIRMED');
    expect(mastra.resumeCalls).toHaveLength(1);
    expect(mastra.resumeCalls[0]?.runId).toBe(RUN_ID);
    expect(mastra.resumeCalls[0]?.step).toBe(STEP_ID);
    expect(mastra.resumeCalls[0]?.resumeData).toEqual({ decision: 'CONFIRM' });

    // 锁释放：resume_locked_at = NULL
    const session = confirmPool.sessions.get(SESSION_ID);
    expect(session?.resume_locked_at).toBeNull();
  });

  it('PREVIEW_FIRST: 没有 active_run_id → 启动 purchase_order_create preview/suspend 并写 active_run', async () => {
    confirmPool.insertSession({ session_id: SESSION_ID });
    draftPool.insert({ draft_id: DRAFT_ID });

    const ctx = buildCtx();
    const result = await confirmDraft({ draftId: DRAFT_ID, runtimeContext: ctx });
    expect(result.kind).toBe('PREVIEW_FIRST');
    if (result.kind !== 'PREVIEW_FIRST') throw new Error('expected PREVIEW_FIRST');
    expect(result.preview).toContain('# 采购单确认');
    expect(starter.startCalls).toHaveLength(1);
    expect(starter.startCalls[0]?.draftId).toBe(DRAFT_ID);
    expect(starter.startCalls[0]?.runtimeContext.get('sessionId')).toBe(SESSION_ID);
    const session = confirmPool.sessions.get(SESSION_ID);
    expect(session?.active_run_id).toBe(`run_preview_${DRAFT_ID}`);
    expect(session?.active_run_step).toBe('ask-confirm');
    expect(session?.active_draft_id).toBe(DRAFT_ID);
    expect(session?.active_run_expires_at).toBeInstanceOf(Date);
    expect(mastra.resumeCalls).toHaveLength(0);
  });

  it('confirmDraft 成功后清 active run', async () => {
    confirmPool.insertSession({
      session_id: SESSION_ID,
      active_run_id: RUN_ID,
      active_run_step: STEP_ID,
      active_run_expires_at: new Date(Date.now() + 10 * 60_000),
    });
    confirmPool.insertSuspendRun(RUN_ID);
    draftPool.insert({ draft_id: DRAFT_ID });

    const ctx = buildCtx();
    const first = await confirmDraft({ draftId: DRAFT_ID, runtimeContext: ctx });

    expect(first.kind).toBe('CONFIRMED');
    expect(mastra.resumeCalls).toHaveLength(1);
    expect(confirmPool.deletedSuspendRuns).toContain(RUN_ID);
    expect(confirmPool.clearedActiveRuns).toContain(RUN_ID);
    const session = confirmPool.sessions.get(SESSION_ID);
    expect(session?.active_run_id).toBeNull();
    expect(session?.resume_locked_at).toBeNull();
  });

  it('cancelInflight(USER_CANCEL): mastra.resume(CANCEL) + DELETE suspend + UPDATE session', async () => {
    confirmPool.insertSession({
      session_id: SESSION_ID,
      active_run_id: RUN_ID,
      active_run_step: STEP_ID,
      active_run_expires_at: new Date(Date.now() + 10 * 60_000),
      active_draft_id: DRAFT_ID,
    });
    confirmPool.insertSuspendRun(RUN_ID);
    draftPool.insert({ draft_id: DRAFT_ID, status: 'WAIT_CONFIRM' });

    await cancelInflight({ sessionId: SESSION_ID, reason: 'USER_CANCEL' });

    expect(mastra.resumeCalls).toHaveLength(1);
    expect(mastra.resumeCalls[0]?.resumeData).toEqual({
      decision: 'CANCEL',
      reason: 'USER_CANCEL',
    });
    expect(confirmPool.deletedSuspendRuns).toContain(RUN_ID);
    expect(confirmPool.clearedActiveRuns).toContain(RUN_ID);
    const s = confirmPool.sessions.get(SESSION_ID);
    expect(s?.active_run_id).toBeNull();
    expect(draftPool.rows.get(DRAFT_ID)?.status).toBe('CANCELLED');
  });

  it('cancelInflight 幂等：active_run_id 已 NULL → NOOP', async () => {
    confirmPool.insertSession({ session_id: SESSION_ID });
    await cancelInflight({ sessionId: SESSION_ID, reason: 'USER_CANCEL' });
    expect(mastra.resumeCalls).toHaveLength(0);
    expect(confirmPool.deletedSuspendRuns).toHaveLength(0);
  });

  it('cancelInflight: mastra.resume 抛错 swallow + 仍清 suspend / session', async () => {
    confirmPool.insertSession({
      session_id: SESSION_ID,
      active_run_id: RUN_ID,
      active_run_step: STEP_ID,
      active_run_expires_at: new Date(Date.now() + 10 * 60_000),
    });
    confirmPool.insertSuspendRun(RUN_ID);
    mastra.resumeImpl = () => Promise.reject(new Error('mastra boom'));

    await cancelInflight({ sessionId: SESSION_ID, reason: 'USER_CANCEL' });

    expect(confirmPool.deletedSuspendRuns).toContain(RUN_ID);
    expect(confirmPool.clearedActiveRuns).toContain(RUN_ID);
  });
});

/* ============================================================================
 * §10.3 — 边界 3：3 条并发"确认" → 仅 1 RESUMED；其余 RESUME_RACE
 * ========================================================================== */

describe('confirm-manager — 边界 3 (重复确认 / RESUME_RACE)', () => {
  it('3 条并发 confirm → 仅 1 mastra.resume；其余 RESUME_RACE 幂等', async () => {
    confirmPool.insertSession({
      session_id: SESSION_ID,
      active_run_id: RUN_ID,
      active_run_step: STEP_ID,
      active_run_expires_at: new Date(Date.now() + 10 * 60_000),
    });
    draftPool.insert({ draft_id: DRAFT_ID });

    // 让 mastra.resume 慢一点，模拟并发未结束 → 第 2/3 条进 transaction 时看到 lockedAt 在 10s 内
    let resolveResume: (() => void) | null = null;
    mastra.resumeImpl = async () => {
      await new Promise<void>((r) => {
        resolveResume = r;
      });
      return { ok: true };
    };

    const ctx1 = buildCtx({ sessionId: SESSION_ID });
    const ctx2 = buildCtx({ sessionId: SESSION_ID });
    const ctx3 = buildCtx({ sessionId: SESSION_ID });

    const promiseA = confirmDraft({ draftId: DRAFT_ID, runtimeContext: ctx1 });
    // 立刻挂 noop catch，避免 promise rejection 在 await 之前飘出
    const promiseB = confirmDraft({ draftId: DRAFT_ID, runtimeContext: ctx2 });
    promiseB.catch(() => undefined);
    const promiseC = confirmDraft({ draftId: DRAFT_ID, runtimeContext: ctx3 });
    promiseC.catch(() => undefined);

    // 等 promiseA 进 transaction → 设置了 lockedAt；B / C 入 transaction 看到锁租约 → RESUME_RACE
    await new Promise<void>((r) => setTimeout(r, 30));

    const [resB, resC] = await Promise.allSettled([promiseB, promiseC]);
    expect(resB.status).toBe('rejected');
    expect(resC.status).toBe('rejected');
    if (resB.status === 'rejected') {
      expect(resB.reason).toBeInstanceOf(BizError);
      expect((resB.reason as BizError).code).toBe('RESUME_RACE');
    }
    if (resC.status === 'rejected') {
      expect(resC.reason).toBeInstanceOf(BizError);
      expect((resC.reason as BizError).code).toBe('RESUME_RACE');
    }

    // 解锁 promiseA
    resolveResume!();
    const resA = await promiseA;
    expect(resA.kind).toBe('CONFIRMED');

    // 仅 1 次 mastra.resume
    expect(mastra.resumeCalls).toHaveLength(1);
  });
});

/* ============================================================================
 * §10.4 — 边界 4：多实例并发 → FOR UPDATE 串行（fake transaction 队列模拟）
 * ========================================================================== */

describe('confirm-manager — 边界 4 (多实例 FOR UPDATE 串行)', () => {
  it('两个 confirmDraft 同时进入 → transaction 串行执行（仅 1 次 mastra.resume）', async () => {
    // 同 §10.3 但更显式断言事务串行
    confirmPool.insertSession({
      session_id: SESSION_ID,
      active_run_id: RUN_ID,
      active_run_step: STEP_ID,
      active_run_expires_at: new Date(Date.now() + 10 * 60_000),
    });
    draftPool.insert({ draft_id: DRAFT_ID });

    let resolveResume: (() => void) | null = null;
    let resumeStarted = 0;
    mastra.resumeImpl = async () => {
      resumeStarted += 1;
      await new Promise<void>((r) => {
        resolveResume = r;
      });
      return { ok: true };
    };

    const ctx1 = buildCtx({ sessionId: SESSION_ID });
    const ctx2 = buildCtx({ sessionId: SESSION_ID });
    const promiseA = confirmDraft({ draftId: DRAFT_ID, runtimeContext: ctx1 });
    const promiseB = confirmDraft({ draftId: DRAFT_ID, runtimeContext: ctx2 });
    promiseB.catch(() => undefined);
    await new Promise<void>((r) => setTimeout(r, 30));

    // 第二条等待事务串行 → 看到 lockedAt → 抛 RESUME_RACE
    const settled = await Promise.allSettled([promiseB]);
    expect(settled[0]?.status).toBe('rejected');

    resolveResume!();
    await promiseA;

    expect(resumeStarted).toBe(1);
    expect(mastra.resumeCalls).toHaveLength(1);
  });
});

/* ============================================================================
 * §10.5 — 边界 1：抢占（intent 不属于 CONFIRM/CANCEL） → tick.kind=CANCELLED
 * ========================================================================== */

describe('confirm-manager — 边界 1 (抢占 / PREEMPT)', () => {
  it('挂起中老板说"看月报" → tick.kind=CANCELLED + 旧 run cancel', async () => {
    confirmPool.insertSession({
      session_id: SESSION_ID,
      active_run_id: RUN_ID,
      active_run_step: STEP_ID,
      active_run_expires_at: new Date(Date.now() + 10 * 60_000),
    });
    confirmPool.insertSuspendRun(RUN_ID);

    const ctx = buildCtx({ sessionId: SESSION_ID });
    const result = await tickAtUserMessage({
      sessionId: SESSION_ID,
      userIntent: Intent.BUSINESS_MONTHLY_REPORT,
      runtimeContext: ctx,
    });

    expect(result.kind).toBe('CANCELLED');
    expect(mastra.resumeCalls).toHaveLength(1);
    expect(mastra.resumeCalls[0]?.resumeData).toEqual({
      decision: 'CANCEL',
      reason: 'PREEMPT',
    });
    expect(confirmPool.deletedSuspendRuns).toContain(RUN_ID);
    expect(confirmPool.clearedActiveRuns).toContain(RUN_ID);
  });

  it('CONFIRM 意图 → tick.kind=NONE（不抢占）', async () => {
    confirmPool.insertSession({
      session_id: SESSION_ID,
      active_run_id: RUN_ID,
      active_run_step: STEP_ID,
      active_run_expires_at: new Date(Date.now() + 10 * 60_000),
    });
    const ctx = buildCtx({ sessionId: SESSION_ID });
    const result = await tickAtUserMessage({
      sessionId: SESSION_ID,
      userIntent: Intent.CONFIRM_CREATE_PURCHASE_ORDER,
      runtimeContext: ctx,
    });
    expect(result.kind).toBe('NONE');
    expect(mastra.resumeCalls).toHaveLength(0);
  });

  it('CANCEL 意图 → tick.kind=NONE（不抢占；cancelInflight 由桥接层另调）', async () => {
    confirmPool.insertSession({
      session_id: SESSION_ID,
      active_run_id: RUN_ID,
      active_run_step: STEP_ID,
      active_run_expires_at: new Date(Date.now() + 10 * 60_000),
    });
    const ctx = buildCtx({ sessionId: SESSION_ID });
    const result = await tickAtUserMessage({
      sessionId: SESSION_ID,
      userIntent: Intent.CANCEL_REPLENISHMENT_DRAFT,
      runtimeContext: ctx,
    });
    expect(result.kind).toBe('NONE');
  });

  it('isHitlConfirmFamily：仅 CONFIRM/CANCEL 为 true，其它 false', () => {
    expect(isHitlConfirmFamily(Intent.CONFIRM_CREATE_PURCHASE_ORDER)).toBe(true);
    expect(isHitlConfirmFamily(Intent.CANCEL_REPLENISHMENT_DRAFT)).toBe(true);
    const others: IntentCode[] = [
      Intent.BUSINESS_DAILY_REPORT,
      Intent.BUSINESS_MONTHLY_REPORT,
      Intent.REPLENISHMENT_PLAN,
      Intent.ADJUST_REPLENISHMENT_DRAFT,
      Intent.COLLECT_REQUIREMENT,
      Intent.GENERAL_QA,
      Intent.EXPLAIN_METRIC,
      Intent.MULTI_INTENT,
      Intent.UNKNOWN,
    ];
    for (const i of others) {
      expect(isHitlConfirmFamily(i)).toBe(false);
    }
  });

  it('PREEMPT_MARKDOWN_PREFIX 含"已为您取消上一次的待确认采购单"（任务卡 §8.5）', () => {
    expect(PREEMPT_MARKDOWN_PREFIX).toContain('已为您取消上一次的待确认采购单');
  });
});

/* ============================================================================
 * §10.6 — 边界 2：30 分钟过期 → tick.kind=EXPIRED
 * ========================================================================== */

describe('confirm-manager — 边界 2 (30 分钟过期 / EXPIRED)', () => {
  it('active_run_expires_at < NOW → tick.kind=EXPIRED + cancelInflight EXPIRED', async () => {
    confirmPool.insertSession({
      session_id: SESSION_ID,
      active_run_id: RUN_ID,
      active_run_step: STEP_ID,
      active_run_expires_at: new Date(Date.now() - 1_000), // 1 秒前过期
    });
    confirmPool.insertSuspendRun(RUN_ID);

    const ctx = buildCtx({ sessionId: SESSION_ID });
    const result = await tickAtUserMessage({
      sessionId: SESSION_ID,
      // intent 是否抢占都无所谓 —— EXPIRED 优先于 PREEMPT
      userIntent: Intent.CONFIRM_CREATE_PURCHASE_ORDER,
      runtimeContext: ctx,
    });
    expect(result.kind).toBe('EXPIRED');
    expect(mastra.resumeCalls).toHaveLength(1);
    expect(mastra.resumeCalls[0]?.resumeData).toEqual({
      decision: 'CANCEL',
      reason: 'EXPIRED',
    });
    expect(confirmPool.deletedSuspendRuns).toContain(RUN_ID);
  });

  it('confirmDraft 在 active_run_expires_at < NOW → SUSPEND_EXPIRED', async () => {
    confirmPool.insertSession({
      session_id: SESSION_ID,
      active_run_id: RUN_ID,
      active_run_step: STEP_ID,
      active_run_expires_at: new Date(Date.now() - 1_000),
    });
    confirmPool.insertSuspendRun(RUN_ID);
    draftPool.insert({ draft_id: DRAFT_ID });

    const ctx = buildCtx({ sessionId: SESSION_ID });
    await expect(
      confirmDraft({ draftId: DRAFT_ID, runtimeContext: ctx }),
    ).rejects.toMatchObject({ code: 'SUSPEND_EXPIRED' });
    // 旧 run 已被 cancelInflight EXPIRED
    expect(confirmPool.deletedSuspendRuns).toContain(RUN_ID);
  });
});

/* ============================================================================
 * §10.7 — 边界 5：sessionId 漂移 → DraftManager.findRecentDraft 兜底
 * ========================================================================== */

describe('confirm-manager — 边界 5 (sessionId 漂移)', () => {
  it('当 draftId 不存在但近 5 分钟有 WAIT_CONFIRM 草稿 → 兜底找回', async () => {
    // 当前 sessionId 看不到 draft（getByIdStrict 抛 DRAFT_NOT_FOUND）
    // 但 findRecentDraft 命中租户 (M001/S001/boss-001) 近 5 分钟的草稿
    draftPool.insert({
      draft_id: 'drf_recent_zzzzzzzzzzzzzz',
      created_at: new Date(draftPool.clock.getTime() - 60_000), // 1 分钟前
      status: 'WAIT_CONFIRM',
    });
    confirmPool.insertSession({
      session_id: SESSION_ID,
      active_run_id: RUN_ID,
      active_run_step: STEP_ID,
      active_run_expires_at: new Date(Date.now() + 10 * 60_000),
    });

    const ctx = buildCtx({ sessionId: SESSION_ID });
    const result = await confirmDraft({
      draftId: 'drf_nonexistent_xxxxxxxxxxxx',
      runtimeContext: ctx,
    });
    expect(result.kind).toBe('CONFIRMED');
    expect(mastra.resumeCalls).toHaveLength(1);
  });

  it('当 draftId 不存在且近 5 分钟无草稿 → SUSPEND_NOT_FOUND', async () => {
    confirmPool.insertSession({
      session_id: SESSION_ID,
      active_run_id: RUN_ID,
      active_run_step: STEP_ID,
      active_run_expires_at: new Date(Date.now() + 10 * 60_000),
    });
    const ctx = buildCtx({ sessionId: SESSION_ID });
    await expect(
      confirmDraft({ draftId: 'drf_x_xxxxxxxxxxxxxxxxxxxx', runtimeContext: ctx }),
    ).rejects.toMatchObject({ code: 'SUSPEND_NOT_FOUND' });
  });
});

/* ============================================================================
 * §10.8 — 锁租约 10s：模拟锁泄漏 → 10s 后下条请求可继续
 * ========================================================================== */

describe('confirm-manager — 锁租约 10s', () => {
  it('resume_locked_at 在 10s 之外 → 下条 confirm 可继续（不抛 RESUME_RACE）', async () => {
    // 模拟锁泄漏：手动写入 11s 前的 resume_locked_at
    confirmPool.insertSession({
      session_id: SESSION_ID,
      active_run_id: RUN_ID,
      active_run_step: STEP_ID,
      active_run_expires_at: new Date(Date.now() + 10 * 60_000),
      resume_locked_at: new Date(Date.now() - (RESUME_LOCK_LEASE_MS + 1_000)),
    });
    draftPool.insert({ draft_id: DRAFT_ID });

    const ctx = buildCtx({ sessionId: SESSION_ID });
    const result = await confirmDraft({ draftId: DRAFT_ID, runtimeContext: ctx });
    expect(result.kind).toBe('CONFIRMED');
    expect(mastra.resumeCalls).toHaveLength(1);
  });

  it('resume_locked_at 在 10s 之内 → 抛 RESUME_RACE', async () => {
    confirmPool.insertSession({
      session_id: SESSION_ID,
      active_run_id: RUN_ID,
      active_run_step: STEP_ID,
      active_run_expires_at: new Date(Date.now() + 10 * 60_000),
      resume_locked_at: new Date(Date.now() - 5_000), // 5s 前
    });
    draftPool.insert({ draft_id: DRAFT_ID });

    const ctx = buildCtx({ sessionId: SESSION_ID });
    await expect(
      confirmDraft({ draftId: DRAFT_ID, runtimeContext: ctx }),
    ).rejects.toMatchObject({ code: 'RESUME_RACE' });
  });

  it('RESUME_LOCK_LEASE_MS 必须为 10_000ms（任务卡 §7 MUST DO §3）', () => {
    expect(RESUME_LOCK_LEASE_MS).toBe(10_000);
  });
});

/* ============================================================================
 * 锁释放保护 + finally 不在事务内
 * ========================================================================== */

describe('confirm-manager — 锁释放保护 / 不在事务内 await mastra', () => {
  it('mastra.resume 抛错 → finally 仍 UPDATE NULL（锁释放）', async () => {
    confirmPool.insertSession({
      session_id: SESSION_ID,
      active_run_id: RUN_ID,
      active_run_step: STEP_ID,
      active_run_expires_at: new Date(Date.now() + 10 * 60_000),
    });
    draftPool.insert({ draft_id: DRAFT_ID });
    mastra.resumeImpl = () => Promise.reject(new Error('mastra runtime err'));

    const ctx = buildCtx({ sessionId: SESSION_ID });
    await expect(
      confirmDraft({ draftId: DRAFT_ID, runtimeContext: ctx }),
    ).rejects.toThrow(/mastra runtime err/);

    const session = confirmPool.sessions.get(SESSION_ID);
    expect(session?.resume_locked_at).toBeNull();
  });

  it('UPDATE NULL 形态：execute SQL 含 resume_locked_at = NULL', async () => {
    confirmPool.insertSession({
      session_id: SESSION_ID,
      active_run_id: RUN_ID,
      active_run_step: STEP_ID,
      active_run_expires_at: new Date(Date.now() + 10 * 60_000),
    });
    draftPool.insert({ draft_id: DRAFT_ID });

    const ctx = buildCtx({ sessionId: SESSION_ID });
    await confirmDraft({ draftId: DRAFT_ID, runtimeContext: ctx });
    const updateNullCall = confirmPool.executeCalls.find((c) =>
      c.sql.replace(/\s+/g, ' ').includes('resume_locked_at = NULL'),
    );
    expect(updateNullCall).toBeTruthy();
  });

  it('mastra.resume 在 transaction 体外才被 await（任务卡 §7 MUST NOT §2）', async () => {
    // 通过断言 transaction 体内不命中 resume 来守门：FakeMastraResolver 记录调用顺序，
    // 在 transaction 体内只能调 query / execute；如果 resume 在 tx 内被 await，
    // FakeConfirmPool.txRunning=true 会与 setMastraResolver 的回调路径冲突。
    confirmPool.insertSession({
      session_id: SESSION_ID,
      active_run_id: RUN_ID,
      active_run_step: STEP_ID,
      active_run_expires_at: new Date(Date.now() + 10 * 60_000),
    });
    draftPool.insert({ draft_id: DRAFT_ID });

    let txRunningWhenResume = false;
    mastra.resumeImpl = (args) => {
      txRunningWhenResume = (confirmPool as unknown as { txRunning: boolean }).txRunning;
      return Promise.resolve({ ok: true, runId: args.runId });
    };

    const ctx = buildCtx({ sessionId: SESSION_ID });
    await confirmDraft({ draftId: DRAFT_ID, runtimeContext: ctx });
    expect(txRunningWhenResume).toBe(false); // resume 时事务已 COMMIT
  });
});

/* ============================================================================
 * tick 鲁棒性：DB 异常 fallback NONE（不阻断业务）
 * ========================================================================== */

describe('confirm-manager — tick 鲁棒性', () => {
  it('loadSession 抛错 → tick fallback NONE（不阻断 dispatch）', async () => {
    // 注入一个总是抛错的 pool
    const badPool: ConfirmManagerPool = {
      query: () => Promise.reject(new Error('db gone')),
      execute: () => Promise.reject(new Error('db gone')),
      transaction: <T>(): Promise<T> => Promise.reject(new Error('db gone')),
    };
    setConfirmManagerPool(badPool);
    const ctx = buildCtx({ sessionId: SESSION_ID });
    const result = await tickAtUserMessage({
      sessionId: SESSION_ID,
      userIntent: Intent.GENERAL_QA,
      runtimeContext: ctx,
    });
    expect(result.kind).toBe('NONE');
  });

  it('cancelInflight 内部抛错 → tick 仍返回正常 kind（PREEMPT/EXPIRED）', async () => {
    confirmPool.insertSession({
      session_id: SESSION_ID,
      active_run_id: RUN_ID,
      active_run_step: STEP_ID,
      active_run_expires_at: new Date(Date.now() + 10 * 60_000),
    });
    // 让 cancelInflight 内 mastra.resume 抛错（DELETE/UPDATE 仍跑过）
    mastra.resumeImpl = () => Promise.reject(new Error('resume err'));

    const ctx = buildCtx({ sessionId: SESSION_ID });
    const result = await tickAtUserMessage({
      sessionId: SESSION_ID,
      userIntent: Intent.GENERAL_QA, // 抢占
      runtimeContext: ctx,
    });
    expect(result.kind).toBe('CANCELLED');
    expect(confirmPool.deletedSuspendRuns).toContain(RUN_ID);
  });

  it('tick on non-existent session → NONE', async () => {
    const ctx = buildCtx({ sessionId: 'sess_unknown_xxxxxx' });
    const result = await tickAtUserMessage({
      sessionId: 'sess_unknown_xxxxxx',
      userIntent: Intent.GENERAL_QA,
      runtimeContext: ctx,
    });
    expect(result.kind).toBe('NONE');
  });

  it('tick on session with null active_run_id → NONE', async () => {
    confirmPool.insertSession({ session_id: SESSION_ID });
    const ctx = buildCtx({ sessionId: SESSION_ID });
    const result = await tickAtUserMessage({
      sessionId: SESSION_ID,
      userIntent: Intent.BUSINESS_DAILY_REPORT,
      runtimeContext: ctx,
    });
    expect(result.kind).toBe('NONE');
    expect(mastra.resumeCalls).toHaveLength(0);
  });
});

/* ============================================================================
 * DI 兜底
 * ========================================================================== */

describe('confirm-manager — DI', () => {
  it('未注入 pool 调用 confirmDraft → INTERNAL_ERROR ConfirmManagerPool 未注入', async () => {
    resetConfirmManagerForTest();
    setMastraResolver(mastra);
    setDraftPool(draftPool);
    draftPool.insert({ draft_id: DRAFT_ID });

    const ctx = buildCtx({ sessionId: SESSION_ID });
    await expect(
      confirmDraft({ draftId: DRAFT_ID, runtimeContext: ctx }),
    ).rejects.toThrow(/ConfirmManagerPool 未注入/);
  });

  it('未注入 mastraResolver 调用 confirmDraft → INTERNAL_ERROR MastraResolver 未注入', async () => {
    resetConfirmManagerForTest();
    setConfirmManagerPool(confirmPool);
    setDraftPool(draftPool);
    draftPool.insert({ draft_id: DRAFT_ID });
    confirmPool.insertSession({
      session_id: SESSION_ID,
      active_run_id: RUN_ID,
      active_run_step: STEP_ID,
      active_run_expires_at: new Date(Date.now() + 10 * 60_000),
    });

    const ctx = buildCtx({ sessionId: SESSION_ID });
    await expect(
      confirmDraft({ draftId: DRAFT_ID, runtimeContext: ctx }),
    ).rejects.toThrow(/MastraResolver 未注入/);
  });
});

/* ============================================================================
 * 常量
 * ========================================================================== */

describe('confirm-manager — 常量', () => {
  it('HITL_WORKFLOW_ID = "purchase_order_create"', () => {
    expect(HITL_WORKFLOW_ID).toBe('purchase_order_create');
  });
});
