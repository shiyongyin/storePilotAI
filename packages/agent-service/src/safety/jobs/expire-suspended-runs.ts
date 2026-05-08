/**
 * 切片 16 — 过期 suspend 清理 Job（5 分钟 cron + LIMIT 200 + FOR UPDATE SKIP LOCKED）
 *
 * 严格按 docs/tanks/16-safety-confirm-manager-hitl.md §7 MUST DO §6 + §8.4 + 任务卡 §10 测试场景 9 / 10 落地。
 *
 * 交付能力：
 *   - {@link expireSuspendedRunsJob}：单次扫描；分批 SELECT 200 个过期 suspend 行
 *     （`FOR UPDATE SKIP LOCKED` 多实例并发安全），逐行：
 *       1. 尽力 mastra.resume({ decision:'CANCEL', reason:'EXPIRED' })（错误 swallow）
 *       2. DELETE FROM mastra_workflow_suspend WHERE run_id = ?（幂等）
 *       3. UPDATE agent_session SET active_run_id=NULL... WHERE active_run_id=?
 *   - {@link startExpireSuspendedRunsCron}：注册 setInterval（默认 5 分钟）触发 Job；
 *     防重叠（上一次未结束跳过本次）；返回 stop 函数；timer.unref() 不悬挂主进程。
 *
 * 强约束（任务卡 §7 MUST DO / MUST NOT，违反即拒收）：
 *   - MUST：5 分钟 cron + `LIMIT 200 FOR UPDATE SKIP LOCKED`
 *   - MUST：cron Job 错误 swallow + audit log（不中断后续）
 *   - MUST NOT：cron Job 大事务一次扫几万行（必须 LIMIT 200 分批）
 *   - MUST NOT：让多实例并发 resume 同 runId（FOR UPDATE SKIP LOCKED 多实例守门）
 *
 * 设计决策：
 *   - 由于 mastra_workflow_suspend 表无 workflow_id 列（DDL 字段集见切片 03），
 *     按 V1 实际只有 1 个 HITL workflow（`purchase_order_create`）的事实，
 *     Job 直接复用 {@link HITL_WORKFLOW_ID} 常量；后续多 HITL workflow 时再加列。
 *   - SELECT 与 DELETE/UPDATE 不放在一个长事务（`FOR UPDATE SKIP LOCKED` 保多实例安全
 *     即可；DELETE 后 idx_expires 不再命中本行，第二次扫描 0 行退出）。
 *
 * 引用：
 *   - 任务卡 §6 / §7 / §8.4 / §9 step 10 / §10 测试场景 9 / 10
 *   - 切片 03 `mastra_workflow_suspend.idx_expires`
 *   - 切片 07 deleteSuspendPayload 语义对齐
 *   - 切片 13 jobs/expire-drafts.ts 同形 cron 模板
 */
import { BizError } from '@storepilot/shared-contracts';

import { logger } from '../../observability/logger.js';
import { buildRuntimeContext } from '../../mastra/runtime-context.js';
import { getByIdStrict, transit as transitDraft } from '../draft-manager.js';

import {
  HITL_WORKFLOW_ID,
  type ConfirmManagerPool,
  type MastraResolver,
  getRegisteredConfirmManagerPool,
  getRegisteredMastraResolver,
} from '../confirm-manager.js';

/* ============================================================================
 * 常量
 * ========================================================================== */

/** 每批最多 SELECT 行数（任务卡 §7 MUST DO §6 / §8.4） */
export const EXPIRE_SUSPENDED_BATCH_LIMIT = 200;
/** 批间 sleep 毫秒（与切片 13 expire-drafts 保持同语义） */
export const EXPIRE_SUSPENDED_BATCH_SLEEP_MS = 100;
/** 默认 cron 间隔 5 分钟（任务卡 §6 / §10） */
export const EXPIRE_SUSPENDED_DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
/** 单次 cron tick 内最多分批数（防御性兜底） */
export const EXPIRE_SUSPENDED_MAX_BATCHES_PER_TICK = 200;

/**
 * 简单 sleep（与 jobs/expire-drafts.ts sleep 同形，避免互相 import 形成环依赖）。
 *
 * @param ms 毫秒
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    if (typeof handle.unref === 'function') handle.unref();
  });
}

/* ============================================================================
 * Job 单次执行
 * ========================================================================== */

/**
 * 单次 cron tick 的执行结果（便于测试断言）。
 */
export interface ExpireSuspendedRunsJobResult {
  /** 扫描的批数（每批 LIMIT 200） */
  batches: number;
  /** 处理的过期 suspend 行总数（已成功 DELETE） */
  totalProcessed: number;
  /** mastra.resume 抛错次数（swallow，不阻断；记录用于告警阈值） */
  resumeErrors: number;
}

