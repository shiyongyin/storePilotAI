---
generated_at: 2026-05-08
source_basis: storePilotAI.zip + storePilotAI_ontology_docs.zip
project: storepilot-ai
---

# StorePilotAI AI 本体上下文包

这是给 Codex / 大模型 / 人类 reviewer 使用的本体上下文文档。它基于当前项目代码、文档、SQL migrations、shared contracts、MCP mock 和上一次结构化本体资料生成。

## 设计原则

1. **先短后长**：根目录 `AI_ONTOLOGY.md` 是默认入口，不要一开始读完整资料。
2. **按任务加载**：不同任务读取不同专题文档，避免上下文污染。
3. **规则优先**：补货、采购单、租户、MCP、数字输出相关任务先看 guardrails。
4. **证据回链**：文档用项目相对路径标记证据；真正改代码时回到对应源码/迁移文件确认。
5. **AI 可读 + 人可审**：表格、规则 ID、Mermaid 图和变更 playbook 同时服务模型和人。

## 目录

| 文件 | 用途 | 默认加载 |
| --- | --- | --- |
| `../../AI_ONTOLOGY.md` | 根入口，最先读 | 是 |
| `00_context_manifest.md` | 任务到文档的加载路由 | 是，任务复杂时 |
| `01_core_ontology.md` | 项目本体总览和关系图 | 常用 |
| `02_domain_model.md` | 领域对象词典 | 业务设计时 |
| `03_runtime_and_boundaries.md` | 运行时、API、组件边界 | 改服务入口时 |
| `04_skill_intent_workflow.md` | Intent/Skill/Workflow 映射 | 改能力时 |
| `05_mcp_contracts.md` | MCP 工具契约 | 改工具或数据源时 |
| `06_data_persistence.md` | 数据表、状态机、持久化 | 改 DB 时 |
| `07_guardrails.md` | 安全和业务红线 | 高风险必读 |
| `08_codex_change_playbook.md` | 编码规划手册 | 开发任务必读 |
| `09_open_issues.md` | 待确认差异 | 设计/治理必读 |
| `10_evidence_index.md` | 证据索引 | 需要核实时 |
| `cards/*.md` | 小型上下文卡片 | 按需 |
| `data/*.jsonl|yaml` | 机器可读索引 | 按需 |
| `reference/*` | 结构化本体原始导出 | 不默认读 |

## 抽取规模

| 指标 | 数量 |
| --- | ---: |
| 本体实体 | 95 |
| 本体关系 | 39 |
| 业务/安全规则 | 21 |
| 待确认差异 | 5 |
| TS 源码文件 | 153 |
| 非测试 TS 源码 | 90 |
| 测试文件 | 93 |
| Markdown 文档 | 61 |
| SQL migration 文件 | 12 |
| CREATE TABLE | 13 |

## 注意

本文档不包含 `.env.*` 的任何具体值；如果提到环境变量，只引用 schema key。
