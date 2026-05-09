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

## D-ADJUSTMENT-DISPATCHER-NOT-WIRED

**问题**：`replenishment_adjustment` workflow 已实现，SkillDef 也 enabled，但 dispatcher 对 `ADJUST_REPLENISHMENT_DRAFT` 当前仍返回“尚未完整接入桥接层”。  
**影响**：模型规划时不能简单认为“调整补货已从对话入口全量可用”。  
**建议**：确认产品方向：正式接入 dispatcher，或将 Skill 状态调整为 gray/disabled，并在文档说明当前限制。

## D-BUSINESS-DOMAIN-TABLES-EXTERNAL

**问题**：Merchant/Store/Sku/Category/Supplier/SalesSummary/InventorySnapshot 等核心业务实体主要由 ERP/MCP 提供，本地未建完整主数据表。  
**影响**：做新功能时容易误把本地 DB 当成业务事实源。  
**建议**：明确 ERP 与 Agent 本地状态的职责边界；新增本地表时说明它是运行态缓存、审计，还是业务主数据迁移。

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
