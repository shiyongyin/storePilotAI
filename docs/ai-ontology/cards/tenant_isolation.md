---
generated_at: 2026-05-08
source_basis: storePilotAI.zip + storePilotAI_ontology_docs.zip
project: storepilot-ai
---

# Card: Tenant Isolation

读这个卡片，当任务涉及：merchantId、storeId、userId、session、draft、strategy、API key、MCP headers。

## 核心原则

商家/门店/用户上下文是硬隔离边界。任何业务状态查询、更新、提交，都不能只靠自然语言或未绑定租户的 ID。

## 高风险对象

- `agent_api_key`
- `agent_session`
- `replenishment_draft`
- `replenishment_adjustment_log`
- `agent_merchant_strategy`
- `agent_store_strategy`
- MCP request scope/header

## 禁止模式

```sql
-- 风险：只按 draft_id 更新
UPDATE replenishment_draft SET status='CONFIRMED' WHERE draft_id=?;
```

应确保调用链或 SQL 条件包含 merchant/store/user/session 的验证语义。
