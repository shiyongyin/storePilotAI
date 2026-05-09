---
generated_at: 2026-05-08
source_basis: storePilotAI.zip + storePilotAI_ontology_docs.zip
project: storepilot-ai
---

# Card: MCP Contract Drift

读这个卡片，当任务涉及：MCP 工具名、输入输出 schema、mock、client、health、Skill required_tools。

## 漂移定义

只改某一侧会造成漂移：

- shared-contracts 有工具，但 mock 未注册；
- mock 有工具，但 agent-service 白名单没有；
- Skill required_tools 引用了不存在工具；
- 远端工具缺 input/output schema；
- workflow 调用工具名与 TOOL_NAMES 不一致。

## 正确同步顺序

```text
shared-contracts/mcp schema
  -> mcp/index.ts TOOL_NAMES
  -> mcp-mock-server registration
  -> MCPClient whitelist/verification
  -> agent_skill_def.required_tools
  -> workflow call sites
  -> health/tests
```

## 高风险工具

`createPurchaseOrder` 是 WRITE/HIGH，不要按普通 QUERY 工具处理。
