---
generated_at: 2026-05-08
source_basis: storePilotAI.zip + storePilotAI_ontology_docs.zip
project: storepilot-ai
---

# 08. Codex Change Playbook — 编码/规划变更手册

> 这份文件给规划和编码 Agent 使用。目标不是替代源码阅读，而是先判断“业务上应该往哪里改、不能往哪里改”。

## 1. 通用流程

```text
1. 识别任务类型：skill / mcp / db / runtime / report / safety / docs。
2. 按 00_context_manifest.md 加载专题文档。
3. 输出 Ontology impact 清单。
4. 找 SSOT：shared-contracts、migrations、agent-service、mock、docs。
5. 设计最小变更集，不绕过 guardrail。
6. 加测试：契约、workflow、dispatcher、安全、迁移、集成。
7. 更新 AI_ONTOLOGY 或专题文档中受影响部分。
```

## 2. 新增 Skill / 业务能力

优先顺序：

```text
shared-contracts Intent/Skill schema
  -> workflow 实现
  -> agent_skill_def seed
  -> dispatcher 映射
  -> MCP required_tools
  -> tests
  -> docs/ai-ontology 更新
```

必须回答：

- 是否已有 Intent？
- 是否涉及写操作？写操作必须 HITL。
- 需要哪些 MCP 工具？是否越过 required_tools？
- 输出是否含数字？是否有 validator？
- 是否需要灰度？默认不应直接 enabled 高风险能力。

## 3. 修改 MCP 工具

```text
shared-contracts/mcp/*.ts
  -> mcp/index.ts TOOL_NAMES
  -> mcp-mock-server 注册与 fixtures
  -> MCPClient 白名单/启动校验
  -> SkillDef.required_tools
  -> workflow 调用和错误处理
  -> health/tests
```

不要只改 mock 或只改 workflow。工具集合漂移应该在启动期暴露，而不是运行时悄悄降级。

## 4. 修改补货预测

先判断改的是：

| 类型 | 正确位置 |
| --- | --- |
| 预测天数、策略参数 | Strategy schema / StrategyEngine / workflow 输入解析 |
| SKU 建议数量算法 | replenishment calculator / workflow compute step |
| 草稿保存字段 | Draft schema + migration + DraftManager |
| 展示文案 | compose markdown，不改变事实来源 |

原则：LLM 可以解释，不负责改数字核心计算。

## 5. 修改补货调整

重点检查：

- active draft 加载是否绑定 tenant/session；
- 状态是否允许调整；
- target 匹配是否可解释；
- maxAdjustmentsPerDraft 是否保留；
- before/after 是否写审计；
- dispatcher 当前是否正式接入；
- 调整后是否仍等待确认，而不是直接提交。

## 6. 修改采购单创建

绝对顺序：

```text
Draft.items -> preview -> suspend -> explicit confirm -> reread draft -> assert -> createPurchaseOrder -> markSubmitted
```

禁止：

- 从 markdown 解析 items；
- 用户没有明确确认就调用写工具；
- 并发确认绕过 lock；
- 修改 idempotencyKey 语义；
- 失败时把本地 draft 错标为 submitted。

## 7. 修改数据库/迁移

新增 migration 前先解决编号：当前已有两个 `011-*`。新增文件建议使用下一个唯一编号，例如 `012-*` 或按项目现行规范调整。

每个新表/字段要回答：

- 是 Agent 运行态，还是 ERP 主数据？
- 是否需要 tenant 字段？
- 是否需要状态机、过期时间、幂等键？
- 是否需要索引支持 session drift/recent fallback？
- 是否影响 `/health/db`？
- 是否同步 shared-contracts 和 tests？

## 8. 修改报表/月报输出

- 不要让 LLM 自由编数字。
- 缺失工具时要有明确降级或失败语义。
- 输出 cards/insights/source summary 时保留数据来源说明。
- 修改数字格式时更新数字一致性测试。

## 9. 修改 ChatCompletions / SSE / Output

检查：

- 请求 schema 是否仍拒绝工具调用字段；
- SSE heartbeat/abort/active stream 是否安全；
- OutputGuard 是否仍扫描禁用 token；
- 错误是否 friendly；
- 是否泄漏内部工具调用结构或敏感环境信息。

## 10. 文档更新标准

代码变更后，如果触碰以下内容，应同步更新本体文档：

- 新/删/改 Intent、Skill、Workflow、MCP Tool；
- 新/改数据表、状态流转、策略字段；
- 新的安全规则或已有规则被重构；
- README 状态与实现差异被修正；
- 高风险流程的用户确认语义变化。
