/**
 * 切片 15 — 调整指令 LLM 抽取（instruction-extractor.ts）
 *
 * 严格按 docs/tanks/15-skill-replenishment-adjustment.md §6 / §7 落地。
 *
 * 职责：
 *   - 输入：用户原句（"矿泉水上调 20%"）+ 当前 draft 的 SKU 列表上下文
 *   - 输出：经 Zod 校验过的 AdjustmentInstruction（含 adjustmentId / draftId / createdAt）
 *
 * 强约束（与任务卡 §7 一一对应）：
 *   - **MUST：先抽 AdjustmentInstruction 结构化，再修改草稿**（任务卡 §7 MUST DO §1）
 *   - **MUST NOT：让 LLM 直接产出 finalSuggestQty**（任务卡 §7 MUST NOT §1）—— 本文件仅抽取
 *     targetType / adjustmentType / rate / qty；finalSuggestQty 由 matcher.ts 计算。
 *   - 抽取失败（schema 不通过）→ 重试 1 次；再失败抛 BizError(SCHEMA_FAIL) 让上游兜底。
 *   - 抽取产出的 targetType / adjustmentType 必须严格在 4+6 枚举内，否则 Zod 直接拒。
 *
 * 实现要点：
 *   - 用 `generateObject({ model, schema, system, prompt })`（与 compose-markdown.ts 同模式）。
 *   - schema = AdjustmentInstruction 的"LLM 抽取子集"（不含 adjustmentId / draftId / createdAt
 *     —— 这些由本文件包装时填入，避免 LLM 把 draftId 写错）。
 *
 * 引用：
 *   - 任务卡 docs/tanks/15-skill-replenishment-adjustment.md §6 / §7
 *   - shared-contracts/drafts.ts（AdjustmentInstruction SSOT — 4 + 6 枚举 / rate -1..5 / qty 整数）
 *   - prompts/adjustment-extractor.prompt.ts（system prompt 全文）
 *
 * @since 2026-05-07（切片 15 落地）
 */
import { generateObject } from 'ai';
import { ulid } from 'ulid';
import { z } from 'zod';

import {
  AdjustmentInstruction,
  AdjustmentOpType,
  AdjustmentTargetType,
  BizError,
} from '@storepilot/shared-contracts';

import { getEnv } from '../../config/env.js';
import { getModel } from '../../mastra/llm-provider.js';
import { logger } from '../../observability/logger.js';
import {
  type AdjustmentExtractorPromptInput,
  adjustmentExtractorPrompt,
} from '../../prompts/adjustment-extractor.prompt.js';

/* ============================================================================
 * 1) LLM 抽取子集 schema（不含 adjustmentId / draftId / createdAt）
 * ========================================================================== */

/**
 * LLM 直接抽取的"指令核心"。
 *
 * 与 shared-contracts.AdjustmentInstruction 区别：
 *   - 不包含 adjustmentId / draftId / createdAt（由 extractAdjustmentInstruction 填入）。
 *   - userMessage 由调用方注入（避免 LLM 复读时漂字）。
 *   - rate / qty 用 nullable（LLM 输出 null 而非 omit），便于 generateObject 稳定。
 */
const ExtractedInstructionCore = z.object({
  targetType: AdjustmentTargetType,
  targetValue: z.string().max(256).default(''),
  adjustmentType: AdjustmentOpType,
  adjustmentRate: z.number().min(-1).max(5).nullable().optional(),
  adjustmentQty: z.number().int().nullable().optional(),
  reason: z.string().min(1).max(500),
});

export type ExtractedInstructionCore = z.infer<typeof ExtractedInstructionCore>;

/* ============================================================================
 * 2) 公共入参
 * ========================================================================== */

