/**
 * 切片 17 — markSubmitted 失败补偿 Job（1 分钟 cron + ERP 反查 + 回填 PO 号）
 *
 * 严格按 docs/tanks/17-skill-purchase-order-create-hitl.md §7 / §8.3 + 任务卡 §9 / §10 落地。
 *
 * 业务场景：
 *   purchase_order_create.createPoStep 调 ERP `createPurchaseOrder` 成功后，再 `markSubmitted`
 *   把 draft 从 CONFIRMED → SUBMITTED + 写入 submitted_po_no。
 *   若 markSubmitted 因 DB 抖动失败（被 try/catch 吞掉，不抛错），draft 状态会停留在
 *   CONFIRMED + submitted_po_no IS NULL；本 Job 每 1 分钟扫一次：
 *     1. SELECT submitted_po_no IS NULL AND status='CONFIRMED' AND created_at < NOW(3) - 30s LIMIT 100
 *     2. 对每行：调 ERP createPurchaseOrder（**同 idempotencyKey === draftId** → 返回相同 PO 号）
 *     3. markSubmitted 回填；失败 swallow + audit log，下一轮再试。
 *
 * 强约束（任务卡 §7 MUST DO §8 / MUST NOT，违反即拒收）：
 *   - MUST：cron 间隔 1 分钟（任务卡 §8.3 / §10 测试场景 5）。
 *   - MUST：SELECT 严格带 `submitted_po_no IS NULL AND status='CONFIRMED'
 *           AND created_at < NOW(3) - INTERVAL 30 SECOND LIMIT 100`（30s 防抖动 + 100 上限分批）。
 *   - MUST：reentry 调 ERP 时 idempotencyKey === sourceDraftId === draftId（R-PO-002）。
 *   - MUST：从 draft.items 结构化取数（R-PO-003，禁止反解析 markdown）。
 *   - MUST：单行失败 swallow + audit log，不阻断其它行；下一轮再扫（任务卡 §7 MUST DO §8）。
 *   - MUST NOT：跳过 DraftManager.markSubmitted 直接 UPDATE 表（绕过状态机）。
 *   - MUST NOT：单次扫描跑几万行（LIMIT 100 + 防御性 maxBatchesPerTick 上限）。
 *
 * 设计决策：
 *   - 复用切片 13 注册的 DraftPool（与 draft-manager 共享同一连接池），避免新增 DI。
 *   - 复用切片 08 mcpTools()（已是单例 MCPClient）。
 *   - 反查 ERP 形态：V1 mock-server 实现幂等 Map（同 idempotencyKey → 同 poNo），
 *     V2 切片 21 切真实 ERP 时同语义不变（HTTP 端做幂等）。
 *   - markSubmitted 需要 RuntimeContext —— 用 draft 行的 merchantId / storeId 构造 tombstone ctx
 *     （与 expire-suspended-runs.ts 同模式），traceId 用 `compensate_${draftId}` 便于审计。
 *
 * 引用：
 *   - 任务卡 docs/tanks/17-skill-purchase-order-create-hitl.md §6 / §7 / §8.3 / §9
 *   - E-Skill.md §T-SKILL-05.5.3
 *   - 切片 05（createPurchaseOrder 契约 + idempotencyKey refine）
 *   - 切片 08（mcpTools / TOOL_WHITELIST）
 *   - 切片 13（DraftManager.markSubmitted / DraftPool）
 *   - 切片 16（expire-suspended-runs 同形 cron 模板）
 *
 * @since 2026-05-07（切片 17 落地）
 */
import { BizError, type DraftItem } from '@storepilot/shared-contracts';
import type {
  PurchaseOrderItem,
  PurchaseOrderResult,
} from '@storepilot/shared-contracts/mcp';

import { logger } from '../../observability/logger.js';
import { mcpTools } from '../../mastra/mcp/client.js';
import { buildRuntimeContext } from '../../mastra/runtime-context.js';
import {
  type DraftPool,
  getRegisteredDraftPool,
  markSubmitted,
} from '../draft-manager.js';

/* ============================================================================
 * 常量
 * ========================================================================== */

/** 单批 SELECT 上限（任务卡 §8.3） */
export const COMPENSATE_BATCH_LIMIT = 100;
/** 批间 sleep 毫秒（与 expire-* Job 同语义） */
export const COMPENSATE_BATCH_SLEEP_MS = 100;
/** 默认 cron 间隔 1 分钟（任务卡 §8.3 / §10 测试场景 5） */
export const COMPENSATE_DEFAULT_INTERVAL_MS = 60 * 1000;
/** 单次 cron tick 内最多分批数（防御性兜底） */
export const COMPENSATE_MAX_BATCHES_PER_TICK = 50;
/** 30 秒 grace（任务卡 §8.3：避免 mid-flight 行被反查） */
export const COMPENSATE_GRACE_SECONDS = 30;

