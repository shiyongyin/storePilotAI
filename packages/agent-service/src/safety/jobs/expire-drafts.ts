/**
 * 切片 13 — 过期 Draft 清理 Job（5 分钟 cron + LIMIT 500 分批 + 批间 sleep 100ms）
 *
 * 严格按 docs/tanks/13-safety-draft-manager.md §7 MUST DO §4 / §8.5 + 任务卡 §10 测试场景 12 落地。
 *
 * 交付能力：
 *   - {@link expireDraftsJob}：单次扫描；while loop 分批 UPDATE LIMIT 500，批间 sleep 100ms，
 *     直到一批 affectedRows=0 退出。
 *   - {@link startExpireDraftsCron}：注册 setInterval（默认 5 分钟）触发 {@link expireDraftsJob}；
 *     防重叠（上一次未结束跳过本次）；返回 stop 函数；timer.unref() 不悬挂测试 / 主进程。
 *
 * 强约束（违反即拒收）：
 *   - 不得一次 UPDATE 几万行（必须 LIMIT 500 分批 + sleep）。
 *   - 不得跳过状态机：UPDATE 仅命中 status IN ('DRAFT', 'WAIT_CONFIRM') 且 updated_at < NOW(3) - INTERVAL 30 MINUTE，
 *     CONFIRMED / 终态行不会被改（任务卡 §10 测试场景 7：CONFIRMED 不过期）。
 *   - 短事务：循环内每批独立 UPDATE，无 BEGIN / TRANSACTION 包裹；不在事务内 await LLM/MCP。
 *
 * 引用：
 *   - 任务卡 §8.5（cron + LIMIT 500 + sleep 100）
 *   - 设计指南 §29.2 / §34.4
 *   - 切片 03 idx_draft_expires（性能基础）
 */
import { BizError } from '@storepilot/shared-contracts';

import { logger } from '../../observability/logger.js';
import type { DraftPool } from '../draft-manager.js';
import { __testInternals as draftTestInternals, getRegisteredDraftPool } from '../draft-manager.js';

// 由 draft-manager 暴露内部测试 helper（见同切片 draft-manager.ts 末尾导出）。
void draftTestInternals;

/** 每批最多 UPDATE 行数（任务卡 §7 MUST DO §4） */
export const EXPIRE_DRAFTS_BATCH_LIMIT = 500;
/** 批间 sleep 毫秒（任务卡 §8.5） */
export const EXPIRE_DRAFTS_BATCH_SLEEP_MS = 100;
/** 默认 cron 间隔 5 分钟（任务卡 §6 / §10） */
export const EXPIRE_DRAFTS_DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
/**
 * 单次 cron tick 内最多分批数；防御性兜底，避免极端情况下死循环
 * （正常 30 分钟过期 + 业务量级，单次 cron 远不会触发该上限；命中即视为告警条件）。
 */
export const EXPIRE_DRAFTS_MAX_BATCHES_PER_TICK = 200;

/**
 * 简单 sleep（不依赖 timers/promises 以避免 ESM 兼容性边界；与切片 11 strategy-cache 一致）。
 *
 * @param ms 毫秒
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    if (typeof handle.unref === 'function') handle.unref();
  });
}

/**
 * Job 单次执行结果（便于测试断言批数 / 总改行数）。
 */
export interface ExpireDraftsJobResult {
  batches: number;
  totalAffected: number;
}

/**
 * 单次扫描：分批 UPDATE 直到一批 affectedRows=0 退出。
 *
 * SQL 语义（任务卡 §7 MUST DO §4）：
 *   ```sql
 *   UPDATE replenishment_draft
 *      SET status = 'EXPIRED', updated_at = NOW(3)
 *    WHERE status IN ('DRAFT','WAIT_CONFIRM')
 *      AND updated_at < NOW(3) - INTERVAL 30 MINUTE
 *    LIMIT 500
 *   ```
 *
 * 关键不变量：
 *   - CONFIRMED / SUBMITTED / EXPIRED / CANCELLED / FAILED 不会被改（防误改 SUBMITTED 路径）。
 *   - 跨租户：本 Job 是平台级清理，不带 merchant/store WHERE（任务卡定位为运维 cron，
 *     由 trace_id / 审计日志兜底；与切片 16 SUSPEND 清理同语义）。
 *
 * @param pool 可选注入；未传则从 {@link getRegisteredDraftPool} 取（与 manager 共享同一连接池）
 * @param maxBatches 单次执行最大批数（默认 {@link EXPIRE_DRAFTS_MAX_BATCHES_PER_TICK}）
 * @returns 本次执行的批数与累计改行数
 * @throws BizError 当批数达到 maxBatches 上限（视为告警）
 */
export async function expireDraftsJob(opts: {
  pool?: DraftPool;
  maxBatches?: number;
} = {}): Promise<ExpireDraftsJobResult> {
  const pool = opts.pool ?? getRegisteredDraftPool();
  const maxBatches = opts.maxBatches ?? EXPIRE_DRAFTS_MAX_BATCHES_PER_TICK;

  let batches = 0;
  let totalAffected = 0;

  while (batches < maxBatches) {
    const [result] = await pool.execute(
      `UPDATE replenishment_draft
          SET status = 'EXPIRED', updated_at = NOW(3)
        WHERE status IN ('DRAFT', 'WAIT_CONFIRM')
          AND updated_at < NOW(3) - INTERVAL 30 MINUTE
        LIMIT ?`,
      [EXPIRE_DRAFTS_BATCH_LIMIT],
    );

    batches += 1;
    totalAffected += result.affectedRows;

    if (result.affectedRows === 0) {
      // 没有更多过期行 → 正常退出
      return { batches, totalAffected };
    }

    // 批间 sleep，缓解长事务 / 复制延迟（任务卡 §8.5）
    await sleep(EXPIRE_DRAFTS_BATCH_SLEEP_MS);
  }

  // 命中防御性上限：上层应据此告警（task §7 MUST NOT §6 边界）。
  throw new BizError(
    'INTERNAL_ERROR',
    `expireDraftsJob: 单次执行批数达上限 ${maxBatches}，请检查 idx_draft_expires 是否命中 / 业务量是否突增`,
    { meta: { batches, totalAffected } },
  );
}

/**
 * 启动 cron：每 intervalMs 触发一次 {@link expireDraftsJob}；返回 stop 函数。
 *
 * 行为：
 *   - 防重叠：上一次未结束时直接 skip（不堆积）。
 *   - 失败 swallow：单次执行抛错只走 `onError` / pino warn，不打断后续 tick。
 *   - timer.unref()：不阻塞主进程退出（测试 / SIGINT 优雅停机均不悬挂）。
 *
 * @returns stop 函数（调用后停止 cron；幂等）
 */
export function startExpireDraftsCron(args: {
  intervalMs?: number;
  pool?: DraftPool;
  maxBatchesPerTick?: number;
  onError?: (err: unknown) => void;
} = {}): () => void {
  const interval = args.intervalMs ?? EXPIRE_DRAFTS_DEFAULT_INTERVAL_MS;
  const onError =
    args.onError ??
    ((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[cron] expire-drafts tick failed',
      );
    });

  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const jobArgs: { pool?: DraftPool; maxBatches?: number } = {};
      if (args.pool !== undefined) jobArgs.pool = args.pool;
      if (args.maxBatchesPerTick !== undefined) jobArgs.maxBatches = args.maxBatchesPerTick;
      const result = await expireDraftsJob(jobArgs);
      if (result.totalAffected > 0) {
        logger.info(
          { batches: result.batches, totalAffected: result.totalAffected },
          '[cron] expire-drafts tick ok',
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
