---
generated_at: 2026-05-11
source_basis: V2 marketing phase 2 (commits 2ce5d1a / 10ea2e4 / 41e102d)
project: storepilot-ai
---

# Card: V2 营销三段路由（V1 显式优先 → 店铺级灰度 → 范围分类器）

读这个卡片，当任务涉及：营销入口路由、`MARKETING_AGENT_*` env、店铺级灰度、scope classifier 提示词 / 候选 / 样例、`v1-explicit-command-router.ts`、`marketing-gray-policy.ts`、`marketing-scope-classifier.ts`、`business-report-dispatcher.ts` 的 V2 分支。

适用红线：**R-V2-AGENT-001、R-V2-SCOPE-001**（详见 `07_guardrails.md`）。

## 三段路由顺序（绝不可调整）

```text
1. resolveExplicitV1Intent(message)
   → 命中 6 条 V1 显式 regex 中任一条 → 进 V1 IntentEnum 分发，
     完全不进入 V2 营销路径。
2. isMarketingEnabledForStore({ auth })
   → MARKETING_AGENT_ENABLED=false → V2 关闭，降级 generalQa。
   → true：storeId ∈ MARKETING_AGENT_ENABLED_STORE_WHITELIST → 放行；
     否则 sha256("<merchantId>:<storeId>") 前 8 hex % 100 < MARKETING_AGENT_ROLLOUT_PERCENT → 放行；
     都不命中 → 降级 generalQa。
3. classifyMarketingScope(message)（LLM 范围分类器，默认 1500ms 超时；生产建议 ≤2000ms）
   → 超时 / 非法 JSON → degraded=true + AMBIGUOUS（不打挂对话）。
   → V2_IN_SCOPE → 进 assertSkillUsable('marketing_growth_copilot') + marketingGrowthCopilot.generate(maxSteps=8)。
   → AMBIGUOUS：有候选 → 输出澄清候选（≤ 3 个 US-xxx）；无候选 → 降级 generalQa。
   → OUT_OF_SCOPE → 降级 generalQa。
```

## V1 显式动作 regex（变更前先回填本卡）

| Regex（在 `v1-explicit-command-router.ts`） | Intent |
| --- | --- |
| `/生成.*日报\|经营日报/` | BUSINESS_DAILY_REPORT |
| `/生成.*月报\|经营月报/` | BUSINESS_MONTHLY_REPORT |
| `/生成.*补货\|补货建议\|补货预测/` | REPLENISHMENT_PLAN |
| `/调整.*补货\|把.*加\\s*\\d+%/` | ADJUST_REPLENISHMENT_DRAFT |
| `/确认提单\|生成采购单/` | CONFIRM_CREATE_PURCHASE_ORDER |
| `/取消草稿/` | CANCEL_REPLENISHMENT_DRAFT |

新增或修改 V1 显式 regex 时，必须：

1. 同步 scope classifier 的 `examples` 与 prompt 中"V1 已被上游 router 拦截"段；
2. 跑 `scope-classifier-runner.test.ts` 与 `marketing-keyword-router.phase2.test.ts`；
3. 在 09_open_issues.md 留记录，避免后人误以为 V2 漏过 V1 输入。

## scope classifier 输出枚举

```text
ScopeOutputSchema = {
  scope: 'V2_IN_SCOPE' | 'AMBIGUOUS' | 'OUT_OF_SCOPE',
  confidence: 0..1,
  candidates?: UsCode[]（最多 3 个，仅 US-001..US-018）,
  reason?: string ≤ 200,
  degraded?: boolean   // 超时 / 非法 JSON
}
```

约束：

- `confidence < 0.6` 一律降为 `AMBIGUOUS`（已写入 prompt；当前 parser 未做二次强制归一，见 `09_open_issues.md`）。
- IN_SCOPE 与 V2_IN_SCOPE 都接受（兼容），统一映射为 `V2_IN_SCOPE`。
- 候选只能从 `US_DISPLAY_NAMES` 已定义编码中选；新增 US-xxx 必须先扩 `marketing/phase2/us-display-names.ts`。

## 高频踩坑（review 时优先扫这几条）

- 在 dispatcher 里直接调 `marketingGrowthCopilot.generate` 而**绕过**三段路由 → 违反 R-V2-SCOPE-001。
- 把 `MARKETING_AGENT_ROLLOUT_PERCENT` 默认值改大；或在生产把 `MARKETING_AGENT_ENABLED` 默认改 true → 违反"V2 默认 disabled"约定。
- 把 scope classifier 超时阈值提到几秒：会让 LLM 故障拖垮对话延迟。env schema 当前允许最高 10000ms，但生产/灰度建议保留 ≤ 2000ms + degraded 兜底。
- 缩短或删除 prompt 里"V1 已被上游拦截"那段：会导致 scope classifier 把"生成日报"判成 V2_IN_SCOPE。
- 在 `inferCandidate` regex 里允许过宽（如 `/.*/`）：会出现高置信度误判。
- 让候选输出 > 3 个：违反 schema，会触发 zod parse 失败 → degraded。
- 改动 scope examples 后不重跑 L2 评测（`scope-classifier-cases.json`）：很容易整体回归。

## 改动时的最小变更集

```text
shared-contracts/mcp/marketing.ts（如果同时改工具）
v1-explicit-command-router.ts（V1 优先 regex）
marketing-gray-policy.ts（店铺级灰度）
marketing-scope-classifier.ts（prompt / candidates / timeout）
scripts/scope-classifier-examples.json（样例分布 IN/AMBI/OUT 平衡）
marketing/phase2/us-display-names.ts（US 编码扩展）
test/eval/phase2/scope-classifier-runner.test.ts + l2/l3/l4 evals
项目 CI / phase2 eval runner（如新增 case 文件，确认会被执行）
AI_ONTOLOGY.md §5 / §6 + 本卡片 + 03/04 文档
```
