/**
 * 切片 17 — 采购单创建 Workflow（purchase_order_create，HITL，HIGH 风险）
 *
 * 严格按 docs/tanks/17-skill-purchase-order-create-hitl.md §7 / §8.1 落地。
 *
 * 3 step：
 *   1. {@link previewStep}    — getByIdStrict + assertDraftCanCreatePo + composePoPreview。
 *   2. {@link askConfirmStep} — HITL 等待用户下一条"确认/取消"消息：
 *      - 第一次进入：`await suspend(inputData)` 让出执行；
 *      - 第二次进入（resumeData 已注入）：CONFIRM → 透传；CANCEL → BizError(USER_CANCELLED)。
 *   3. {@link createPoStep}   — 再次 assertDraftCanCreatePo（防 race）+ 转 CONFIRMED +
 *      `tools.createPurchaseOrder.execute` (idempotencyKey === sourceDraftId === draftId)
 *      + DraftManager.markSubmitted；markSubmitted 失败仅 logger.error，不抛错让补偿 Job 兜底。
 *
 * 强约束（任务卡 §7 MUST DO / MUST NOT，违反即拒收）：
 *   - MUST：HITL 必须 suspend（任务卡 §7 MUST DO §1）。
 *   - MUST：`idempotencyKey === sourceDraftId === draftId`（R-PO-002 / 任务卡 §7 MUST DO §2）。
 *   - MUST：8 项前置校验通过（任务卡 §7 MUST DO §3）+ createPoStep 内**再次校验**（防 race）。
 *   - MUST：从 `draft.items` 结构化取数（R-PO-003 / 任务卡 §7 MUST DO §6）。
 *   - MUST：`resumeData.decision !== 'CONFIRM'` → BizError(USER_CANCELLED)（§7 MUST DO §5）。
 *   - MUST：preview markdown 含 itemCount / totalQty / 影响 SKU 完整列表（§7 MUST DO §7）。
 *   - MUST：markSubmitted 失败仅 logger.error，不抛错（§7 MUST DO §4 + 补偿 Job 兜底）。
 *   - MUST：suspendSchema = PreviewSchema；resumeSchema = `{ decision, reason? }`（§11 自检）。
 *   - MUST NOT：跳过 askConfirmStep 直接 createPo（红线：未确认 = P0 事故）。
 *   - MUST NOT：从预览 markdown 反向解析采购单明细（R-PO-003）。
 *   - MUST NOT：同一 draftId 重复创建采购单（依赖 markSubmitted 幂等 + assert §6 项校验）。
 *   - MUST NOT：createPurchaseOrder 失败时还 markSubmitted（先 ERP 成功才标 SUBMITTED）。
 *   - MUST NOT：askConfirmStep 内做长事务（resume 在事务外，由切片 16 ConfirmManager 锁保护）。
 *
 * 设计决策（与 task card §8.1 对齐 + 状态机补全）：
 *   - 状态转换 `WAIT_CONFIRM → CONFIRMED` 在 createPoStep 内、调用 ERP 之前完成；
 *     ERP 成功但 markSubmitted 失败时，draft 状态 = CONFIRMED + submitted_po_no IS NULL，
 *     正好被补偿 Job（切片 §8.3 + jobs/compensate-mark-submitted.ts）扫到并回填。
 *   - 入参 `draftId` 来自上层 ConfirmManager.confirmDraft / 桥接层；本 workflow 只负责
 *     执行 3 step，不做 sessionId 漂移恢复（切片 16 已托管）。
 *   - `requestContext`（mastra 1.0）= `RuntimeContext<AgentRuntime>`（任务卡概念，见 runtime-context.ts）。
 *
 * 引用：
 *   - 任务卡 docs/tanks/17-skill-purchase-order-create-hitl.md §6 / §7 / §8 / §9
 *   - E-Skill.md §T-SKILL-05.5
 *   - 切片 04（USER_CANCELLED / DRAFT_* / SCHEMA_FAIL）
 *   - 切片 05（createPurchaseOrder 契约 + idempotencyKey refine）
 *   - 切片 06（RuntimeContext / mcpTools）
 *   - 切片 13（DraftManager.getByIdStrict / transit / markSubmitted）
 *   - 切片 16（ConfirmManager.confirmDraft 调用方 / HITL_WORKFLOW_ID = 'purchase_order_create'）
 *
 * @since 2026-05-07（切片 17 落地）
 */
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { BizError } from '@storepilot/shared-contracts';
import {
  PurchaseOrderResult,
  type PurchaseOrderItem,
} from '@storepilot/shared-contracts/mcp';
import { z } from 'zod';

