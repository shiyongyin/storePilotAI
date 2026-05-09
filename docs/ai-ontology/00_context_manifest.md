---
generated_at: 2026-05-08
source_basis: storePilotAI.zip + storePilotAI_ontology_docs.zip
project: storepilot-ai
---

# 00. Context Manifest — 渐进式加载说明

## L0：每次都读

| 文件 | 目的 | 预算 |
| --- | --- | --- |
| `AI_ONTOLOGY.md` | 项目语义入口、红线、任务路由 | 中 |
| `AGENTS.md` | Codex 自动入口与输出要求 | 小 |

## L1：常用核心

| 文件 | 何时读 | 读完应知道 |
| --- | --- | --- |
| `01_core_ontology.md` | 不确定项目边界/本体层时 | 项目是什么、核心对象和关系是什么 |
| `07_guardrails.md` | 任何补货/采购/MCP/租户/输出任务 | 哪些事绝对不能破坏 |
| `08_codex_change_playbook.md` | 要规划或编码时 | 不同变更类型的正确落点和测试 |

## L2：按任务加载

| 任务 | 必读 | 选读 |
| --- | --- | --- |
| 新增业务能力/Skill | `04_skill_intent_workflow.md` | `05_mcp_contracts.md`, `06_data_persistence.md` |
| 新增/修改 Intent | `04_skill_intent_workflow.md` | `03_runtime_and_boundaries.md` |
| 修改补货预测 | `02_domain_model.md`, `04_skill_intent_workflow.md` | `cards/replenishment_draft_state_machine.md` |
| 修改采购单创建 | `cards/purchase_order_high_risk.md`, `07_guardrails.md` | `05_mcp_contracts.md`, `06_data_persistence.md` |
| 修改 MCP 工具 | `05_mcp_contracts.md`, `cards/mcp_contract_drift.md` | `04_skill_intent_workflow.md` |
| 修改数据库/迁移 | `06_data_persistence.md` | `09_open_issues.md` |
| 修改 ChatCompletions/SSE/Auth | `03_runtime_and_boundaries.md` | `cards/tenant_isolation.md`, `07_guardrails.md` |
| 修改报表数字/卡片 | `04_skill_intent_workflow.md`, `cards/report_number_consistency.md` | `05_mcp_contracts.md` |
| 更新文档/README | `09_open_issues.md`, `10_evidence_index.md` | `01_core_ontology.md` |

## L3：证据层

仅当要核实细节或准备修改相关代码时读取：

- `10_evidence_index.md`
- `reference/project_ontology.json`
- `reference/nodes.csv`
- `reference/relations.csv`
- 实际源码、migrations、shared-contracts、docs 原文

## 给模型的选择规则

```text
IF task touches PurchaseOrder OR createPurchaseOrder OR CONFIRM_CREATE_PURCHASE_ORDER:
  read cards/purchase_order_high_risk.md + 07_guardrails.md + 05_mcp_contracts.md

IF task touches ReplenishmentDraft OR replenishment_draft OR ADJUST_REPLENISHMENT_DRAFT:
  read cards/replenishment_draft_state_machine.md + 06_data_persistence.md

IF task touches MCP tool names/schemas/mock/client:
  read 05_mcp_contracts.md + cards/mcp_contract_drift.md

IF task touches SkillDef, workflow id, dispatcher, Intent:
  read 04_skill_intent_workflow.md + cards/skill_gate.md

IF task touches merchantId/storeId/userId/session/draft SQL:
  read cards/tenant_isolation.md + 07_guardrails.md
```