/**
 * 简单 sleep（与 expire-* Job 同形，避免互相 import 形成环依赖）。
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
 * Tool 类型适配（与 purchase-order-create.ts 一致）
 * ========================================================================== */

interface CreatePurchaseOrderTool {
  // Mastra 1.0 ToolAction.execute(inputData, context?) — inputData 直接展开。
  execute(inputData: {
    merchantId: string;
    storeId: string;
    source: 'AI_REPLENISHMENT_AGENT';
    sourceDraftId: string;
    idempotencyKey: string;
    items: PurchaseOrderItem[];
  }): Promise<PurchaseOrderResult>;
}

interface PoTools {
  createPurchaseOrder: CreatePurchaseOrderTool;
}

/* ============================================================================
 * Job 单次执行
 * ========================================================================== */

/**
 * 单次 cron tick 的执行结果（便于测试断言）。
 */
export interface CompensateMarkSubmittedJobResult {
  /** 扫描的批数（每批 LIMIT 100） */
  batches: number;
  /** 处理的待补偿草稿总数（已尝试一次 ERP 反查） */
  totalProcessed: number;
  /** 成功补偿的草稿数（reentry ERP + markSubmitted 都成功） */
  totalCompensated: number;
  /** 失败次数（ERP 异常 / markSubmitted 失败 / 其它） */
  totalFailed: number;
}

/**
 * 待补偿草稿行投影。
 *
 * - `items`：mysql2 读 JSON 列时已 parse 为对象/数组；本 Job 兼容字符串形态。
 */
interface PendingDraftRow extends Record<string, unknown> {
  draft_id: string;
  merchant_id: string;
  store_id: string;
  user_id: string;
  trace_id: string;
  items: DraftItem[] | string;
}

/**
 * 把 row.items 兼容性 parse 为 DraftItem[]。
 *
 * - mysql2 默认对 JSON 列返回已 parse 的对象；
 * - 部分驱动 / 字段类型为 TEXT 时返回字符串，需要 JSON.parse。
 */
function parseItems(raw: DraftItem[] | string): DraftItem[] {
  if (typeof raw !== 'string') return raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as DraftItem[]) : [];
  } catch {
    return [];
  }
}

/**
 * 对单条 pending draft 执行补偿：
 *
 *   1. 调 ERP createPurchaseOrder（同 idempotencyKey === draftId → 返回相同 PO 号）。
 *   2. 用 tombstone runtimeContext 调 DraftManager.markSubmitted 回填 PO 号 + 状态。
 *
 * 内部 try/catch；任何失败 swallow + audit log（任务卡 §7 MUST DO §8）。
 *
 * @returns true = 成功补偿；false = 失败（下一轮再试）
 */
async function compensateOne(args: {
  row: PendingDraftRow;
  tools: PoTools;
}): Promise<boolean> {
  const { row, tools } = args;
  const items = parseItems(row.items);

  if (items.length === 0) {
    // 异常：CONFIRMED 草稿无 items（理论上 createPo 前 assert 已守门，这里防御）。
    logger.warn(
      { draftId: row.draft_id, merchantId: row.merchant_id, storeId: row.store_id },
      '[compensate] pending draft has empty items; skip',
    );
    return false;
  }

  // tombstone runtimeContext：markSubmitted 仅用 merchantId / storeId 做跨租户硬隔离 WHERE
  const tombstoneCtx = buildRuntimeContext({
    traceId: `compensate_${row.draft_id}`,
    sessionId: `compensate_${row.draft_id}`,
    merchantId: row.merchant_id,
    storeId: row.store_id,
    userId: row.user_id || 'compensate',
    apiKeyPrefix: 'compensate',
    requestStartedAt: Date.now(),
  });

  try {
    const result = await tools.createPurchaseOrder.execute({
      merchantId: row.merchant_id,
      storeId: row.store_id,
      source: 'AI_REPLENISHMENT_AGENT',
      sourceDraftId: row.draft_id,
      idempotencyKey: row.draft_id, // R-PO-002：必须等于 sourceDraftId
      items: items.map((it) => ({
        skuId: it.skuId,
        quantity: it.finalSuggestQty,
        unit: it.unit,
        reason: it.reason,
      })),
    });

    await markSubmitted(row.draft_id, result.purchaseOrderNo, tombstoneCtx);

    logger.info(
      {
        draftId: row.draft_id,
        purchaseOrderNo: result.purchaseOrderNo,
      },
      '[compensate] mark-submitted compensated',
    );
    return true;
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        draftId: row.draft_id,
      },
      '[compensate] retry next cycle',
    );
    return false;
  }
}

