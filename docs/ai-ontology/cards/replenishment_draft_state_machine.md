---
generated_at: 2026-05-08
source_basis: storePilotAI.zip + storePilotAI_ontology_docs.zip
project: storepilot-ai
---

# Card: ReplenishmentDraft State Machine

读这个卡片，当任务涉及：`replenishment_draft`、DraftManager、补货预测、补货调整、过期、取消、提交。

## 状态集合

`DRAFT`、`WAIT_CONFIRM`、`CONFIRMED`、`SUBMITTED`、`EXPIRED`、`CANCELLED`、`FAILED`

## 允许流转

```text
DRAFT -> WAIT_CONFIRM | CANCELLED | EXPIRED
WAIT_CONFIRM -> CONFIRMED | CANCELLED | EXPIRED
CONFIRMED -> SUBMITTED | FAILED | CANCELLED
终态：SUBMITTED / FAILED / CANCELLED / EXPIRED
```

## 编码要点

- 不要直接 SQL 改 status，优先走 DraftManager 语义。
- 查询草稿必须带 tenant 条件。
- 调整草稿要写 adjustment log，包括 before/after 和 instruction_json。
- 创建 PO 前必须 reread draft，避免确认期间草稿变更。
- 过期草稿不能复活成可提交草稿。
