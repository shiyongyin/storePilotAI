/**
 * 切片 15 — 补货调整 Workflow（replenishment_adjustment）
 *
 * 严格按 docs/tanks/15-skill-replenishment-adjustment.md §6 / §7 / §8 落地。
 *
 * 4 step：
 *   1. {@link loadActiveDraftStep}    — 找 active_draft_id（agent_session）或 findRecentDraft（5 分钟兜底）；
 *      无 → BizError(DRAFT_NOT_FOUND, "请先让我算一份补货")；
 *      EXPIRED → DRAFT_EXPIRED；SUBMITTED → DRAFT_ALREADY_SUBMITTED；CANCELLED/FAILED → DRAFT_NOT_FOUND。
 *      调用 mergeStrategy 取 maxAdjustmentsPerDraft；查 adjustment_log 调整次数；超过 → ADJUSTMENT_TOO_MANY。
 *   2. {@link extractInstructionStep} — extractAdjustmentInstruction（LLM + Zod 结构化抽取）。
 *   3. {@link applyInstructionStep}   — matchTargets + applyAdjustment；0 命中 → ADJUSTMENT_SKU_UNMATCHED。
 *   4. {@link persistAdjustmentStep}  — DraftManager.updateItems 更新 items + 写 replenishment_adjustment_log 一行。
 *
 * 强约束（违反即拒收，与任务卡 §7 一一对应）：
 *   - MUST：先抽 AdjustmentInstruction 结构化，再修改草稿（任务卡 §7 §1）。
 *   - MUST：4 级匹配优先级**短路**（matcher.ts 守门 + 测试覆盖）。
 *   - MUST：0 匹配 → ADJUSTMENT_SKU_UNMATCHED + friendlyMessage（任务卡 §7 §3）。
 *   - MUST：调整次数上限取自 mergeStrategy().merged.safetyPolicy.maxAdjustmentsPerDraft；
 *     超过 → ADJUSTMENT_TOO_MANY（任务卡 §7 §4 / §8.4）。
 *   - MUST：每次调整写 replenishment_adjustment_log 一行（含 before / after items + instruction + affected_sku_ids）。
 *   - MUST：修改 finalSuggestQty 后必须更新 replenishment_draft.items（DraftManager.updateItems）+ adjustmentTrace 累加。
 *   - MUST：markdown 显式列"## 影响的 SKU"列表（全部 matched，不省略）。
 *   - MUST NOT：LLM 直接产出 finalSuggestQty（数字由 matcher 算）。
 *   - MUST NOT：markdown 描述调整而不更新 draftItems（R-PO-003）。
 *   - MUST NOT：草稿过期 / 已提交后还允许调整。
 *   - MUST NOT：跳过 replenishment_adjustment_log。
 *   - MUST NOT：调用任何 WRITE 工具（createPurchaseOrder 不在 V1 白名单）。
 *
 * 引用：
 *   - 任务卡 docs/tanks/15-skill-replenishment-adjustment.md §6 / §7 / §8 / §9
 *   - 切片 04（AdjustmentInstruction / ADJUSTMENT_* / DRAFT_*）
 *   - 切片 06（RuntimeContext）
 *   - 切片 11（mergeStrategy.maxAdjustmentsPerDraft）
 *   - 切片 13（DraftManager.getByIdStrict / findRecentDraft / updateItems / DraftPool）
 *
 * @since 2026-05-07（切片 15 落地）
 */
import { createStep, createWorkflow } from '@mastra/core/workflows';
import {
  AdjustmentInstruction,
  BizError,
  StrategySchema,
  type DraftItem,
} from '@storepilot/shared-contracts';
import { z } from 'zod';

import { logger } from '../../observability/logger.js';
import * as draftManager from '../../safety/draft-manager.js';
import { mergeStrategy } from '../../safety/strategy-engine.js';
import { extractAdjustmentInstruction } from '../../skills/replenishment/instruction-extractor.js';
import {
  applyAdjustment,
  matchTargets,
  type SkuCategoryMap,
} from '../../skills/replenishment/matcher.js';
import type { AgentRuntime, RuntimeContext } from '../runtime-context.js';

/* ============================================================================
 * Schema
 * ========================================================================== */

