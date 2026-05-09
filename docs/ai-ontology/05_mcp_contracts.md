---
generated_at: 2026-05-08
source_basis: storePilotAI.zip + storePilotAI_ontology_docs.zip
project: storepilot-ai
---

# 05. MCP Contracts — 工具与契约本体

## 1. MCP 是 ERP 能力边界

本项目通过 7 个 MCP 工具访问 ERP/经营数据能力。MCP 工具分为 6 个 QUERY/LOW 和 1 个 WRITE/HIGH。工具名、输入输出 schema、mock、client 白名单、SkillDef.required_tools 必须保持同步。

## 2. 工具清单

| Tool | 类型 | 风险 | 语义 | 主要调用方 |
| --- | --- | --- | --- | --- |
| `getStoreReportConfig` | QUERY | LOW | 门店报表配置：currency/locale/cards/timezone。 | 日报 |
| `queryStoreSalesSummary` | QUERY | LOW | 销售额、订单数、客单价等经营汇总。 | 日报、月报 |
| `queryCategorySalesRatio` | QUERY | LOW | 品类销售占比，ratio 0..1。 | 日报、月报 |
| `queryProductSalesRank` | QUERY | LOW | 商品排行，topN 1..500。 | 日报、月报 |
| `queryInventoryOverview` | QUERY | LOW | 库存概览、低库存、缺货、库存价值。 | 日报、月报 |
| `queryReplenishmentBaseData` | QUERY | LOW | SKU、库存、销量、在途、lead time、供应商。 | 补货预测 |
| `createPurchaseOrder` | WRITE | HIGH | 创建 ERP 采购单。 | 采购单创建 HITL |

## 3. 契约 SSOT

| 内容 | 事实来源 |
| --- | --- |
| Tool schema | `packages/shared-contracts/src/mcp/*.ts` |
| Tool name list | `packages/shared-contracts/src/mcp/index.ts` 的 `TOOL_NAMES` |
| agent client 白名单 | `packages/agent-service/src/mastra/mcp/client.ts` |
| mock 实现 | `packages/mcp-mock-server/src/mcp-server.ts` |
| Skill 权限 | `agent_skill_def.required_tools` seed |

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
shared-contracts/mcp schema
  -> shared-contracts/mcp/index TOOL_NAMES
  -> mcp-mock-server register tool
  -> agent-service MCPClient whitelist/verification
  -> agent_skill_def.required_tools
  -> workflow 调用点
  -> health/tests
```

## 6. 查询工具输出不是无限上下文

工具输出应限制规模，如 rank topN、categories max、items max。不要为了“模型更聪明”把全量 ERP 数据塞进对话。优先在工具层/服务层做结构化聚合，再让模型解释。
