# Runbook 03 — 灰度发布 SOP（切片 21 / T-OPS-02）

> 版本：V1（切片 21 落地）
> 适用范围：门店助手 Agent V1 全部上线 / 灰度推广 / 大版本（agent_skill_def
> active_version 升级 / 业务策略大改）发布。
> 关联任务卡：`docs/任务卡/I-运维.md` §T-OPS-02 §5 灰度顺序 / §6 MUST DO / §8.1。
> 关联切片：17（HITL 误提单红线）、19（20 条 E2E 灰度演练用）、20（健康检查 / 优雅停机）。

## 1. 6 阶段灰度顺序（任务卡 §7 MUST DO §1）

| 阶段 | 范围 | 时长 | 离场条件 |
| ---- | ---- | ---- | -------- |
| 1 | 测试门店（mock 数据 / FIXTURE_PROFILE=happy-path）          | ≥ 24h | 6 项指标全绿 + 误提单 = 0 |
| 2 | 内部真实门店（1 家，公司自营 / 友测）                     | ≥ 24h | 6 项指标全绿 + 误提单 = 0 |
| 3 | 单商家 1-3 家门店（`GRAY_MERCHANT_WHITELIST=M-pilot`）   | ≥ 24h | 6 项指标全绿 + 误提单 = 0 |
| 4 | 单商家 10 家门店（同 `GRAY_MERCHANT_WHITELIST` 商家扩门店） | ≥ 24h | 6 项指标全绿 + 误提单 = 0 |
| 5 | 多商家灰度（`GRAY_MERCHANT_WHITELIST` 中 ≤ 5 商家）       | ≥ 24h | 6 项指标全绿 + 误提单 = 0 |
| 6 | 全量（移除 `GRAY_MERCHANT_WHITELIST` 或转白名单为业务正常态） |   —   | 持续观察 7 天进入运营态 |

> **MUST NOT（任务卡 §7 MUST NOT §1 / §6）**：任何阶段都**不得**跳过 24h 观察期；
> 任何阶段都**不得**跳过监控指标核对。
> **MUST NOT（任务卡 §7 MUST NOT §5）**：对已创建的真实采购单不得做"程序化撤销"，
> 只能走 ERP 审批撤销。

## 2. 24h 观察清单（每阶段 6 项指标，必须全绿）

> 取数口径：Grafana / OTel（运维手册 §5.1 / §5.2）+ MySQL `agent_runlog` /
> `replenishment_draft` / `agent_session`（业务真相单源）。

| # | 指标 | 阈值 | 数据源 | P0 触发动作 |
| - | ---- | ---- | ------ | ----------- |
| 1 | 请求成功率 (HTTP 2xx / total)                       | ≥ 99 % (24h 滚动) | Agent Service `/v1/chat/completions` 访问日志   | 跌破 → 立即按 `04-rollback.md` 回滚 |
| 2 | MCP 工具调用成功率                                  | ≥ 95 % (24h 滚动) | OTel mcp.tool span / `agent_runlog`           | 跌破 → 检查 `/health/mcp` + Mock / V2 端 |
| 3 | 补货草稿生成成功率（无 NUMBER_INCONSISTENT / SCHEMA_FAIL）| ≥ 95 % (24h 滚动) | `replenishment_draft` 插入 / `agent_runlog`     | 跌破 → 排查 fixture / Strategy / Schema |
| 4 | 用户调整次数（中位数 / 草稿）                       | 1 - 3 次          | `replenishment_adjustment_log`                 | 中位数突破 5 → 调整 prompt 或回滚策略 |
| 5 | 采购单创建成功率（剔除老板取消）                    | ≥ 95 % (24h 滚动) | `replenishment_draft.status=SUBMITTED` / 总确认 | 跌破 → 检查 ERP 端 + ConfirmManager |
| 6 | **误提单 = 0（绝对红线）**                          | 严格 0            | 客户工单 / 老板取消但已 SUBMITTED                | **立即** rollout undo + 客服联系     |

> **MUST DO（任务卡 §7 MUST DO §2）**：误提单 / 重复提单 / MCP 不可用 = P0 告警，
> 出现即立即按 `04-rollback.md` 回滚，**不**等 24h 观察期结束。

### 2.1 监控查询样例（OTel + MySQL）

```bash
# 24h 请求成功率
curl -s "${OTEL_QUERY_URL}/api/v1/query" \
  --data-urlencode 'query=sum(rate(http_requests_total{service="agent-service",status=~"2.."}[24h]))
                          / sum(rate(http_requests_total{service="agent-service"}[24h]))'

# 误提单（采购单已 SUBMITTED 但老板事后取消 / 客服反馈错误）
mysql -e "
  SELECT COUNT(*) AS wrong_po
  FROM replenishment_draft
  WHERE status = 'SUBMITTED'
    AND submitted_at >= NOW() - INTERVAL 24 HOUR
    AND draft_id IN (SELECT draft_id FROM agent_runlog WHERE event = 'CUSTOMER_CALLBACK_WRONG_PO')
"
# 期望：0
```