/**
 * 调整 Workflow 入参。
 *
 * - `draftId` 可选；缺省时由 step1 从 agent_session.active_draft_id 取，
 *   仍无则 findRecentDraft 5 分钟兜底；最终仍无 → DRAFT_NOT_FOUND + friendlyMessage "请先让我算一份补货"。
 * - `userMessage` 是必填的老板原句（"矿泉水上调 20%"），由 LLM 在 step2 抽取。
 */
const AdjustmentInputSchema = z.object({
  sessionId: z.string().min(1),
  userMessage: z.string().min(1).max(500),
  draftId: z.string().optional(),
});

/**
 * step1 → step2 / step3 之间携带的草稿快照与限制信息。
 */
const LoadActiveDraftStepOutputSchema = z.object({
  draftId: z.string(),
  status: z.string(),
  forecastDays: z.number().int().min(1).max(30),
  strategyVersion: z.string(),
  /** 经 mergeStrategy 取出的当前调整次数上限（来自 safetyPolicy.maxAdjustmentsPerDraft） */
  maxAdjustmentsPerDraft: z.number().int().positive(),
  /** 当前 draft 已经写入 adjustment_log 的次数（before this run） */
  currentAdjustmentCount: z.number().int().nonnegative(),
  /** draft.items 全文（DraftItem[]） */
  items: z.array(z.unknown()),
  /** session 级原始 sessionId（透传到 step3 / step4） */
  sessionId: z.string(),
  /** 用户原句 */
  userMessage: z.string(),
});

const ExtractStepOutputSchema = LoadActiveDraftStepOutputSchema.extend({
  instruction: z.unknown(), // 用 z.unknown 透传，类型断言由代码保证（避免 z.object 与 shared-contracts 双源）
});

const ApplyStepOutputSchema = ExtractStepOutputSchema.extend({
  /** 调整前 items 全文（DraftItem[]） — 写 log 用 */
  beforeItems: z.array(z.unknown()),
  /** matchTargets 命中的 skuId 列表（去重 / 保持原顺序） */
  affectedSkuIds: z.array(z.string()),
  /** applyAdjustment 之后的全量 items（仅 matched 行变化） */
  afterItems: z.array(z.unknown()),
});

const AdjustmentOutputSchema = z.object({
  draftId: z.string(),
  status: z.string(),
  adjustmentId: z.string(),
  affectedSkuIds: z.array(z.string()),
  affectedCount: z.number().int().nonnegative(),
  remainingAdjustments: z.number().int().nonnegative(),
  summaryMarkdown: z.string().min(1),
  items: z.array(
    z.object({
      skuId: z.string(),
      skuName: z.string(),
      unit: z.string(),
      baseSuggestQty: z.number().int().nonnegative(),
      finalSuggestQty: z.number().int().nonnegative(),
      reason: z.string(),
      adjustmentTrace: z.array(z.string()),
    }),
  ),
});

export type AdjustmentOutput = z.infer<typeof AdjustmentOutputSchema>;

/* ============================================================================
 * Pool / Helper（adjustment_log 读 / 写、agent_session.active_draft_id 读）
 *
 * 复用 DraftManager 的注册 Pool（生产 / 测试同一 mysql2 Pool 实例），
 * 避免新增第二条 DI；adjustment_log 与 replenishment_draft 同库同租户路径。
 * ========================================================================== */

/**
 * 当前 draft 已写入的 adjustment_log 行数（任务卡 §8.4）。
 *
 * 用于在 step1 与 maxAdjustmentsPerDraft 比较；超过 → ADJUSTMENT_TOO_MANY。
 *
 * @returns 已写行数（>=0）
 */
