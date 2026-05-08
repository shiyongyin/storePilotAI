# Fixture profile: `missing-category-ratio`

**触发场景**:`queryCategorySalesRatio` 返回空数组,模拟 ERP 该接口暂无品类数据。

**用于验证**:
- 切片 12 日 / 月报降级:遇到空品类数据时,输出"该指标暂无数据"而非报错
- 切片 11(strategy-validator)的 OutputValidator 对空数组的容忍度

**预期错误码**:无(空数组是合法输出,不抛错)。

**覆写工具**:`queryCategorySalesRatio`(其余 5 个 QUERY 工具 fall back 到 happy-path)。
