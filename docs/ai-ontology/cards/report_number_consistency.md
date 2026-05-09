---
generated_at: 2026-05-08
source_basis: storePilotAI.zip + storePilotAI_ontology_docs.zip
project: storepilot-ai
---

# Card: Report Number Consistency

读这个卡片，当任务涉及：日报、月报、指标解释、补货数量、cards、abnormalInsights、source summary。

## 规则

- R-AI-001：不能编造业务数据。
- R-NUM-001：输出数字必须来自允许集或确定性派生。

## 正确来源

| 数字 | 来源 |
| --- | --- |
| 销售额、订单数、客单价 | `queryStoreSalesSummary` |
| 品类占比 | `queryCategorySalesRatio` |
| 商品排行 | `queryProductSalesRank` |
| 库存数量/价值 | `queryInventoryOverview` |
| 补货建议数量 | `queryReplenishmentBaseData` + 确定性计算 + 策略 |
| 调整后数量 | DraftItem + AdjustmentInstruction 确定性应用 |

## 禁止模式

- 让 LLM “估算”缺失销售额。
- 为了文案好看添加不存在的百分比。
- 用 LLM judge 替代确定性数字校验。
