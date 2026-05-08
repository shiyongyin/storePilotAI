# Fixture profile: `cross-tenant-denied`

**触发场景**:多租户隔离 — 商家 A 调用商家 B 的 storeId fixture → Mock 抛错。

**白名单**:`merchantId='M001'` AND `storeId='S001'`,其余组合一律拒绝。

**用于验证**:
- 切片 09(bridge-auth-session)+ 切片 17(purchase-order-create)防跨租户写
- 切片 18 / 19 跨租户隔离 E2E
- 切片 13(draft-manager)`getByIdStrict` 必须带 `merchantId + storeId` WHERE 条件

**预期错误码**:`UNAUTHORIZED`(Mock 在 tool execute 内抛 Error,经 MCP 协议作 tool error 返回;agent-service 侧由 BizError 包装)。

**覆写工具**:全部 6 QUERY(在调用前断言 tenant scope;`createPurchaseOrder` 在 mcp-server 外层先 zod parse,跨租户由 idempotencyKey + draft 流转保护)。
