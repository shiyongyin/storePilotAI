---
generated_at: 2026-05-08
source_basis: storePilotAI.zip + storePilotAI_ontology_docs.zip
project: storepilot-ai
---

# Card: Skill Gate and Workflow Consistency

读这个卡片，当任务涉及：SkillDef、workflow id、dispatcher、Intent、灰度、required_tools。

## 一致性

`agent_skill_def.skill_code` 应与 workflow id 保持严格一致。启动期校验发现缺失、多余、必备 Skill 被禁用时应失败。

## 灰度/禁用

- `disabled`：不可执行。
- `gray`：只有 `GRAY_MERCHANT_WHITELIST` 命中时可执行。
- `enabled`：正常执行，但仍受 required_tools 和规则限制。

## 新增 Skill 必改

```text
shared-contracts intent/skill schema
migrations seed agent_skill_def
workflow implementation + barrel export
business-report-dispatcher mapping
required_tools 白名单
unit/integration tests
AI ontology docs
```