async function countAdjustmentLogs(draftId: string): Promise<number> {
  const pool = draftManager.getRegisteredDraftPool();
  const [rows] = await pool.query<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM replenishment_adjustment_log WHERE draft_id = ?`,
    [draftId],
  );
  const row = rows[0];
  return row ? Number(row.cnt) : 0;
}

/**
 * 写入 replenishment_adjustment_log 一行（任务卡 §7 MUST DO §5 / §9 步骤 5）。
 *
 * 必填字段：adjustment_id / draft_id / user_message / target_type / target_value /
 * adjustment_type / reason / applied=1 / before_items_json / after_items_json /
 * instruction_json / affected_sku_ids。可选 adjustment_rate / adjustment_qty。
 */
async function writeAdjustmentLog(args: {
  instruction: AdjustmentInstruction;
  beforeItems: ReadonlyArray<DraftItem>;
  afterItems: ReadonlyArray<DraftItem>;
  affectedSkuIds: ReadonlyArray<string>;
}): Promise<void> {
  const pool = draftManager.getRegisteredDraftPool();
  const ins = args.instruction;
  await pool.execute(
    `INSERT INTO replenishment_adjustment_log
       (adjustment_id, draft_id, user_message,
        target_type, target_value, adjustment_type,
        adjustment_rate, adjustment_qty, reason, applied,
        before_items_json, after_items_json, instruction_json, affected_sku_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1,
        CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON))`,
    [
      ins.adjustmentId,
      ins.draftId,
      ins.userMessage,
      ins.targetType,
      ins.targetValue,
      ins.adjustmentType,
      ins.adjustmentRate ?? null,
      ins.adjustmentQty ?? null,
      ins.reason,
      JSON.stringify(args.beforeItems),
      JSON.stringify(args.afterItems),
      JSON.stringify(ins),
      JSON.stringify(args.affectedSkuIds),
    ],
  );
}

/**
 * 取 agent_session.active_draft_id（任务卡 §7 MUST DO §1 兜底前的首选路径）。
 *
 * 单租户硬隔离：仅取本 sessionId 行；session 行可能不存在（V1 由 confirm-manager / 切片 09 维护）。
 *
 * @returns active_draft_id（可能为 null，调用方应回退到 findRecentDraft）
 */
async function loadActiveDraftId(sessionId: string): Promise<string | null> {
  try {
    const pool = draftManager.getRegisteredDraftPool();
    const [rows] = await pool.query<{ active_draft_id: string | null }>(
      `SELECT active_draft_id FROM agent_session WHERE session_id = ? LIMIT 1`,
      [sessionId],
    );
    return rows[0]?.active_draft_id ?? null;
  } catch (e) {
    // agent_session 表抖动不阻断业务（findRecentDraft 兜底）
    logger.warn(
      { err: e instanceof Error ? e.message : String(e), sessionId },
      '[replenishment_adjustment] loadActiveDraftId failed, fallback to findRecentDraft',
    );
    return null;
  }
}

/* ============================================================================
 * Step 1：loadActiveDraftStep
 * ========================================================================== */

/**
 * 取活跃草稿（按以下顺序）：
 *
 *   1. inputData.draftId（用户显式带入）
 *   2. agent_session.active_draft_id
 *   3. DraftManager.findRecentDraft(ctx, 5) 5 分钟兜底
 *
 * 取到 draft 后做边界判定：
 *   - EXPIRED  → BizError(DRAFT_EXPIRED)（任务卡 §7 MUST DO §6 / §10 测试场景 4）
 *   - SUBMITTED → BizError(DRAFT_ALREADY_SUBMITTED)（同上）
 *   - CANCELLED / FAILED → BizError(DRAFT_NOT_FOUND)（终态视为不存在）
 *   - DRAFT / WAIT_CONFIRM / CONFIRMED → 可调整
 *
 * 仍取不到 draft → BizError(DRAFT_NOT_FOUND, "请先让我算一份补货")。
 *
 * 同时调用 mergeStrategy 取 safetyPolicy.maxAdjustmentsPerDraft + countAdjustmentLogs；
 * 当前已写次数 >= 上限 → BizError(ADJUSTMENT_TOO_MANY)（任务卡 §7 MUST DO §4 / §10 测试场景 6）。
 */
export const loadActiveDraftStep = createStep({
  id: 'load-active-draft',
  inputSchema: AdjustmentInputSchema,
  outputSchema: LoadActiveDraftStepOutputSchema,
  execute: async ({ inputData, requestContext }) => {
    const ctx = requestContext as unknown as RuntimeContext<AgentRuntime>;
    const merchantId = getRuntimeString(ctx, 'merchantId');
    const storeId = getRuntimeString(ctx, 'storeId');

    const draft = await locateDraft({
      explicitDraftId: inputData.draftId,
      sessionId: inputData.sessionId,
      runtimeContext: ctx,
    });

    // 状态机边界（任务卡 §7 MUST DO §6）
    switch (draft.status) {
      case 'EXPIRED':
        throw new BizError('DRAFT_EXPIRED', '上次的补货建议已过期', {
          meta: { draftId: draft.draftId },
        });
      case 'SUBMITTED':
        throw new BizError('DRAFT_ALREADY_SUBMITTED', '该补货建议已提交过采购单', {
          meta: { draftId: draft.draftId, submittedPoNo: draft.submittedPoNo },
        });
      case 'CANCELLED':
      case 'FAILED':
        throw new BizError('DRAFT_NOT_FOUND', '未找到可调整的补货建议', {
          meta: { draftId: draft.draftId, status: draft.status },
        });
      // 可调整：DRAFT / WAIT_CONFIRM / CONFIRMED
      default:
        break;
    }

    // 调整次数上限（任务卡 §7 MUST DO §4）
    const strategyEntry = await mergeStrategy({ merchantId, storeId });
    const mergedStrategy = StrategySchema.parse(strategyEntry.merged);
    const maxAdjustments = mergedStrategy.safetyPolicy.maxAdjustmentsPerDraft;
    const currentCount = await countAdjustmentLogs(draft.draftId);
    if (currentCount >= maxAdjustments) {
      throw new BizError(
        'ADJUSTMENT_TOO_MANY',
        `已达调整上限 ${maxAdjustments} 次`,
        { meta: { draftId: draft.draftId, currentCount, maxAdjustments } },
      );
    }

    return {
      draftId: draft.draftId,
      status: draft.status,
      forecastDays: draft.forecastDays,
      strategyVersion: strategyEntry.version,
      maxAdjustmentsPerDraft: maxAdjustments,
      currentAdjustmentCount: currentCount,
      items: draft.items,
      sessionId: inputData.sessionId,
      userMessage: inputData.userMessage,
    };
  },
});

/**
 * locateDraft：按"显式 draftId → active_draft_id → findRecentDraft"的优先级查找。
 *
 * 任意路径失败均不报错；最终都未命中 → DRAFT_NOT_FOUND。
 *
 * 导出供单测覆盖"sessionId 漂移恢复"路径。
 */
export async function locateDraft(args: {
  explicitDraftId?: string | undefined;
  sessionId: string;
  runtimeContext: RuntimeContext<AgentRuntime>;
}): Promise<draftManager.DraftView> {
  if (args.explicitDraftId) {
    return draftManager.getByIdStrict(args.explicitDraftId, args.runtimeContext);
  }

  const activeDraftId = await loadActiveDraftId(args.sessionId);
  if (activeDraftId) {
    try {
      return await draftManager.getByIdStrict(activeDraftId, args.runtimeContext);
    } catch {
      // 跨租户 / 已删除 → 回退到 findRecentDraft
    }
  }

  const recents = await draftManager.findRecentDraft(args.runtimeContext, 5);
  // 跳过终态（CANCELLED / FAILED / SUBMITTED / EXPIRED）找第一个可用草稿
  const usable = recents.find(
    (d) =>
      d.status === 'DRAFT' ||
      d.status === 'WAIT_CONFIRM' ||
      d.status === 'CONFIRMED',
  );
  if (usable) return usable;

  throw new BizError('DRAFT_NOT_FOUND', '请先让我算一份补货', {
    meta: { sessionId: args.sessionId },
  });
}

/* ============================================================================
 * Step 2：extractInstructionStep
 * ========================================================================== */

/**
 * LLM 抽取 AdjustmentInstruction（任务卡 §7 MUST DO §1）。
 *
 * - userMessage / draftId 来自 step1（非 LLM 编造）；adjustmentId 由 instruction-extractor 填入。
 * - draftItemNames 取 draft.items 的前 50 行（"<skuId> <skuName>"）作为 LLM 选 SKU 的对照表。
 * - 失败重试 1 次（在 instruction-extractor 内部完成）；再失败抛 SCHEMA_FAIL 让上游处理。
 */
export const extractInstructionStep = createStep({
  id: 'extract-instruction',
  inputSchema: LoadActiveDraftStepOutputSchema,
  outputSchema: ExtractStepOutputSchema,
  execute: async ({ inputData }) => {
    const items = inputData.items as DraftItem[];
    const draftItemNames = items.slice(0, 50).map(
      (it) => `${it.skuId} ${it.skuName}`,
    );

    const instruction = await extractAdjustmentInstruction({
      userMessage: inputData.userMessage,
      draftId: inputData.draftId,
      draftItemNames,
    });

    return {
      ...inputData,
      instruction,
    };
  },
});

/* ============================================================================
 * Step 3：applyInstructionStep
 * ========================================================================== */

/**
 * 4 级匹配 + 6 op 应用（任务卡 §7 MUST DO §2 / §3 / §6）。
 *
 * - matchTargets：按 R-ADJ-002 4 级优先级短路；0 命中 → ADJUSTMENT_SKU_UNMATCHED。
 * - applyAdjustment：6 种 op 全覆盖 + 负数保护 + adjustmentTrace 累加。
 * - 输出 beforeItems（落 log 用）+ afterItems（更新 draft 用）+ affectedSkuIds（log + markdown 用）。
 */
export const applyInstructionStep = createStep({
  id: 'apply-instruction',
  inputSchema: ExtractStepOutputSchema,
  outputSchema: ApplyStepOutputSchema,
  // matchTargets / applyAdjustment 是纯同步函数；createStep 类型签名要求 Promise，
  // 故保留 async 关键字、跳过 require-await 限制。
  // eslint-disable-next-line @typescript-eslint/require-await
  execute: async ({ inputData }) => {
    const items = inputData.items as DraftItem[];
    const instruction = inputData.instruction as AdjustmentInstruction;

    // 4 级匹配（短路，由 matcher.ts 守门）
    const matched = matchTargets({
      items,
      instruction,
      // V1 不传 skuCategoryMap（CATEGORY_CODE 路径来自上游 base data，由切片 18 / 19 接入）
      skuCategoryMap: extractSkuCategoryMap(items),
    });

    if (matched.length === 0) {
      throw new BizError(
        'ADJUSTMENT_SKU_UNMATCHED',
        `没找到匹配商品（${instruction.targetValue}）`,
        {
          meta: {
            draftId: inputData.draftId,
            targetType: instruction.targetType,
            targetValue: instruction.targetValue,
          },
        },
      );
    }

    const adjustedMatched = applyAdjustment({ matched, instruction });
    const affectedSkuIds = adjustedMatched.map((it) => it.skuId);

    // 把 matched 调整结果"按 skuId 替换回原 items"（保持原顺序，仅替换 matched 行）
    const affectedSet = new Set(affectedSkuIds);
    const adjustedById = new Map(
      adjustedMatched.map((it) => [it.skuId, it] as const),
    );
    const afterItems: DraftItem[] = items.map((it) =>
      affectedSet.has(it.skuId) ? (adjustedById.get(it.skuId) ?? it) : it,
    );

    return {
      ...inputData,
      beforeItems: items,
      affectedSkuIds,
      afterItems,
    };
  },
});

/**
 * 从 draft.items 中尝试推导 skuId → categoryCode 映射。
 *
 * V1 数据契约：DraftItem 不含 categoryCode 字段；本函数返回空 Map，
 * 让 matcher 在 CATEGORY_CODE 路径上"无映射 → 0 命中"，由 ADJUSTMENT_SKU_UNMATCHED 兜底。
 *
 * V2：当 base data 把 category 写入 draftItem.adjustmentTrace 之外的扩展字段时，
 * 本函数会被替换为读取真实映射。
 */
function extractSkuCategoryMap(items: ReadonlyArray<DraftItem>): SkuCategoryMap {
  // 类型守护：虽然 DraftItem schema 不含 categoryCode，但上游若以扩展字段注入，
  // 这里能透出（保持向后兼容）。
  const map = new Map<string, string>();
  for (const it of items) {
    const ext = it as DraftItem & { categoryCode?: unknown };
    if (typeof ext.categoryCode === 'string' && ext.categoryCode.length > 0) {
      map.set(it.skuId, ext.categoryCode);
    }
  }
  return map;
}

/* ============================================================================
 * Step 4：persistAdjustmentStep
 * ========================================================================== */

/**
 * 落库 + 写 adjustment_log + 渲染 markdown 影响列表。
 *
 * - 调用 DraftManager.updateItems 把 afterItems 写入 replenishment_draft.items。
 * - 写 replenishment_adjustment_log 一行（任务卡 §7 MUST DO §5）；
 *   含 before / after items + instruction_json + affected_sku_ids。
 * - 渲染 markdown：包含调整摘要 + "## 影响的 SKU" 全列表（任务卡 §7 MUST DO §8）。
 *
 * 注：本切片**不**调用 LLM 再润色 markdown —— 调整影响列表是结构化数据 + 模板拼接，
 * 直接由 calculator 风格的纯函数生成，避免数字漂移与重试成本。
 */
export const persistAdjustmentStep = createStep({
  id: 'persist-adjustment',
  inputSchema: ApplyStepOutputSchema,
  outputSchema: AdjustmentOutputSchema,
  execute: async ({ inputData, requestContext }) => {
    const ctx = requestContext as unknown as RuntimeContext<AgentRuntime>;
    const instruction = inputData.instruction as AdjustmentInstruction;
    const beforeItems = inputData.beforeItems as DraftItem[];
    const afterItems = inputData.afterItems as DraftItem[];

    // 1) 更新 draft.items（任务卡 §7 MUST DO §7 / §9 步骤 10）
    const affectedRows = await draftManager.updateItems({
      draftId: inputData.draftId,
      items: afterItems,
      runtimeContext: ctx,
    });
    if (affectedRows === 0) {
      // 短窗口被并发抢 / 已变终态：抛 DRAFT_NOT_FOUND（避免 log 与 items 不一致）
      throw new BizError('DRAFT_NOT_FOUND', '草稿不可调整：可能已过期 / 已提交 / 已取消', {
        meta: { draftId: inputData.draftId },
      });
    }

    // 2) 写 adjustment_log 一行（任务卡 §7 MUST DO §5）
    await writeAdjustmentLog({
      instruction,
      beforeItems,
      afterItems,
      affectedSkuIds: inputData.affectedSkuIds,
    });

    // 3) 渲染影响列表 markdown（任务卡 §7 MUST DO §8 / §9 步骤 11）
    const summaryMarkdown = renderAdjustmentMarkdown({
      instruction,
      beforeItems,
      afterItems,
      affectedSkuIds: inputData.affectedSkuIds,
      remaining: inputData.maxAdjustmentsPerDraft - inputData.currentAdjustmentCount - 1,
    });

    return {
      draftId: inputData.draftId,
      status: inputData.status,
      adjustmentId: instruction.adjustmentId,
      affectedSkuIds: inputData.affectedSkuIds,
      affectedCount: inputData.affectedSkuIds.length,
      remainingAdjustments: Math.max(
        0,
        inputData.maxAdjustmentsPerDraft - inputData.currentAdjustmentCount - 1,
      ),
      summaryMarkdown,
      items: afterItems.map((it) => ({
        skuId: it.skuId,
        skuName: it.skuName,
        unit: it.unit,
        baseSuggestQty: it.baseSuggestQty,
        finalSuggestQty: it.finalSuggestQty,
        reason: it.reason,
        adjustmentTrace: it.adjustmentTrace ?? [],
      })),
    };
  },
});

/* ============================================================================
 * Markdown 渲染（任务卡 §7 MUST DO §8 / §9 步骤 11 / §10 测试场景 13）
 * ========================================================================== */

/**
 * 渲染调整 markdown：包含本次调整摘要 + 影响 SKU 全列表（不省略）。
 *
 * 关键设计：
 *   - "## 影响的 SKU" 小节必须列出全部 matched.length 个 SKU（任务卡 §10.13 50 SKU 不省略）。
 *   - 每行展示 skuId / skuName / 调整前 → 调整后 / reason；不需要 LLM 润色。
 *   - markdown 只读取 calculator 算好的数字（finalSuggestQty 在 afterItems 中），
 *     不构造任何 LLM-only 派生数字（避免数字一致性争议）。
 *
 * @returns 中文 markdown 字符串（含 ## 影响的 SKU 小节）
 */
export function renderAdjustmentMarkdown(args: {
  instruction: AdjustmentInstruction;
  beforeItems: ReadonlyArray<DraftItem>;
  afterItems: ReadonlyArray<DraftItem>;
  affectedSkuIds: ReadonlyArray<string>;
  remaining: number;
}): string {
  const ins = args.instruction;
  const beforeById = new Map(args.beforeItems.map((it) => [it.skuId, it] as const));
  const afterById = new Map(args.afterItems.map((it) => [it.skuId, it] as const));

  const opLabel = describeOp(ins);

  const headerLines = [
    `# 补货调整结果`,
    ``,
    `- 草稿 ID：${ins.draftId}`,
    `- 调整指令：${opLabel}`,
    `- 影响 SKU 数：${args.affectedSkuIds.length}`,
    `- 剩余可调整次数：${Math.max(0, args.remaining)}`,
    ``,
    `## 影响的 SKU`,
    ``,
    `| SKU | 名称 | 单位 | 调整前 | 调整后 | reason |`,
    `| --- | --- | --- | ---: | ---: | --- |`,
  ];

  const tableLines = args.affectedSkuIds.map((skuId) => {
    const before = beforeById.get(skuId);
    const after = afterById.get(skuId);
    const beforeQty = before?.finalSuggestQty ?? 0;
    const afterQty = after?.finalSuggestQty ?? 0;
    const name = after?.skuName ?? before?.skuName ?? '';
    const unit = after?.unit ?? before?.unit ?? '';
    const reason = (after?.reason ?? before?.reason ?? '').replace(/\|/g, '\\|');
    return `| ${skuId} | ${name} | ${unit} | ${beforeQty} | ${afterQty} | ${reason} |`;
  });

  return [...headerLines, ...tableLines, ''].join('\n');
}