## 3. 切阶段操作步骤

### 3.1 进入灰度（阶段 N → 阶段 N+1）

```bash
# 1) 修改 GRAY_MERCHANT_WHITELIST（K8s）
kubectl set env deploy/agent-service -n storepilot \
  GRAY_MERCHANT_WHITELIST="M-pilot,M-internal,M-clientA"

# 2) rolling update（不重启全部 pod）
kubectl rollout restart deploy/agent-service -n storepilot
kubectl rollout status deploy/agent-service -n storepilot --timeout=120s

# 3) 启动六行绿灯（runbook 01）
kubectl logs -n storepilot deploy/agent-service --tail=20 \
  | grep -E "env-ok|db-ok|mastra-storage-ok|mcp-tools-verified|skill-def-verified|listening :"

# 4) 灰度命中验证（白名单内商家可用 / 名外商家拒绝）
curl -N -H "Authorization: Bearer <sk-agent-PILOT>" \
     -H "Content-Type: application/json" \
     -d '{"model":"store-agent-v1","stream":true,
          "messages":[{"role":"user","content":"今天 S001 卖得怎么样"}]}' \
     https://agent.example.com/v1/chat/completions
# 期望：白名单内 → 正常 SSE；名外 → friendlyMessage("当前功能仅对部分商家开放") + SKILL_NOT_AVAILABLE
```

### 3.2 24h 观察清单（每阶段开始 + 4h / 12h / 24h 各核对一次）

```bash
# 每次核对必跑（运维手册 §5）
# 1. 健康检查
curl -s https://agent.example.com/health/ready
curl -s https://agent.example.com/health/mcp

# 2. 6 项指标抽查（取自 Grafana dashboard "agent-grayscale-stage-N"）
# 3. 误提单计数（必须 0）
mysql -e "<上方 §2.1 SQL>"

# 4. 客户工单（与 CS 团队对齐当日工单单数 / 关键词）
```

### 3.3 阶段不达标 → 不进入下一阶段

- 任一指标跌破阈值且经排查不是临时网络抖动 → **延长观察 24h**；连续 2 个 24h 未恢复 → 回滚到上一阶段。
- 误提单 / 重复提单出现 → 立即回滚到上一阶段（或全量回滚到 v1，按 `04-rollback.md`）。

## 4. P0 触发立即回滚条件

| 信号 | 来源 | 动作 |
| ---- | ---- | ---- |
| 误提单 ≥ 1                                  | 客服 / 客户工单 / 监控规则                    | 立即 `kubectl rollout undo deploy/agent-service`，并按 `04-rollback.md` §1 |
| 重复提单 ≥ 1                                | `agent_runlog` / 监控规则                    | 同上                                                                       |
| MCP 不可用（`/health/mcp` 503 持续 ≥ 3 分钟）| Prometheus alertmanager                     | 同上 + 联动 ERP / Mock 团队                                               |
| `tool_calls` 泄漏（OutputGuard 报错）        | 切片 10 OutputGuard / `agent_runlog`         | 同上 + 安全团队介入                                                       |
| 跨租户拒访次数突增（10 倍基线）              | OTel cross-tenant counter                   | 同上 + 安全团队 + 立即审计 `agent_api_key`                                |
| 写操作失败率 > 1 %                          | 运维手册 §7 P0                               | 同上                                                                       |

## 5. 与切片 19 / 20 的协同

- 灰度命中演练（任务卡 §10 测试场景 1）已在切片 19 E2E 用例 `T-15-strategy-merge` /
  `T-17-tenant-isolation` 自动化覆盖；上线前必跑 `pnpm test:e2e` 全 20 条。
- 优雅停机（切片 20 §8.2）确保 rolling update / rollback 期间在途 SSE 25s 内自然完成；
  K8s `terminationGracePeriodSeconds=35` 必须保留。

## 6. 自检清单（每次进入新阶段必填）

- [ ] 上一阶段已观察满 24h（不少于 1440 分钟）
- [ ] 上一阶段 6 项指标全部达标（误提单 = 0）
- [ ] 启动六行绿灯（runbook 01）齐全
- [ ] `/health` `/health/db` `/health/mcp` `/health/ready` 全 200
- [ ] `GRAY_MERCHANT_WHITELIST` 已确认（kubectl get deploy/... -o yaml | grep GRAY_MERCHANT）
- [ ] 灰度命中样例（白名单内商家正常 / 名外商家 SKILL_NOT_AVAILABLE）已抽样验证
- [ ] CS / 业务 / 老板侧已知会本次切阶段
- [ ] 回滚预案（`04-rollback.md`）已准备
