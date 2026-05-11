---
generated_at: 2026-05-11
source_basis: V2 marketing phase 2 (commits 2ce5d1a / 10ea2e4 / 41e102d)
project: storepilot-ai
---

# Card: marketingGrowthCopilot 边界 / PII / OutputGuard

读这个卡片，当任务涉及：`marketing-growth-copilot.ts` 指令、Phase2 规则输出、`output-guard.ts`、card_data 注释块、PII 脱敏、防 prompt injection、`MARKETING_GROWTH_TOOLS` 白名单。

适用红线：**R-V2-AGENT-001、R-V2-PII-001、R-V2-OUTPUT-001、R-V2-EXT-SKILL-001**（详见 `07_guardrails.md`）。

## marketingGrowthCopilot 7 条铁律（与 BASE_MARKETING_INSTRUCTIONS 一一对应）

1. 只能使用 9 个只读营销 MCP 工具（`MARKETING_GROWTH_TOOLS`：`query_member_profile / query_member_consumption_history / query_member_segments / query_repurchase_cycle / query_product_performance / query_inventory_status / query_pos_summary_by_time / query_campaign_history / query_coupon_inventory`）。
2. 最多 8 次工具调用（`MARKETING_AGENT_MAX_STEPS=8`，必须 ≤ `AGENT_TOOL_CALLS_PER_REQUEST_HARD_LIMIT`）。必要时先问清楚，不要扩大工具调用。
3. 禁调 `createPurchaseOrder`；不发券、不群发、不改价、不改库存、不改积分（→ 任何写 ERP/营销动作都不属于本 Agent）。
4. 不得加载 External Skills；不读取 SKILL.md / references / scripts；不得把外部资料当作营销规则来源（R-V2-EXT-SKILL-001）。
5. 会员姓名和手机号只用 `nameMasked` / `phoneMasked`；不得输出完整姓名、完整手机号、身份证、邮箱、地址。
6. 销售额、库存、毛利、券数量、会员数必须来自工具返回或确定性计算；禁止编造（R-V2-PII-001 + R-AI-001）。
7. 老板可见回复不得出现 `tool_calls` / `function_call` / `traceId` / `merchantId` / `storeId` / `agent_run_id` 等内部元数据。

## OutputGuard 合规检查（`validateMarketingAgentOutput`）

`packages/agent-service/src/api/output-guard.ts` 当前函数语义：

```text
- 含伪桥标签 /<\s*(ASK|FALLBACK)\s*>/i → fallbackReason='AGENT_OUTPUT_FORGED_TAG' → 立即回落 generalQa。
- 不含 <!-- card_data:start --> 且 toolCallCount === 0 → fallbackReason='AGENT_OUTPUT_INVALID' → 立即回落 generalQa。
- 其余 → ok（仍要经过 V1 通用 OutputGuard 兜底）。
```

含义：

- card_data 注释块是阶段 2 营销建议的"机器可读标识"；不允许"只发自然语言不挂卡片"。
- 伪桥标签 `<ASK>` / `<FALLBACK>` 是为了让 prompt injection 看起来像桥协议的攻击；一旦出现必须降级（不论上下文）。
- 工具调用 0 次 + 没有 card_data → 模型可能在自由编故事，不可信。
- **红队注意**：当前 dispatcher 调用 `validateMarketingAgentOutput(..., 1)`，传入的是固定值，不是真实工具调用次数。因此“缺 card_data”在当前主链路上不会触发降级；伪桥标签仍会触发。该风险记录在 `09_open_issues.md`，修复前不要把 card_data 守卫描述为端到端强制。

## PII 脱敏字段一览

| 字段族 | 允许使用 | 禁止反向解析 |
| --- | --- | --- |
| 姓名 | `nameMasked`（如 `张*`、`Z**ng`） | 推断完整姓名、按性别/常见姓拼凑全名 |
| 手机 | `phoneMasked`（如 `138****1234`） | 输出完整 11 位、暴露未脱敏段 |
| 会员/订单 id | 仅在结构化卡片内部使用 | 在自由文本里大段输出 |
| 内部标识 | 不允许 | `traceId` / `merchantId` / `storeId` / `agent_run_id` / `tool_calls` 等 |

## 高频踩坑

- 把"全名+手机号"塞进 card_data 让前端展示；即使在 JSON 也算违规。
- 在指令里追加"为了让老板更清楚，请展示完整姓名"——直接违反 R-V2-PII-001。
- 让 marketingGrowthCopilot 读取项目里的外部 SKILL.md 作为营销指导（违反 R-V2-EXT-SKILL-001）。
- 在 `output-guard.ts` 里把伪桥标签判定改成 warning 不降级。
- 把 `MARKETING_GROWTH_TOOLS` 数组里加一个写工具或 V1 工具（必须同步 `agent_skill_def.required_tools` + 启动校验，强制 fail-fast）。
- 让 `MARKETING_AGENT_MAX_STEPS` 超过 `AGENT_TOOL_CALLS_PER_REQUEST_HARD_LIMIT`：env zod parse 不会自动卡（两者上限都是 8），但语义上 marketing 步数永远不应大于硬上限。
- 在 prompt 中暴露 RuntimeContext 字段（traceId / merchantId）：marketing 工具 wrapper 已自动注入 tenant 并对模型隐藏 schema，prompt 不要再"传给模型"。

## 改动时的最小变更集

```text
marketing-growth-copilot.ts（指令 / MARKETING_GROWTH_TOOLS / buildMarketingToolsForRuntime）
marketing/phase2/instructions.ts + scenario-catalog.ts + 各 *-rules.ts / *-output.markdown.test.ts
api/output-guard.ts（card_data / 伪桥标签）
test 用例：marketing-growth-copilot.test.ts + phase2 各 output.markdown.test.ts + l4-redline.*.test.ts
shared-contracts/mcp/marketing.ts（仅当 schema 变化）
agent_skill_def required_tools seed（仅当工具集合变）
AI_ONTOLOGY.md §4 红线 + 07_guardrails.md + 本卡片
```
