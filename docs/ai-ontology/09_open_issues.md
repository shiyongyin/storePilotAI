---
generated_at: 2026-05-08
source_basis: storePilotAI.zip + storePilotAI_ontology_docs.zip
project: storepilot-ai
---

# 09. Open Issues — 差异与待确认项

以下不是“错误结论”，而是当前项目文档、实现、迁移命名之间需要人工确认或治理的点。

## D-README-SLICE-STATUS

**问题**：README 的切片状态可能落后于当前代码实现。  
**影响**：新模型或新人可能误以为项目只完成早期切片，低估已有 workflow、migrations、tests、Skill seed。  
**建议**：更新 README，让它成为当前工程状态 SSOT，或明确标注历史状态。

## D-DOC-DDL-VS-MIGRATION

**问题**：原始本体模型文档中的“数据表建议”与实际 migrations 字段有差异。  
**原则**：涉及当前持久化结构时，以 `migrations/*.sql` 为 SSOT。  
**建议**：把原设计文档标注为历史设计，或同步更新为当前 DDL。

## D-MIGRATION-011-DUPLICATE-PREFIX

**问题**：存在两个 `011-*` migration 文件。  
**影响**：迁移 runner 若按文件名排序通常可运行，但人工审计和后续编号容易混淆。  
**建议**：后续新增 migration 使用唯一编号；是否重命名历史文件需结合已部署环境谨慎处理。

## D-ADJUSTMENT-DISPATCHER-DOC-DRIFT-RESOLVED

**状态**：已解决。  
**结论**：`replenishment_adjustment` workflow 已实现，SkillDef 也 enabled；当前 dispatcher 已对 `ADJUST_REPLENISHMENT_DRAFT` 接入 `loadActiveDraftStep → extractInstructionStep → applyInstructionStep → persistAdjustmentStep`。  
**保留提醒**：后续排查补货调整时，不要引用早期“尚未完整接入桥接层”的历史说法；应以 `packages/agent-service/src/api/business-report-dispatcher.ts` 和 `packages/agent-service/src/mastra/workflows/replenishment-adjustment.ts` 为准。

## D-BUSINESS-DOMAIN-TABLES-EXTERNAL

**问题**：Merchant/Store/Sku/Category/Supplier/SalesSummary/InventorySnapshot 等核心业务实体主要由 ERP/MCP 提供，本地未建完整主数据表。  
**影响**：做新功能时容易误把本地 DB 当成业务事实源。  
**建议**：明确 ERP 与 Agent 本地状态的职责边界；新增本地表时说明它是运行态缓存、审计，还是业务主数据迁移。

## D-V2-MARKETING-OUTPUT-GUARD-TOOLCOUNT

**问题**：`validateMarketingAgentOutput` 的目标语义是“缺 `card_data` 且真实 tool call 次数为 0 时降级”，但当前 dispatcher 调用时传入固定 `toolCallCount=1`，并未读取 `marketingGrowthCopilot.generate` 的真实工具调用计数。  
**影响**：伪桥标签 `<ASK>` / `<FALLBACK>` 仍会被拒绝，但“没有 card_data 的纯自然语言营销输出”不会因为 toolCallCount=0 被拦截；文档和测试若声称 card_data 端到端强制，会高估当前防护。  
**建议**：运行时修复时从 Mastra/AI SDK result 中提取真实 tool call 计数，或改为 marketing 主链路一律要求 `card_data`；补 `business-report-dispatcher` 端到端测试覆盖“无 card_data + 无真实 tool call → 降级 generalQa”。

## D-V2-SCOPE-TIMEOUT-UPPER-BOUND

**问题**：文档目标建议 scope classifier 使用 1500ms 默认 / ≤2000ms 生产上限，但 env schema 当前允许 `MARKETING_SCOPE_CLASSIFIER_TIMEOUT_MS` 最高 10000ms。  
**影响**：灰度或生产若配置到数秒级，LLM 分类故障会拖慢 `/v1/chat/completions` 首包延迟；“1500ms 超时保护”会被误解为硬上限。  
**建议**：将生产环境上限收紧到 2000ms，或在 runbook/health 中显式告警；保留测试/本地长超时需求时，应只在非生产 profile 放开。

## D-V2-SCOPE-CONFIDENCE-NORMALIZATION

**问题**：scope classifier prompt 写明 `confidence < 0.6` 一律降为 `AMBIGUOUS`，但 `parseScopeClassifierText` 当前只做 schema parse 和 `IN_SCOPE → V2_IN_SCOPE` 兼容映射，没有二次强制按 confidence 归一。  
**影响**：如果模型返回 `{ scope: "V2_IN_SCOPE", confidence: 0.2 }`，运行时会接受 `V2_IN_SCOPE`，可能扩大 marketingGrowthCopilot 触发面。  
**建议**：在 parser 层强制 `confidence < 0.6` 改写为 `AMBIGUOUS` 并清理不可信候选；新增单测覆盖低置信度 IN_SCOPE。

## D-AGENT-TOOL-CALL-TRACE-NOT-WIRED

**问题**：`agent_tool_call_trace` 表已建（migration 017），文档也将其列为 V2 工具调用审计，但当前运行时尚未在 `marketingGrowthCopilot` 工具 wrapper 或 MCP client 中写入该表。  
**影响**：V2 marketing 工具调用缺少可查询审计链；排查“用了哪些工具事实生成这段建议”只能依赖日志/模型输出，无法满足稳定的事后追踪。  
**建议**：优先在 `buildMarketingToolsForRuntime.execute` 包装层记录 trace/session/tenant/tool_name/input 摘要/output 摘要/elapsed/success/error；严禁写完整 PII 或大体积原始响应。

## D-V2-SKILLDEF-AGENT-WORKFLOW-WRAPPER-AMBIGUITY

**问题**：V2 `marketing_growth_copilot` 同时存在 SkillDef、Mastra Agent 和轻量 workflow wrapper。真实业务执行由 dispatcher 显式调用 `AgentBundle.marketingGrowthCopilot.generate`；`mastra/workflows/marketing-growth-copilot.ts` 只返回路由标记，不执行营销逻辑。  
**影响**：后续模型/新人可能误以为 wrapper 是主执行链路，在 wrapper 内补业务逻辑或把它纳入 V1 workflow 思维，造成路由和灰度语义漂移。  
**建议**：保留 `04_skill_intent_workflow.md` 的“真实执行 vs 注册 wrapper”说明；若未来要统一 Agent 形态注册校验，单独设计 SkillDef↔AgentBundle verifier，不要混入 V1 workflow barrel 校验。

## 决策记录模板

后续处理任一问题时，建议新增小型 ADR：

```markdown
# ADR-YYYYMMDD-<topic>

## 背景
## 决策
## 影响的本体对象
## 影响的代码/表/契约
## 回滚方式
## 需要更新的 AI 文档
```
