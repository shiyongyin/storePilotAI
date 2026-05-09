---
generated_at: 2026-05-08
source_basis: storePilotAI.zip + storePilotAI_ontology_docs.zip
project: storepilot-ai
---

# 10. Evidence Index — 证据索引

> 本文件只给模型/人定位证据，不要求默认加载所有源码。修改代码前请回到实际文件确认。

## 1. 项目与设计

| 主题 | 证据路径 |
| --- | --- |
| 根项目、pnpm、脚本、Node 版本 | `package.json` |
| 原始本体模型、业务目标、V1 范围 | `docs/门店助手Agent_V1_本体模型文档.md` |
| README 当前状态 | `README.md` |

## 2. shared-contracts

| 主题 | 路径 |
| --- | --- |
| Intent 枚举 | `packages/shared-contracts/src/intents.ts` |
| Draft / AdjustmentInstruction | `packages/shared-contracts/src/drafts.ts` |
| Strategy schema | `packages/shared-contracts/src/strategies.ts` |
| Skill schema | `packages/shared-contracts/src/skills.ts` |
| HTTP request schema | `packages/shared-contracts/src/http.ts` |
| MCP contracts | `packages/shared-contracts/src/mcp/*.ts` |
| MCP tool index | `packages/shared-contracts/src/mcp/index.ts` |

## 3. agent-service runtime

| 主题 | 路径 |
| --- | --- |
| server bootstrap / graceful shutdown | `packages/agent-service/src/server.ts` |
| ChatCompletions bridge | `packages/agent-service/src/api/chat-completions.ts` |
| Health APIs | `packages/agent-service/src/api/health.ts` |
| Dispatcher | `packages/agent-service/src/api/business-report-dispatcher.ts` |
| Auth | `packages/agent-service/src/bridge/auth.ts` |
| Session bridge | `packages/agent-service/src/bridge/session.ts` |
| OutputGuard | `packages/agent-service/src/bridge/output-guard.ts` |
| MCP client | `packages/agent-service/src/mastra/mcp/client.ts` |
| Mastra factory | `packages/agent-service/src/mastra/index.ts` |
| LLM provider | `packages/agent-service/src/mastra/llm-provider.ts` |
| Skill registry | `packages/agent-service/src/mastra/agents/skill-registry.ts` |
| StrategyEngine | `packages/agent-service/src/safety/strategy-engine.ts` |
| DraftManager | `packages/agent-service/src/safety/draft-manager.ts` |
| ConfirmManager | `packages/agent-service/src/safety/confirm-manager.ts` |
| OutputValidator | `packages/agent-service/src/safety/output-validator.ts` |

## 4. workflows

| Workflow | 路径 |
| --- | --- |
| business_daily_report | `packages/agent-service/src/mastra/workflows/business-daily-report.ts` |
| business_monthly_report | `packages/agent-service/src/mastra/workflows/business-monthly-report.ts` |
| replenishment_forecast | `packages/agent-service/src/mastra/workflows/replenishment-forecast.ts` |
| replenishment_adjustment | `packages/agent-service/src/mastra/workflows/replenishment-adjustment.ts` |
| purchase_order_create | `packages/agent-service/src/mastra/workflows/purchase-order-create.ts` |
| workflows barrel | `packages/agent-service/src/mastra/workflows/index.ts` |

## 5. migrations

| 主题 | 路径 |
| --- | --- |
| Skill/Strategy tables | `migrations/001-init-skill-and-strategy.sql` |
| Replenishment draft/log | `migrations/002-init-replenishment.sql` |
| Agent/Skill run logs | `migrations/003-init-agent-runlog.sql` |
| API key | `migrations/004-init-api-key.sql` |
| Strategy invalidation | `migrations/005-init-strategy-invalidation.sql` |
| Agent session/HITL fields | `migrations/006-init-agent-session.sql` |
| Platform default strategy seed | `migrations/007-seed-default-platform-strategy.sql` |
| Mastra snapshot/event/suspend | `migrations/008-*`, `009-*`, `010-*` |
| Adjustment log extension | `migrations/011-extend-replenishment-adjustment-log.sql` |
| SkillDef seed | `migrations/011-seed-agent-skill-def.sql` |

## 6. MCP mock

| 主题 | 路径 |
| --- | --- |
| Mock app | `packages/mcp-mock-server/src/app.ts` |
| Mock env，生产禁用 | `packages/mcp-mock-server/src/config/env.ts` |
| Tool registration | `packages/mcp-mock-server/src/mcp-server.ts` |
| Fixtures | `packages/mcp-mock-server/src/fixtures/*` |
| Idempotency store | `packages/mcp-mock-server/src/support/idempotency-store.ts` |

## 7. 结构化参考

| 文件 | 说明 |
| --- | --- |
| `reference/project_ontology.json` | 完整实体、关系、规则、差异。 |
| `reference/nodes.csv` | 图谱节点。 |
| `reference/relations.csv` | 图谱关系。 |
| `reference/source_inventory.json` | 源文件和 env schema key 清单，不含 env 值。 |
