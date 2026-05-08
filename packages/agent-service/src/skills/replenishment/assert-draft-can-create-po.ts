/**
 * 切片 17 — 采购单创建 8 项前置校验（assertDraftCanCreatePo）
 *
 * 严格按 docs/tanks/17-skill-purchase-order-create-hitl.md §7 / §8.2 + 本体 §12.2 落地。
 *
 * 8 项前置校验（与任务卡 §7 MUST DO §3 一一对应）：
 *   1. draftId 存在 — 由 DraftManager.getByIdStrict 已保证（本函数不再校验）。
 *   2. tenant 一致 — 外层调用方（ConfirmManager / Workflow runtimeContext）保证。
 *   3. status ∈ {WAIT_CONFIRM, CONFIRMED} — 不能 DRAFT 状态直接走采购单创建。
 *   4. items 非空 — 没有明细的草稿不允许创建采购单。
 *   5. 全部 finalSuggestQty >= 0 — 数量必须合法（DraftItem schema 已 nonnegative，但二次守门）。
 *   6. submittedPoNo IS NULL — 已存在采购单 → DRAFT_ALREADY_SUBMITTED（防重复提单）。
 *   7. 草稿未过期 — status !== EXPIRED 且 expiresAt > NOW（防过期草稿误提单）。
 *   8. 用户输入含明确确认语义 — 由外层 IntentRouter 校验（CONFIRM_CREATE_PURCHASE_ORDER）。
 *
 * 强约束（违反即拒收）：
 *   - 本函数必须为**纯同步函数**（无 IO，不依赖 DB / LLM / MCP）；便于 createPoStep 内
 *     做"再次校验（防 race）"时无 IO 成本。
 *   - 任意校验失败必须抛 BizError；ErrorCode 复用切片 04 已有的 27 项，不新增。
 *   - 校验顺序与本体 §12.2 一致（不允许跳序，确保错误码语义清晰）。
 *
 * 引用：
 *   - 任务卡 docs/tanks/17-skill-purchase-order-create-hitl.md §7 / §8.2
 *   - E-Skill.md §T-SKILL-05.5.2（8 项校验全文）
 *   - 切片 04（ErrorCode 27 项 + BizError）
 *   - 切片 13（DraftView / DraftStatus）
 *
 * @since 2026-05-07（切片 17 落地）
 */
import { BizError, type DraftStatus } from '@storepilot/shared-contracts';

import type { DraftView } from '../../safety/draft-manager.js';

/**
 * 允许进入采购单创建流程的草稿状态集合。
 *
 * - WAIT_CONFIRM：补货预测产出后等待老板确认。
 * - CONFIRMED：老板已确认（V1 与 WAIT_CONFIRM 实质等价；保留是为了未来扩展点）。
 *
 * **不允许**：
 *   - DRAFT：未触发"老板可见"流程；直接走采购单创建会绕过 HITL。
 *   - SUBMITTED / EXPIRED / CANCELLED / FAILED：终态，不可再创建采购单。
 */
const ALLOWED_STATUSES: ReadonlySet<DraftStatus> = new Set<DraftStatus>([
  'WAIT_CONFIRM',
  'CONFIRMED',
]);

/**
 * 8 项前置校验（纯同步函数）。
 *
 * 调用约定：
 *   - **previewStep** 内首次调用：保证用户看到的 preview 是基于合法草稿生成。
 *   - **createPoStep** 内再次调用：防止 askConfirm 期间被并发流转 / 过期（race 守门）。
 *
 * 错误码映射：
 *   - 校验 3 / 4：DRAFT_NOT_FOUND（草稿状态非法 / 明细为空 — 视为"无可用草稿"）。
 *   - 校验 5：SCHEMA_FAIL（数量非法，理论上 DraftItem schema 已守门，二次防线）。
 *   - 校验 6：DRAFT_ALREADY_SUBMITTED（已存在 PO 号）。
 *   - 校验 7：DRAFT_EXPIRED（状态 EXPIRED 或 expiresAt 已过）。
 *
 * @param draft 待校验的草稿视图（来自 DraftManager.getByIdStrict）
 * @throws BizError DRAFT_NOT_FOUND / SCHEMA_FAIL / DRAFT_ALREADY_SUBMITTED / DRAFT_EXPIRED
 */
export function assertDraftCanCreatePo(draft: DraftView): void {
  // 校验 6（提前）：SUBMITTED 终态 + 已有 PO 号 → 优先抛 DRAFT_ALREADY_SUBMITTED。
  // 任务卡 §8.2 示例按 3→6 的顺序，但 SUBMITTED 同时违反 §3 与 §6；
  // 选 §6 错误码作为优先返回（与切片 15 SUBMITTED → DRAFT_ALREADY_SUBMITTED 的 UX 语义一致），
  // 让"重复确认"场景命中精确文案"采购单 PO_xxx 已存在"。
  if (draft.status === 'SUBMITTED') {
    throw new BizError(
      'DRAFT_ALREADY_SUBMITTED',
      `采购单 ${draft.submittedPoNo ?? '已存在'} 已存在`,
      { meta: { draftId: draft.draftId, submittedPoNo: draft.submittedPoNo } },
    );
  }

  // 校验 7a：EXPIRED 是明确过期状态，应保留 DRAFT_EXPIRED 语义，不能被非法状态兜底吞掉。
  if (draft.status === 'EXPIRED') {
    throw new BizError('DRAFT_EXPIRED', '草稿已过期（状态 EXPIRED）', {
      meta: { draftId: draft.draftId },
    });
  }

  // 校验 3：status ∈ {WAIT_CONFIRM, CONFIRMED}
  // 走到这里只剩 DRAFT / CANCELLED / FAILED → 视为"无可用草稿"
  if (!ALLOWED_STATUSES.has(draft.status)) {
    throw new BizError('DRAFT_NOT_FOUND', `草稿状态非法：${draft.status}`, {
      meta: { draftId: draft.draftId, status: draft.status },
    });
  }

  // 校验 4：items 非空
  if (draft.items.length === 0) {
    throw new BizError('DRAFT_NOT_FOUND', '草稿明细为空，无法创建采购单', {
      meta: { draftId: draft.draftId },
    });
  }

  // 校验 5：finalSuggestQty 必须非负（每一行）
  const negative = draft.items.find((it) => it.finalSuggestQty < 0);
  if (negative) {
    throw new BizError('SCHEMA_FAIL', '存在非法数量（finalSuggestQty < 0）', {
      meta: {
        draftId: draft.draftId,
        skuId: negative.skuId,
        finalSuggestQty: negative.finalSuggestQty,
      },
    });
  }

  // 校验 6：submittedPoNo 必须为空（防重复创建）
  if (draft.submittedPoNo) {
    throw new BizError(
      'DRAFT_ALREADY_SUBMITTED',
      `采购单 ${draft.submittedPoNo} 已存在`,
      { meta: { draftId: draft.draftId, submittedPoNo: draft.submittedPoNo } },
    );
  }

  // 校验 7b：草稿未过期
  // expiresAt 是 ISO 字符串；Date 解析失败时 getTime() 返回 NaN，比较恒为 false → 视为已过期
  const expiresAtMs = new Date(draft.expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new BizError('DRAFT_EXPIRED', '草稿已过期（expires_at 已过）', {
      meta: { draftId: draft.draftId, expiresAt: draft.expiresAt },
    });
  }
  // 校验 1 / 2 / 8：由外层调用方保证（getByIdStrict 跨租户硬隔离 + IntentRouter 守门）。
}
