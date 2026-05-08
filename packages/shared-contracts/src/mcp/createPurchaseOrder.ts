/**
 * 切片 05 — createPurchaseOrder(SSOT,唯一写工具,HIGH 风险)
 * 严格按 docs/任务卡/B-契约.md §T-SCHEMA-02.5.2 落地。
 *
 * 强约束(切片 05 §7 + R-PO-002):
 *   - input.refine(idempotencyKey === sourceDraftId)
 *   - source = z.literal('AI_REPLENISHMENT_AGENT')(防止人工/其它系统冒名)
 *   - quantity = int().nonnegative()
 *   - purchaseOrderNo 正则 ^PO[_-][A-Za-z0-9]{6,32}$
 */
import { z } from 'zod';

export const PurchaseOrderItem = z.object({
  skuId: z.string().min(1),
  quantity: z.number().int().nonnegative(),
  unit: z.string().min(1),
  reason: z.string().max(200),
});

export type PurchaseOrderItem = z.infer<typeof PurchaseOrderItem>;

export const PurchaseOrderResult = z.object({
  success: z.literal(true),
  purchaseOrderNo: z.string().regex(/^PO[_-][A-Za-z0-9]{6,32}$/, 'PO 号必须 PO_xxx 或 PO-xxx'),
  createdAt: z.string().datetime({ offset: true }),
});

export type PurchaseOrderResult = z.infer<typeof PurchaseOrderResult>;

export const createPurchaseOrder = {
  input: z
    .object({
      merchantId: z.string().min(1),
      storeId: z.string().min(1),
      source: z.literal('AI_REPLENISHMENT_AGENT'),
      sourceDraftId: z.string().min(1),
      idempotencyKey: z.string().min(1),
      items: z.array(PurchaseOrderItem).min(1).max(2000),
    })
    .refine((v) => v.idempotencyKey === v.sourceDraftId, {
      message: 'idempotencyKey 必须等于 sourceDraftId(R-PO-002)',
      path: ['idempotencyKey'],
    }),
  output: PurchaseOrderResult,
} as const;