/**
 * 单次扫描：分批 SELECT pending draft，对每行做补偿。
 *
 * SQL 语义（任务卡 §8.3）：
 *   ```sql
 *   SELECT draft_id, merchant_id, store_id, user_id, trace_id, items
 *     FROM replenishment_draft
 *    WHERE submitted_po_no IS NULL
 *      AND status = 'CONFIRMED'
 *      AND created_at < NOW(3) - INTERVAL 30 SECOND
 *    LIMIT 100
 *   ```
 *
 * 关键不变量：
 *   - 30s grace 防 mid-flight 行被反查（任务卡 §8.3 + 测试场景 5）。
 *   - LIMIT 100 + maxBatchesPerTick 防爆炸；命中上限抛 BizError 触发告警。
 *   - 单行失败不阻断其它行（任务卡 §7 MUST DO §8）。
 *
 * @param opts 可选注入（pool / tools / maxBatches）；测试用
 * @returns 单次执行批数 / 处理 / 成功 / 失败计数
 * @throws BizError 当批数达到 maxBatches 上限（视为告警）
 */
export async function compensateMarkSubmittedJob(opts: {
  pool?: DraftPool;
  tools?: PoTools;
  maxBatches?: number;
} = {}): Promise<CompensateMarkSubmittedJobResult> {
  const pool = opts.pool ?? getRegisteredDraftPool();
  const tools = opts.tools ?? ((await mcpTools()) as unknown as PoTools);
  const maxBatches = opts.maxBatches ?? COMPENSATE_MAX_BATCHES_PER_TICK;

  let batches = 0;
  let totalProcessed = 0;
  let totalCompensated = 0;
  let totalFailed = 0;

  while (batches < maxBatches) {
    const [rows] = await pool.query<PendingDraftRow>(
      `SELECT draft_id, merchant_id, store_id, user_id, trace_id, items
         FROM replenishment_draft
        WHERE submitted_po_no IS NULL
          AND status = 'CONFIRMED'
          AND created_at < NOW(3) - INTERVAL ? SECOND
        LIMIT ?`,
      [COMPENSATE_GRACE_SECONDS, COMPENSATE_BATCH_LIMIT],
    );

    batches += 1;

    if (rows.length === 0) {
      return { batches, totalProcessed, totalCompensated, totalFailed };
    }

    for (const row of rows) {
      totalProcessed += 1;
      const ok = await compensateOne({ row, tools });
      if (ok) {
        totalCompensated += 1;
      } else {
        totalFailed += 1;
      }
    }

    // 当本批不足 LIMIT → 已无更多 pending，提前退出
    if (rows.length < COMPENSATE_BATCH_LIMIT) {
      return { batches, totalProcessed, totalCompensated, totalFailed };
    }

    // 批间 sleep（缓解长事务 / 复制延迟；与 expire-* Job 一致）
    await sleep(COMPENSATE_BATCH_SLEEP_MS);
  }

  // 命中防御性上限：上层应据此告警
  throw new BizError(
    'INTERNAL_ERROR',
    `compensateMarkSubmittedJob: 单次执行批数达上限 ${maxBatches}，请检查 idx 是否命中 / 业务量是否突增`,
    { meta: { batches, totalProcessed, totalCompensated, totalFailed } },
  );
}

/* ============================================================================
 * cron 注册
 * ========================================================================== */

/**
 * 启动 cron：每 intervalMs 触发一次 {@link compensateMarkSubmittedJob}；返回 stop 函数。
 *
 * 行为（与 jobs/expire-* 同形）：
 *   - 防重叠：上一次未结束时直接 skip（不堆积）。
 *   - 失败 swallow：单次执行抛错只走 onError / pino warn，不打断后续 tick。
 *   - timer.unref()：不阻塞主进程退出。
 *
 * @returns stop 函数（调用后停止 cron；幂等）
 */
export function startCompensateMarkSubmittedCron(args: {
  intervalMs?: number;
  pool?: DraftPool;
  tools?: PoTools;
  maxBatchesPerTick?: number;
  onError?: (err: unknown) => void;
} = {}): () => void {
  const interval = args.intervalMs ?? COMPENSATE_DEFAULT_INTERVAL_MS;
  const onError =
    args.onError ??
    ((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[cron] compensate-mark-submitted tick failed',
      );
    });

  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const jobArgs: {
        pool?: DraftPool;
        tools?: PoTools;
        maxBatches?: number;
      } = {};
      if (args.pool !== undefined) jobArgs.pool = args.pool;
      if (args.tools !== undefined) jobArgs.tools = args.tools;
      if (args.maxBatchesPerTick !== undefined) jobArgs.maxBatches = args.maxBatchesPerTick;
      const result = await compensateMarkSubmittedJob(jobArgs);
      if (result.totalProcessed > 0) {
        logger.info(
          {
            batches: result.batches,
            totalProcessed: result.totalProcessed,
            totalCompensated: result.totalCompensated,
            totalFailed: result.totalFailed,
          },
          '[cron] compensate-mark-submitted tick ok',
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

/* ============================================================================
 * Test-only exports
 * ========================================================================== */

/**
 * 仅供单测 / e2e（生产代码不要使用）。
 *
 * @internal
 */
export const __test_only__ = {
  compensateOne,
  parseItems,
};