/**
 * suspend 表行的最小投影（cron 只关心 run_id / step_id）。
 */
interface SuspendRow extends Record<string, unknown> {
  run_id: string;
  step_id: string;
}

interface ActiveRunSessionRow extends Record<string, unknown> {
  session_id: string;
  merchant_id: string;
  current_store_id: string;
  user_id: string;
  active_draft_id: string | null;
}

/**
 * 单次扫描：分批 SELECT 200 个过期 suspend 行，对每行 resume(CANCEL) + DELETE + UPDATE session。
 *
 * SQL 语义（任务卡 §8.4）：
 *   ```sql
 *   SELECT run_id, step_id FROM mastra_workflow_suspend
 *     WHERE expires_at < NOW(3)
 *     LIMIT 200 FOR UPDATE SKIP LOCKED
 *   ```
 *
 * 关键不变量：
 *   - SKIP LOCKED 多实例守门：实例 A SELECT 占行后，实例 B 的同一查询自动 skip 这些行
 *   - resume 抛错 swallow + audit log（任务卡 §7 MUST DO §9）
 *   - 即使 resume 失败也要 DELETE suspend + UPDATE session：否则下一次 cron 仍命中
 *
 * @param opts 可选注入（pool / resolver / maxBatches）；测试用
 * @returns 单次执行批数 / 处理行数 / resume 错误次数
 * @throws BizError 当批数达到 maxBatches 上限（视为告警）
 */
export async function expireSuspendedRunsJob(opts: {
  pool?: ConfirmManagerPool;
  mastraResolver?: MastraResolver;
  maxBatches?: number;
} = {}): Promise<ExpireSuspendedRunsJobResult> {
  const pool = opts.pool ?? getRegisteredConfirmManagerPool();
  const resolver = opts.mastraResolver ?? getRegisteredMastraResolver();
  const maxBatches = opts.maxBatches ?? EXPIRE_SUSPENDED_MAX_BATCHES_PER_TICK;

  let batches = 0;
  let totalProcessed = 0;
  let resumeErrors = 0;

  while (batches < maxBatches) {
    const [rows] = await pool.query<SuspendRow>(
      `SELECT run_id, step_id
         FROM mastra_workflow_suspend
        WHERE expires_at < NOW(3)
        LIMIT ?
        FOR UPDATE SKIP LOCKED`,
      [EXPIRE_SUSPENDED_BATCH_LIMIT],
    );

    batches += 1;

    if (rows.length === 0) {
      return { batches, totalProcessed, resumeErrors };
    }

    for (const row of rows) {
      // 尽力 mastra.resume({ CANCEL, reason: 'EXPIRED' })（任务卡 §8.4）
      try {
        const workflow = resolver.getWorkflow(HITL_WORKFLOW_ID);
        const tombstone = buildRuntimeContext({
          traceId: `tombstone_${row.run_id}`,
          sessionId: `tombstone_${row.run_id}`,
          merchantId: 'tombstone',
          storeId: 'tombstone',
          userId: 'tombstone',
          apiKeyPrefix: 'tombstone',
          requestStartedAt: Date.now(),
        });
        await workflow.resume({
          runId: row.run_id,
          step: row.step_id,
          resumeData: { decision: 'CANCEL', reason: 'EXPIRED' },
          runtimeContext: tombstone,
        });
      } catch (e) {
        // swallow + audit log（任务卡 §7 MUST DO §9）
        resumeErrors += 1;
        logger.warn(
          {
            err: e instanceof Error ? e.message : String(e),
            runId: row.run_id,
            stepId: row.step_id,
          },
          '[cron] expire-suspended-runs: mastra.resume(CANCEL) failed (swallowed)',
        );
      }

      await cancelActiveDraftForRun({
        pool,
        runId: row.run_id,
      });

      // 即便 resume 失败也必须清理 suspend + session，避免下一次 cron 重复打捞
      try {
        await pool.execute(
          `DELETE FROM mastra_workflow_suspend WHERE run_id = ?`,
          [row.run_id],
        );
      } catch (e) {
        logger.warn(
          {
            err: e instanceof Error ? e.message : String(e),
            runId: row.run_id,
          },
          '[cron] expire-suspended-runs: DELETE suspend failed (will retry next tick)',
        );
      }

      try {
        await pool.execute(
          `UPDATE agent_session
              SET active_run_id = NULL,
                  active_run_step = NULL,
                  active_run_expires_at = NULL,
                  resume_locked_at = NULL
            WHERE active_run_id = ?`,
          [row.run_id],
        );
      } catch (e) {
        logger.warn(
          {
            err: e instanceof Error ? e.message : String(e),
            runId: row.run_id,
          },
          '[cron] expire-suspended-runs: UPDATE agent_session failed (next tick handles)',
        );
      }

      totalProcessed += 1;
    }

    // 当本批不足 LIMIT → 已无更多过期行，提前退出（避免再发一次 0 行查询）
    if (rows.length < EXPIRE_SUSPENDED_BATCH_LIMIT) {
      return { batches, totalProcessed, resumeErrors };
    }

    // 批间 sleep（缓解长事务 / 复制延迟；与 expire-drafts 一致）
    await sleep(EXPIRE_SUSPENDED_BATCH_SLEEP_MS);
  }

  // 命中防御性上限：上层应据此告警（业务量爆炸 / idx_expires 失效）
  throw new BizError(
    'INTERNAL_ERROR',
    `expireSuspendedRunsJob: 单次执行批数达上限 ${maxBatches}，请检查 idx_expires 是否命中 / 业务量是否突增`,
    { meta: { batches, totalProcessed, resumeErrors } },
  );
}

