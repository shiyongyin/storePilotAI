---
generated_at: 2026-05-08
source_basis: storePilotAI.zip + storePilotAI_ontology_docs.zip
project: storepilot-ai
---

# Card: Skill Gate and Workflow Consistency

读这个卡片，当任务涉及：SkillDef、workflow id、dispatcher、Intent、灰度、required_tools、V2 Agent wrapper。

## 一致性

V1 Workflow 形态：`agent_skill_def.skill_code` 应与 workflow id 保持严格一致。启动期校验发现缺失、多余、必备 SkillDef 注册项被禁用时应失败。

命名口径：`skill_code` 是运行时注册与守门 ID，不总等同于产品语义上的普通 Skill。V1 的 `purchase_order_create` 是 HITL 确认采购单 workflow。

V2 Agent 形态：`marketing_growth_copilot` 的真实执行入口是 dispatcher 显式调用 `AgentBundle.marketingGrowthCopilot.generate`；`mastra/workflows/marketing-growth-copilot.ts` 是轻量 wrapper，只返回路由标记。修改 V2 Agent 时不要把 wrapper 当成主业务链路，也不要绕过 scope router / gray policy / `assertSkillUsable`。

## 灰度/禁用

- `disabled`：不可执行。
- `gray`：只有 `GRAY_MERCHANT_WHITELIST` 命中时可执行。
- `enabled`：正常执行，但仍受 required_tools 和规则限制。

## 新增 SkillDef / Workflow 必改

```text
shared-contracts intent/skill schema
migrations seed agent_skill_def
workflow implementation + barrel export
business-report-dispatcher mapping
required_tools 白名单
unit/integration tests
AI ontology docs
```

## 新增 Agent 形态 Skill 额外检查

```text
agent_skill_def seed（status 默认 gray）
AgentBundle 注入与 dispatcher 显式调用点
scope router / gray policy / assertSkillUsable
required_tools 与 MARKETING_GROWTH_TOOLS / MCP contracts 同步
output guard 与 PII redline
09_open_issues 是否存在未解决的 wrapper / toolCallCount / trace 写入风险
```