/**
 * extractAdjustmentInstruction 入参。
 *
 * - `userMessage`：老板原句（中文）；写入最终 AdjustmentInstruction.userMessage。
 * - `draftId`：必须传入；写入最终 AdjustmentInstruction.draftId（不让 LLM 编造）。
 * - `draftItemNames`：当前 draft 的 SKU 展示行（"SKU001 矿泉水 550ml"），上限 50 行。
 * - `candidateCategories`：可选品类列表，帮助 LLM 选 CATEGORY_CODE。
 * - `now`：可注入的"当前时间"（默认 `new Date().toISOString()`，便于测试用固定时间）。
 * - `idGenerator`：可注入的 adjustmentId 生成器（默认 `'adj_' + ulid()`）。
 */
export interface ExtractAdjustmentInstructionArgs {
  userMessage: string;
  draftId: string;
  draftItemNames: ReadonlyArray<string>;
  candidateCategories?: ReadonlyArray<string>;
  now?: () => string;
  idGenerator?: () => string;
}

/* ============================================================================
 * 3) 主入口
 * ========================================================================== */

/**
 * 抽取 AdjustmentInstruction（LLM + Zod，重试 1 次）。
 *
 * 流程：
 *   1. 用 adjustmentExtractorPrompt 渲染 system prompt（含 4+6 枚举 + 6 种 op 映射）。
 *   2. generateObject({ schema=ExtractedInstructionCore, system, prompt }) → 结构化 JSON。
 *   3. Zod parse 一次（内部 generateObject 已 parse；此层保险）；失败抛错走重试。
 *   4. 失败时 retry=true 再跑一次；仍失败 → BizError(SCHEMA_FAIL)。
 *   5. 成功 → 包装为完整 AdjustmentInstruction（填入 adjustmentId / draftId / userMessage / createdAt）。
 *
 * @returns 经 AdjustmentInstruction.parse 校验的结构化指令
 * @throws BizError(SCHEMA_FAIL) 当重试后仍解析失败
 */
export async function extractAdjustmentInstruction(
  args: ExtractAdjustmentInstructionArgs,
): Promise<AdjustmentInstruction> {
  const promptInput: AdjustmentExtractorPromptInput = {
    userMessage: args.userMessage,
    draftId: args.draftId,
    draftItemNames: args.draftItemNames.slice(0, 50),
  };
  if (args.candidateCategories !== undefined) {
    promptInput.candidateCategories = args.candidateCategories.slice(0, 30);
  }

  let core: ExtractedInstructionCore;
  try {
    core = await runExtraction({ promptInput });
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        draftId: args.draftId,
      },
      '[replenishment_adjustment] instruction extract first attempt failed, retry once',
    );
    try {
      core = await runExtraction({ promptInput: { ...promptInput, retry: true } });
    } catch (err2) {
      throw new BizError(
        'SCHEMA_FAIL',
        '调整指令抽取失败：LLM 输出未通过 schema 校验',
        {
          meta: {
            draftId: args.draftId,
            err: err2 instanceof Error ? err2.message : String(err2),
          },
        },
      );
    }
  }

  return assembleAdjustmentInstruction({
    core,
    args,
  });
}

/* ============================================================================
 * 4) 内部 helper
 * ========================================================================== */

/**
 * 单次 LLM 调用 + parse。失败抛原生 ZodError / generateObject 错误。
 */
async function runExtraction(args: {
  promptInput: AdjustmentExtractorPromptInput;
}): Promise<ExtractedInstructionCore> {
  const env = getEnv();
  const result = await generateObject({
    model: getModel(),
    schema: ExtractedInstructionCore,
    system: adjustmentExtractorPrompt(args.promptInput),
    prompt: `task=adjustment_extract\n\nuser_message:\n${JSON.stringify(args.promptInput.userMessage)}`,
    maxOutputTokens: env.MAX_OUTPUT_TOKENS,
    // DeepSeek / 通义 / 自建网关不支持 OpenAI structured outputs；走 JSON mode + zod parse 兜底。
    providerOptions: { openai: { structuredOutputs: false } },
  });
  // generateObject 已基于 schema parse；这里再 parse 一遍便于"上层捕获 ZodError 走重试"
  return ExtractedInstructionCore.parse(result.object);
}

