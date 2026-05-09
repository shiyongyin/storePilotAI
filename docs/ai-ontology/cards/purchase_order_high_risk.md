---
generated_at: 2026-05-08
source_basis: storePilotAI.zip + storePilotAI_ontology_docs.zip
project: storepilot-ai
---

# Card: PurchaseOrder HIGH Risk

读这个卡片，当任务涉及：`createPurchaseOrder`、`purchase_order_create`、`CONFIRM_CREATE_PURCHASE_ORDER`、采购单、确认、取消、HITL。

## 必守规则

- R-AI-002：用户明确确认前不能创建采购单。
- R-AI-003：不能从 Markdown/展示文本反解析采购单明细。
- R-HITL-001：resume 使用互斥锁，防止重复提交。
- R-PO-001：`idempotencyKey === sourceDraftId`，`source=AI_REPLENISHMENT_AGENT`。

## 正确链路

```text
ReplenishmentDraft.items
  -> preview
  -> suspend wait confirm
  -> explicit CONFIRM
  -> reread draft
  -> assertDraftCanCreatePo
  -> WAIT_CONFIRM -> CONFIRMED
  -> createPurchaseOrder
  -> markSubmitted(submitted_po_no)
```

## 禁止改法

- 用户说“可以”就直接拼一个 PO 调 MCP，但没有 active draft。
- 从上一次 markdown 中截取 SKU 和数量。
- 并发确认时没有 lock。
- createPurchaseOrder 成功前把本地 draft 标为 submitted。
- 将 `purchase_order_create` 从 gray 高风险能力直接改成全量 enabled，而没有产品确认和测试。
