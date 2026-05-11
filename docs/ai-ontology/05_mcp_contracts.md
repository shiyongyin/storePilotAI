---
generated_at: 2026-05-11
source_basis: storePilotAI.zip + storePilotAI_ontology_docs.zip + V2 marketing phase 2
project: storepilot-ai
---

# 05. MCP Contracts — 工具与契约本体

## 1. MCP 是 ERP / 营销数据能力边界

本项目通过 **16 个 MCP 工具（V1 7 + V2 marketing 9）** 访问 ERP/经营/营销数据能力。

- **类型分布**：15 个 QUERY/LOW（只读）+ 1 个 WRITE/HIGH（`createPurchaseOrder`）。
- **不变量**：`TOOL_NAMES.length === 16`，字典序排序；工具名、输入输出 schema、mock、client 白名单、`agent_skill_def.required_tools` 必须保持同步；任意漂移在启动期 `verifyMcpToolsAtStartup` fail-fast。

## 2. 工具清单

### 2.1 V1 经营/补货工具（7 个，命名 camelCase）

| Tool | 类型 | 风险 | 语义 | 主要调用方 |
| --- | --- | --- | --- | --- |
| `getStoreReportConfig` | QUERY | LOW | 门店报表配置：currency/locale/cards/timezone。 | 日报 |
| `queryStoreSalesSummary` | QUERY | LOW | 销售额、订单数、客单价等经营汇总。 | 日报、月报 |
| `queryCategorySalesRatio` | QUERY | LOW | 品类销售占比，ratio 0..1。 | 日报、月报 |
| `queryProductSalesRank` | QUERY | LOW | 商品排行，topN 1..500。 | 日报、月报 |
| `queryInventoryOverview` | QUERY | LOW | 库存概览、低库存、缺货、库存价值。 | 日报、月报 |
| `queryReplenishmentBaseData` | QUERY | LOW | SKU、库存、销量、在途、lead time、供应商。 | 补货预测 |
| `createPurchaseOrder` | WRITE | HIGH | 创建 ERP 采购单。 | 采购单创建 HITL |

### 2.2 V2 marketing 工具（9 个，命名 snake_case）

所有 V2 工具均为 **QUERY/LOW（只读）**，被 `marketingGrowthCopilot` 通过 `MARKETING_GROWTH_TOOLS` 严格白名单使用；调用上限 `maxSteps=8`。

| Tool | 分组 | 主要返回 | US 场景 |
| --- | --- | --- | --- |
| `query_member_profile` | 会员 | `MemberSummary` + 积分 + 储值 + 券摘要（按 memberId 或 phoneMasked 查） | US-005 / US-007 |
| `query_member_consumption_history` | 会员 | `MemberConsumptionOrder[]`（≤500） + `frequentSkuIds`（≤20） | US-004 / US-008 |
| `query_member_segments` | 会员 | `MemberSegment[]`（≤200，12 个 segmentCode） | US-003 / US-005 / US-006 / US-007 |
| `query_repurchase_cycle` | 会员 | `avgRepurchaseDays / daysSinceLastPurchase / confidence / sampleSize` | US-004 |
| `query_product_performance` | 商品 | `SkuPerformance[]`（≤200，含毛利率/趋势/库存状态） | US-008 / US-009 |
| `query_inventory_status` | 商品 | `InventorySnapshot[]`（≤200，含 `slowMovingFlag` / `stockAgeDays`） | US-009 / US-010 |
| `query_pos_summary_by_time` | POS | `PosTimeBucket[]`（≤366，HOUR/DAY，含会员/散客订单数拆分） | US-008（低峰）/ 未来 US-011 |
| `query_campaign_history` | 活动 | `CampaignHistoryItem[]`（≤100，含 `resultSummary` / 毛利率） | 未来 US-013/US-018 |
| `query_coupon_inventory` | 券 | `CouponInventoryItem[]`（≤200） + 总览（unused / expiringIn7d） | US-007 |

