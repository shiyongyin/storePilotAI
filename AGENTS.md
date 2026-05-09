# AGENTS.md — StorePilotAI Codex 入口规则

> 本文件是给 Codex / 编码 Agent 的最短入口。开始规划或改代码前，先读项目根目录的 `AI_ONTOLOGY.md`。

## 必读顺序

1. `AI_ONTOLOGY.md`：项目业务语义、本体入口、规则红线、按任务加载路由。
2. 按任务类型读取 `docs/ai-ontology/00_context_manifest.md` 中对应专题文档（L0/L1/L2/L3 渐进式加载）。
3. 涉及补货、采购单、MCP、租户、数字输出、Skill/Workflow 时，必须读取 `docs/ai-ontology/07_guardrails.md` 和相关 `docs/ai-ontology/cards/*.md`。
4. 完整规则 ID 表与对应卡片见 `AI_ONTOLOGY.md` 第 4 节"不可变规则红线"。

## 编码前必须声明的判断

在提出方案或改代码前，先用 `AI_ONTOLOGY.md` 第 7 节定义的标准模板输出 Ontology impact 清单（task_type / touched_entities / touched_relations / guardrails_checked / source_of_truth / risk_level / expected_tests）。模板示例：

```text
Ontology impact:
- task_type: <skill|mcp|db|runtime|report|docs|bugfix>
- touched_entities: [Skill, Intent, Workflow, ...]
- touched_relations: [requiresTool, implementsWorkflow, writes, ...]
- guardrails_checked: [R-AI-001, R-SEC-001, ...]
- source_of_truth: [shared-contracts, migrations, workflow, docs, ...]
- risk_level: LOW|MEDIUM|HIGH
- expected_tests: [...]
```

> SSOT：当 `AGENTS.md` 与 `AI_ONTOLOGY.md` 的字段定义不一致时，以 `AI_ONTOLOGY.md` 第 7 节为准。

## 不可违反（每条都附核心规则 ID，详细语义见 `docs/ai-ontology/07_guardrails.md`）

- (R-AI-001, R-NUM-001) 不编造销售、库存、SKU、采购数量；数字只能来自 MCP、持久化草稿或确定性计算。
- (R-AI-002) 创建采购单必须经过 ReplenishmentDraft → 结构化预览 → HITL 确认 → createPurchaseOrder。
- (R-AI-003) 不得从 Markdown / 展示文本反解析采购单明细；PO items 只能来自 `ReplenishmentDraft.items`。
- (R-SEC-001) 不得破坏 merchantId / storeId / userId 租户隔离；任何 SQL / MCP / session / draft 必须绑定 tenant。
- (R-SKILL-001) 不得让 Skill 调用 `required_tools` 之外的 MCP 工具；启动期 SkillDef 与 workflow id 必须严格一致。
- (R-MCP-001) 不得让 MCP 工具集合 / schema 与 `shared-contracts/mcp` + `agent_skill_def.required_tools` 漂移；任何缺失/多余/schema 缺失都要在启动期失败。
- (R-OUT-001) 不得把 `tool_calls`、`function_call`、`tool_call_id` 等工具调用结构泄漏给前端；OutputGuard 必须保留。
- (R-HTTP-001) 不接受客户端传入 `tools` / `tool_choice` / `functions` / `function_call` / `response_format`。
- (R-STR-002, R-STR-003) `allowAutoPurchaseOrder=false`、`requireUserConfirmForWrite=true` 在 V1 是安全开关，不可改成 true 或绕过。
- (env policy) 不输出 `.env.*` 的具体值；只允许引用 env schema key。