/**
 * 把 instruction 转成中文调整描述句。
 */
function describeOp(ins: AdjustmentInstruction): string {
  const target = ins.targetType === 'ALL' ? '全部 SKU' : `${ins.targetType}=${ins.targetValue}`;
  switch (ins.adjustmentType) {
    case 'INCREASE_RATE':
      return `${target} 上调 ${formatPercent(ins.adjustmentRate)}`;
    case 'DECREASE_RATE':
      return `${target} 下调 ${formatPercent(ins.adjustmentRate)}`;
    case 'INCREASE_QTY':
      return `${target} 增加 ${ins.adjustmentQty ?? 0}`;
    case 'DECREASE_QTY':
      return `${target} 减少 ${ins.adjustmentQty ?? 0}`;
    case 'SET_QTY':
      return `${target} 设置为 ${ins.adjustmentQty ?? 0}`;
    case 'EXCLUDE':
      return `${target} 排除（设为 0）`;
    /* c8 ignore next 2 */
    default:
      return `${target} ${String(ins.adjustmentType)}`;
  }
}

function formatPercent(rate: number | undefined): string {
  if (rate === undefined || !Number.isFinite(rate)) return '0%';
  return `${Math.round(rate * 100)}%`;
}

/* ============================================================================
 * Workflow
 * ========================================================================== */