> 任何修改 marketing 工具都要同步：`shared-contracts/src/mcp/marketing.ts` → `mcp/index.ts` TOOL_NAMES → mock fixtures/handlers → `MCPClient` 白名单 → `marketing-growth-copilot.ts` 的 `MARKETING_GROWTH_TOOLS` → `agent_skill_def.required_tools`（migration 018 seed）→ scope classifier 候选与样例 → L2/L3/L4 evals。

## 3. 契约 SSOT

| 内容 | 事实来源 |
| --- | --- |
| V1 tool schema | `packages/shared-contracts/src/mcp/*.ts` |
| V2 marketing tool schema | `packages/shared-contracts/src/mcp/marketing.ts`（含 `MARKETING_GROWTH_TOOLS / MarketingToolContracts`） |
| Tool name list | `packages/shared-contracts/src/mcp/index.ts` 的 `TOOL_NAMES`（length === 16） |
| agent client 白名单 | `packages/agent-service/src/mastra/mcp/client.ts` |
| marketing agent 工具白名单 | `packages/agent-service/src/mastra/agents/marketing-growth-copilot.ts` 的 `MARKETING_GROWTH_TOOLS` + `buildMarketingToolsForRuntime`（注入 tenant、隐藏 tenant 字段） |
| mock 实现 | `packages/mcp-mock-server/src/mcp-server.ts` + `handlers/query-*.ts` + `fixtures/marketing-shoe-store/**` |
| SkillDef 权限 | `agent_skill_def.required_tools` seed（V1: migration 011；V2: migration 018） |

## 4. createPurchaseOrder 高风险规则

`createPurchaseOrder` 不是普通工具。它必须满足：

- `source = AI_REPLENISHMENT_AGENT`；
- `idempotencyKey === sourceDraftId`；
- items 来自 `ReplenishmentDraft.items`；
- 创建前必须完成结构化预览和用户明确确认；
- workflow 成功后本地 draft 标记 `submitted_po_no`；
- 不能从 Markdown 反解析 PO 明细。

## 5. 工具漂移防护

启动期会校验 MCP 远端工具集合与预期工具集合严格相等，并检查 input/output schema 非空。新增、删除或改名工具时，一定按以下顺序处理：

```text
shared-contracts/mcp schema（含 marketing.ts）
  -> shared-contracts/mcp/index TOOL_NAMES（16 项字典序）
  -> mcp-mock-server register tool（handler + fixture）
  -> agent-service MCPClient whitelist/verification
  -> marketing-growth-copilot.ts MARKETING_GROWTH_TOOLS（V2）
  -> agent_skill_def.required_tools seed（V1 mig 011 / V2 mig 018）
  -> workflow 调用点 / marketingGrowthCopilot 指令引用
  -> marketing-scope-classifier 候选与 examples（V2）
  -> health/tests/Phase2 evals
```

## 6. 查询工具输出不是无限上下文

工具输出应限制规模，如 rank topN、categories max、items max；V2 marketing 已在 schema 层显式限定：
`query_member_segments ≤ 200`、`query_member_consumption_history.orders ≤ 500 / frequentSkuIds ≤ 20`、`query_product_performance ≤ 200`、`query_inventory_status ≤ 200`、`query_pos_summary_by_time ≤ 366`、`query_campaign_history ≤ 100`、`query_coupon_inventory ≤ 200`。不要为了"模型更聪明"把全量 ERP 数据塞进对话。优先在工具层/服务层做结构化聚合，再让模型解释。

## 7. V2 marketing 工具的租户与 PII 边界

- **tenant 注入**：`buildMarketingToolsForRuntime` 在 `execute` 时由 RuntimeContext 强制注入 `merchantId / storeId`，模型可见 schema 已隐藏这两个字段——模型不应也无法手填 tenant；任何"用 LLM 输出 merchantId"路径都是 bug。
- **PII 脱敏**：marketing schema 已用 `nameMasked`、`phoneMasked`；输出端不得反脱敏（R-V2-PII-001）。
- **写工具禁用**：V2 工具集合 0 个 WRITE；扩 V2 必须保持只读边界。任何想发券/改库存/改积分的需求应回到 V1 高风险 MCP 路径走 HITL，**不能**直接挂到 marketing 工具下。