import { logger } from '../../observability/logger.js';
import * as draftManager from '../../safety/draft-manager.js';
import { assertDraftCanCreatePo } from '../../skills/replenishment/assert-draft-can-create-po.js';
import { composePoPreview } from '../../skills/replenishment/compose-po-preview.js';
import { mcpTools } from '../mcp/client.js';
import type { AgentRuntime, RuntimeContext } from '../runtime-context.js';

/* ============================================================================
 * Schema
 * ========================================================================== */

/**
 * Workflow 入参：仅 `draftId`（task card §5 / §8.1）。
 *
 * 其它上下文（merchantId / storeId / userId / sessionId / traceId）从 RuntimeContext 取。
 */
const InputSchema = z.object({
  draftId: z.string().min(1),
});

/**
 * preview 中间产物（→ askConfirm.input/suspend；→ createPo.input）。
 *
 * 严格按任务卡 §8.1：含 draftId / itemCount / totalQty / previewMarkdown。
 */
const PreviewSchema = z.object({
  draftId: z.string().min(1),
  itemCount: z.number().int().nonnegative(),
  totalQty: z.number().int().nonnegative(),
  previewMarkdown: z.string().min(1),
});

/**
 * resume 时由 ConfirmManager 注入的决策载荷（§7 MUST DO §1 + §5）。
 *
 * - `decision`：CONFIRM → 创建 PO；CANCEL → BizError(USER_CANCELLED)。
 * - `reason`：可选，CANCEL 时透传到 BizError.meta.reason，便于审计。
 */
const ResumeSchema = z.object({
  decision: z.enum(['CONFIRM', 'CANCEL']),
  reason: z.string().max(200).optional(),
});

/**
 * Workflow 最终输出：采购单号 + ERP 创建时间。
 *
 * 切片 18 §8.4 一致性单源 — 严禁在 agent-service 重定义 `purchaseOrderNo` schema；
 * 直接复用 shared-contracts/mcp.PurchaseOrderResult 的子集（pick），
 * 与 ERP 工具返回值 1:1，便于断言、便于演化。
 */
const OutputSchema = PurchaseOrderResult.pick({
  purchaseOrderNo: true,
  createdAt: true,
});

export type PurchaseOrderWorkflowOutput = z.infer<typeof OutputSchema>;

/* ============================================================================
 * tools 类型最小适配（与 business-daily-report 同形）
 * ========================================================================== */

/**
 * MCP `createPurchaseOrder` 工具的最小调用形态（非完整 Mastra Tool 接口）。
 *
 * Mastra 1.0 ToolAction.execute(inputData, context?) — inputData 直接展开为
 * shared-contracts/mcp/createPurchaseOrder.input 字段集；`Promise<PurchaseOrderResult>`
 * 与 output schema 对齐。
 */