/**
 * 补货调整 Workflow（replenishment_adjustment）。
 *
 * 注册路径：mastra/workflows/index.ts barrel；切片 21 在 agent_skill_def 表插入对应 skillCode。
 */
export const replenishmentAdjustment = createWorkflow({
  id: 'replenishment_adjustment',
  inputSchema: AdjustmentInputSchema,
  outputSchema: AdjustmentOutputSchema,
})
  .then(loadActiveDraftStep)
  .then(extractInstructionStep)
  .then(applyInstructionStep)
  .then(persistAdjustmentStep)
  .commit();

/* ============================================================================
 * 内部 helper
 * ========================================================================== */

function getRuntimeString(
  ctx: RuntimeContext<AgentRuntime>,
  key: 'merchantId' | 'storeId' | 'sessionId' | 'userId' | 'traceId',
): string {
  const value = ctx.get(key);
  if (typeof value !== 'string' || value.length === 0) {
    throw new BizError('INTERNAL_ERROR', `RuntimeContext 缺少 ${key}`);
  }
  return value;
}

/** 仅供单测桥接 */
export const __test_only__ = {
  countAdjustmentLogs,
  writeAdjustmentLog,
  loadActiveDraftId,
  locateDraft,
  renderAdjustmentMarkdown,
  describeOp,
};