async function cancelActiveDraftForRun(args: {
  pool: ConfirmManagerPool;
  runId: string;
}): Promise<void> {
  try {
    const [rows] = await args.pool.query<ActiveRunSessionRow>(
      `SELECT session_id, merchant_id, current_store_id, user_id, active_draft_id
         FROM agent_session
        WHERE active_run_id = ?
        LIMIT 1`,
      [args.runId],
    );
    const row = rows[0];
    if (!row?.active_draft_id) return;

    const tombstone = buildRuntimeContext({
      traceId: `tombstone_${args.runId}`,
      sessionId: row.session_id,
      merchantId: row.merchant_id,
      storeId: row.current_store_id,
      userId: row.user_id,
      apiKeyPrefix: 'tombstone',
      requestStartedAt: Date.now(),
    });
    const draft = await getByIdStrict(row.active_draft_id, tombstone);
    if (!['DRAFT', 'WAIT_CONFIRM', 'CONFIRMED'].includes(draft.status)) {
      return;
    }
    await transitDraft({
      draftId: draft.draftId,
      from: draft.status,
      to: 'CANCELLED',
      runtimeContext: tombstone,
    });
  } catch (e) {
    logger.warn(
      {
        err: e instanceof Error ? e.message : String(e),
        runId: args.runId,
      },
      '[cron] expire-suspended-runs: cancel active draft failed (non-blocking)',
    );
  }
}

/* ============================================================================
 * cron 注册
 * ========================================================================== */

/**
 * 启动 cron：每 intervalMs 触发一次 {@link expireSuspendedRunsJob}；返回 stop 函数。
 *
 * 行为（与 jobs/expire-drafts.ts 同形）：
 *   - 防重叠：上一次未结束时直接 skip（不堆积）
 *   - 失败 swallow：单次执行抛错只走 onError / pino warn，不打断后续 tick
 *   - timer.unref()：不阻塞主进程退出（测试 / SIGINT 优雅停机均不悬挂）
 *
 * @returns stop 函数（调用后停止 cron；幂等）
 */
export function startExpireSuspendedRunsCron(args: {
  intervalMs?: number;
  pool?: ConfirmManagerPool;
  mastraResolver?: MastraResolver;
  maxBatchesPerTick?: number;
  onError?: (err: unknown) => void;
} = {}): () => void {
  const interval = args.intervalMs ?? EXPIRE_SUSPENDED_DEFAULT_INTERVAL_MS;
  const onError =
    args.onError ??
    ((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[cron] expire-suspended-runs tick failed',
      );
    });

  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const jobArgs: {
        pool?: ConfirmManagerPool;
        mastraResolver?: MastraResolver;
        maxBatches?: number;
      } = {};
      if (args.pool !== undefined) jobArgs.pool = args.pool;
      if (args.mastraResolver !== undefined) jobArgs.mastraResolver = args.mastraResolver;
      if (args.maxBatchesPerTick !== undefined) jobArgs.maxBatches = args.maxBatchesPerTick;
      const result = await expireSuspendedRunsJob(jobArgs);
      if (result.totalProcessed > 0) {
        logger.info(
          {
            batches: result.batches,
            totalProcessed: result.totalProcessed,
            resumeErrors: result.resumeErrors,
          },
          '[cron] expire-suspended-runs tick ok',
        );
      }
    } catch (err) {
      onError(err);
    } finally {
      running = false;
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, interval);
  if (typeof handle.unref === 'function') handle.unref();

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(handle);
  };
}