/**
 * 把 LLM 抽出的核心字段补齐为完整 AdjustmentInstruction（含 adjustmentId / draftId / createdAt / userMessage）。
 *
 * 关键决策：
 *   - **adjustmentId 不让 LLM 生成**（LLM 编造 ID 会破坏审计）；本文件用 `'adj_' + ulid()`，
 *     与 confirm-manager / draft-manager 的 ULID 风格一致。
 *   - **draftId 不让 LLM 生成**（LLM 可能写错；调用方传入的 draftId 是来自 active_draft_id 或 findRecentDraft）。
 *   - **userMessage 不让 LLM 复述**（LLM 可能漏字；直接透传调用方原句）。
 *   - **createdAt 用 ISO 8601 with offset**（与 ReplenishmentDraft.createdAt / DraftItem schema 一致）。
 */
export function assembleAdjustmentInstruction(args: {
  core: ExtractedInstructionCore;
  args: ExtractAdjustmentInstructionArgs;
}): AdjustmentInstruction {
  const idGen = args.args.idGenerator ?? defaultIdGenerator;
  const nowFn = args.args.now ?? defaultNow;

  // EXCLUDE / *_QTY / *_RATE 字段语义校正（让最终结构化对象更可控）：
  const adjustmentRate = normalizeRate(args.core);
  const adjustmentQty = normalizeQty(args.core);

  const candidate = {
    adjustmentId: idGen(),
    draftId: args.args.draftId,
    userMessage: args.args.userMessage,
    targetType: args.core.targetType,
    // ALL / EXCLUDE 时允许空 targetValue；其它路径必须非空字符串
    targetValue: args.core.targetValue ?? '',
    adjustmentType: args.core.adjustmentType,
    ...(adjustmentRate !== undefined ? { adjustmentRate } : {}),
    ...(adjustmentQty !== undefined ? { adjustmentQty } : {}),
    reason: args.core.reason,
    createdAt: nowFn(),
  };

  // 最终用 shared-contracts 的 AdjustmentInstruction 严格 parse 一次
  return AdjustmentInstruction.parse(candidate);
}

/**
 * 默认 adjustmentId 生成器（`adj_` 前缀 + ulid 小写化）。
 *
 * shared-contracts.AdjustmentInstruction.adjustmentId 没有正则约束，
 * 但保持与 draftId / runId 的命名风格一致便于排查。
 */
function defaultIdGenerator(): string {
  return `adj_${ulid().toLowerCase()}`;
}

/**
 * 默认时间戳：ISO 8601 + 时区偏移（new Date().toISOString() 是 +00:00 形态，符合 datetime({offset:true}) ）。
 */
function defaultNow(): string {
  return new Date().toISOString();
}

/**
 * 规范化 adjustmentRate：
 *   - 仅 INCREASE_RATE / DECREASE_RATE 保留 rate；其它 op 一律 undefined（避免无意义字段）。
 *   - LLM 输出 null → undefined。
 *   - LLM 输出 0 → 保留（0 表示"不变"，但 schema 允许）。
 */
function normalizeRate(core: ExtractedInstructionCore): number | undefined {
  if (core.adjustmentType !== 'INCREASE_RATE' && core.adjustmentType !== 'DECREASE_RATE') {
    return undefined;
  }
  const v = core.adjustmentRate;
  if (v === undefined || v === null) return undefined;
  return v;
}

/**
 * 规范化 adjustmentQty：
 *   - INCREASE_QTY / DECREASE_QTY / SET_QTY 保留 qty；其它一律 undefined。
 *   - LLM 输出 null → undefined。
 */
function normalizeQty(core: ExtractedInstructionCore): number | undefined {
  if (
    core.adjustmentType !== 'INCREASE_QTY' &&
    core.adjustmentType !== 'DECREASE_QTY' &&
    core.adjustmentType !== 'SET_QTY'
  ) {
    return undefined;
  }
  const v = core.adjustmentQty;
  if (v === undefined || v === null) return undefined;
  return v;
}

/** 仅供单测桥接（暴露 schema / helper 给 instruction-extractor.test.ts） */
export const __test_only__ = {
  ExtractedInstructionCore,
  assembleAdjustmentInstruction,
  normalizeRate,
  normalizeQty,
};
