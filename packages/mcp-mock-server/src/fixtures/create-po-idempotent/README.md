# Fixture profile: `create-po-idempotent`

**触发场景**:`createPurchaseOrder` 重复确认幂等回归路径。

**用于验证**:
- 切片 17(purchase-order-create-hitl)幂等性:相同 `idempotencyKey` 调 N 次 → 返回相同 `purchaseOrderNo`
- 切片 13(draft-manager)`assertDraftTransitAllowed` + 重复确认幂等

**预期错误码**:无(幂等是成功路径,不抛错)。

**覆写工具**:无(`createPurchaseOrder` 由 `idempotencyStore` 内存 Map 控制,所有 profile 共用)。

**注**:此 profile 保留为目录占位,用于 fixture 切换冒烟与运维 runbook 引用。
