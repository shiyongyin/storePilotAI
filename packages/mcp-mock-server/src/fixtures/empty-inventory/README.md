# Fixture profile: `empty-inventory`

**触发场景**:库存全零 — `queryInventoryOverview.outOfStockSkus = totalSkus`,`queryReplenishmentBaseData.items[*].onHandQty = 0`。

**用于验证**:
- 切片 12 `inventory_overview` 卡片降级:全缺货时输出"全门店缺货,请优先补货"
- 切片 14(replenishment-forecast)零库存边界:数学公式不分母为零(safetyStockDays > 0 兜底)
- 切片 11(OutputValidator)对极端值的兼容性

**预期错误码**:无(零库存是合法状态,不抛错)。

**覆写工具**:`queryInventoryOverview` / `queryReplenishmentBaseData`(其余 fall back 到 happy-path)。