interface CreatePurchaseOrderTool {
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
 * Step 1：previewStep（getByIdStrict + assert + composePoPreview）
 * ========================================================================== */

/**
 * 渲染采购单 preview。流程：
 *
 *   1. {@link draftManager.getByIdStrict} 跨租户硬隔离读 draft；
 *   2. {@link assertDraftCanCreatePo} 8 项前置校验全部通过；
 *   3. {@link composePoPreview} 输出 itemCount / totalQty / 完整 SKU 列表 markdown。
 *
 * 不在本 step 内修改 draft 状态：preview 只读不写；状态转换在 createPoStep 内做。
 */
export const previewStep = createStep({
  id: 'preview-purchase-order',
  inputSchema: InputSchema,
  outputSchema: PreviewSchema,
  execute: async ({ inputData, requestContext }) => {
    const ctx = requestContext as unknown as RuntimeContext<AgentRuntime>;
    const draft = await draftManager.getByIdStrict(inputData.draftId, ctx);

    // 8 项前置校验（任务卡 §7 MUST DO §3 / §12.2）
    assertDraftCanCreatePo(draft);

    const preview = composePoPreview(draft);
    return {
      draftId: draft.draftId,
      itemCount: preview.itemCount,
      totalQty: preview.totalQty,
      previewMarkdown: preview.markdown,
    };
  },
});

/* ============================================================================
 * Step 2：askConfirmStep（HITL suspend / resume）
 * ========================================================================== */

/**
 * HITL 等待老板"确认/取消"。流程（任务卡 §7 MUST DO §1 + §5）：
 *
 *   - 第一次进入（`resumeData` 缺省）：`await suspend(inputData)` 让出执行；
 *     Mastra runtime 把 inputData 持久化到 mastra_workflow_suspend（切片 07），
 *     直到 ConfirmManager.confirmDraft 通过 `mastra.resume({ resumeData })` 唤醒。
 *   - 第二次进入：
 *       - `decision === 'CONFIRM'` → 透传 inputData 给 createPoStep。
 *       - `decision === 'CANCEL'`  → BizError(USER_CANCELLED)（含 reason meta）。
 *
 * 强约束：
 *   - MUST：suspendSchema = PreviewSchema；resumeSchema = ResumeSchema（任务卡 §11 自检）。
 *   - MUST NOT：在 step 内 await DB / MCP / LLM（resume 内不做事务，事务由 ConfirmManager 守门）。
 */
export const askConfirmStep = createStep({
  id: 'ask-confirm',
  inputSchema: PreviewSchema,
  outputSchema: PreviewSchema,
  suspendSchema: PreviewSchema,
  resumeSchema: ResumeSchema,
  execute: async ({ inputData, suspend, resumeData }) => {
    if (!resumeData) {
      // 第一次进入：suspend 持久化 inputData，等待 ConfirmManager.resume
      await suspend(inputData);
      return inputData;
    }

    if (resumeData.decision !== 'CONFIRM') {
      // 用户取消（resumeSchema 限定 'CONFIRM' | 'CANCEL'，此分支即 CANCEL）
      throw new BizError('USER_CANCELLED', '老板取消创建采购单', {
        meta: { reason: resumeData.reason ?? null, draftId: inputData.draftId },
      });
    }

    return inputData;
  },
});

/* ============================================================================
 * Step 3：createPoStep（race 再校验 + 转 CONFIRMED + ERP + markSubmitted）
 * ========================================================================== */

/**
 * 真正调 ERP 创建采购单 + 标 SUBMITTED。
 *
 * 流程（任务卡 §7 MUST DO §2-§4 / §8.1）：
 *
 *   1. {@link draftManager.getByIdStrict} 重新读取 draft（防 askConfirm 期间被并发流转）。
 *   2. {@link assertDraftCanCreatePo} 再次校验（防 race；纯函数无 IO 成本）。
 *   3. 状态机：若 draft.status === 'WAIT_CONFIRM' → 显式 transit 到 'CONFIRMED'。
 *      - 转 CONFIRMED 后才允许调 ERP；ERP 成功但 markSubmitted 失败时，draft 状态
 *        = CONFIRMED + submitted_po_no IS NULL，正好被补偿 Job 扫到回填。
 *      - 若并发已转完（affectedRows=0），transit 抛 SCHEMA_FAIL；本 step 透出，由上层处理。
 *   4. {@link mcpTools}.createPurchaseOrder.execute：
 *      - `idempotencyKey === sourceDraftId === draftId`（R-PO-002 / 任务卡 §7 MUST DO §2）；
 *      - items 全部从 `draft.items` 结构化取数（R-PO-003 / 任务卡 §7 MUST DO §6）；
 *      - source = 'AI_REPLENISHMENT_AGENT'（schema literal，防止人工冒名）。
 *   5. {@link draftManager.markSubmitted}：CONFIRMED → SUBMITTED + 写 submitted_po_no。
 *      - 失败仅 `logger.error` 不抛错（任务卡 §7 MUST DO §4）；让补偿 Job 兜底。
 *
 * 强约束：
 *   - MUST：从 `draft.items` 取数（R-PO-003）。
 *   - MUST：`idempotencyKey === sourceDraftId === draftId`（R-PO-002，schema 已 refine 双保险）。
 *   - MUST NOT：从预览 markdown 反向解析（grep 守门：本文件 0 命中）。
 *   - MUST NOT：ERP 失败时还 markSubmitted（必须 ERP 成功才标 SUBMITTED）。
 */
export const createPoStep = createStep({
  id: 'create-purchase-order',
  inputSchema: PreviewSchema,
  outputSchema: OutputSchema,
  execute: async ({ inputData, requestContext }) => {
    const ctx = requestContext as unknown as RuntimeContext<AgentRuntime>;

    // 1) 重新读取 + 2) 再次校验（防 askConfirm 期间被并发流转 / 过期）
    const draft = await draftManager.getByIdStrict(inputData.draftId, ctx);
    assertDraftCanCreatePo(draft);

    // 3) 状态机：WAIT_CONFIRM → CONFIRMED（防 markSubmitted 边界 + 补偿 Job 可见）
    if (draft.status === 'WAIT_CONFIRM') {
      await draftManager.transit({
        draftId: draft.draftId,
        from: 'WAIT_CONFIRM',
        to: 'CONFIRMED',
        runtimeContext: ctx,
      });
    }

    // 4) 调 ERP createPurchaseOrder（idempotent）
    const tools = (await mcpTools()) as unknown as PoTools;
    const result = await tools.createPurchaseOrder.execute({
      merchantId: draft.merchantId,
      storeId: draft.storeId,
      source: 'AI_REPLENISHMENT_AGENT',
      sourceDraftId: draft.draftId,
      // R-PO-002：idempotencyKey === sourceDraftId === draftId（schema refine 兜底）
      idempotencyKey: draft.draftId,
      // R-PO-003：从 draft.items 结构化取数（不解析 markdown）
      items: draft.items.map((it) => ({
        skuId: it.skuId,
        quantity: it.finalSuggestQty,
        unit: it.unit,
        reason: it.reason,
      })),
    });

    // 5) markSubmitted（任务卡 §7 MUST DO §4：失败仅 log，不抛错；补偿 Job 兜底）
    try {
      await draftManager.markSubmitted(draft.draftId, result.purchaseOrderNo, ctx);
    } catch (e) {
      logger.error(
        {
          err: e instanceof Error ? e.message : String(e),
          draftId: draft.draftId,
          purchaseOrderNo: result.purchaseOrderNo,
        },
        '[purchase-order-create] markSubmitted failed; compensate job will retry',
      );
      // 不抛错（任务卡 §7 MUST DO §4 + 补偿 Job 兜底）
    }

    return {
      purchaseOrderNo: result.purchaseOrderNo,
      createdAt: result.createdAt,
    };
  },
});

/* ============================================================================
 * Workflow（id === 'purchase_order_create' === HITL_WORKFLOW_ID 切片 16 常量）
 * ========================================================================== */

/**
 * 采购单创建 Workflow（V1 唯一 HITL workflow）。
 *
 * 注册路径：mastra/workflows/index.ts barrel 以 `purchase_order_create` 别名导出，
 * 让 createMastra 的 `workflows: { ...workflows }` 注册键 == HITL_WORKFLOW_ID
 * （切片 16 ConfirmManager 调用 `mastra.getWorkflow('purchase_order_create').resume(...)`）。
 *
 * `id` 字段同时设为 `purchase_order_create`，保证 `getWorkflowById` 也能命中。
 */
export const purchaseOrderCreate = createWorkflow({
  id: 'purchase_order_create',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
})
  .then(previewStep)
  .then(askConfirmStep)
  .then(createPoStep)
  .commit();

/* ============================================================================
 * Test-only exports（仅供单测 / e2e；生产代码不要使用）
 * ========================================================================== */

/**
 * 暴露内部 schema 给单测做断言（不允许在生产路径 import）。
 *
 * @internal
 */
export const __test_only__ = {
  InputSchema,
  PreviewSchema,
  ResumeSchema,
  OutputSchema,
};
