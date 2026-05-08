# Runbook 05 — V1 → V2 切真实 ERP（Spring AI MCP Server）SOP（切片 21 / T-OPS-02）

> 版本：V1（切片 21 落地）
> 适用范围：将 `ERP_MCP_SERVER_URL` 从 Node Mock（`http://mcp-mock-server:7300/mcp`）
> 切到真实 Spring AI MCP Server（`http://erp-mcp-prod:8080/mcp`）。
> 关联任务卡：`docs/任务卡/I-运维.md` §T-OPS-02 §5 / §6 / §8.6。
> 关联切片：05（shared-contracts 7 工具 IO + Mock 单源）、08（启动期白名单 + /health/mcp）、
> 17（HITL 写工具）、19（20 条 E2E）、20（部署 / 健康检查）。

## 0. 核心红线（任务卡 §7 MUST DO §3 / §7 MUST NOT §4）

> **零代码改动**：Agent Service 切 V2 时**仅改 `ERP_MCP_SERVER_URL` env**，不动 1 行
> 业务代码、不动 shared-contracts、不动 mcp-mock-server 源码（V1 Mock 进程独立保留）。

> **5 项检查必须全绿**才能切 V2；任何一项不达标都不准切（任务卡 §7 MUST NOT §7）。

## 1. 切换前 5 项检查（必须全绿）

### 1.1 检查 1：工具列表 = 7

```bash
# 拉 V2 真实 MCP Server 的 tools/list；可能要先在内网侧装 mcp-cli 或用 curl
curl -s -X POST "${V2_MCP_URL}" \
  -H 'Content-Type: application/json' \
  -H "X-Tenant-Key: ${MCP_TENANT_SHARED_SECRET}" \
  -H "X-Mcp-Protocol-Version: 2025-06-18" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | jq -r '.result.tools[].name' \
  | sort > /tmp/v2-tools.txt

# shared-contracts 单源（字典序）
node -e "console.log(require('@storepilot/shared-contracts').TOOL_NAMES.join('\n'))" \
  > /tmp/contract-tools.txt

# diff 必须为空
diff /tmp/v2-tools.txt /tmp/contract-tools.txt && echo "OK: tools/list = 7"
```

期望：

```text
createPurchaseOrder
getStoreReportConfig
queryCategorySalesRatio
queryInventoryOverview
queryProductSalesRank
queryReplenishmentBaseData
queryStoreSalesSummary
```

### 1.2 检查 2：每个工具 IO schema 与 shared-contracts 1:1

```bash
# 切片 05 已落地 shared-contracts/mcp Zod schema 单源；V2 暴露的 inputSchema /
# outputSchema 必须 byte-for-byte 等价（容许 description / title 文案差异，不容许字段
# / required / type / enum 差异）。
pnpm exec node tools/consistency-check.mjs --target "${V2_MCP_URL}"
# 期望：所有 7 工具均 OK：MATCH
```

> 若仓库里没有 `--target` 参数支持，使用：
>
> ```bash
> # 用 curl 拉 V2 端 inputSchema 和 shared-contracts dist 做 jq 对比
> for TOOL in createPurchaseOrder getStoreReportConfig queryCategorySalesRatio \
>            queryInventoryOverview queryProductSalesRank queryReplenishmentBaseData \
>            queryStoreSalesSummary; do
>   curl -s -X POST "${V2_MCP_URL}" \
>     -H 'Content-Type: application/json' \
>     -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}" \
>     | jq ".result.tools[] | select(.name==\"$TOOL\") | .inputSchema"
> done
> ```

### 1.3 检查 3：`createPurchaseOrder` 真实端有数据库唯一索引 `(source + sourceDraftId)`

> 这是 R-PO-002 幂等的最后兜底（即使 agent-service 端 idempotencyKey === sourceDraftId
> refine 失效，DB 唯一索引也阻止重复落库）。

```sql
-- 在 ERP 数据库（V2 真实端）跑：
SHOW INDEX FROM purchase_order
WHERE Column_name IN ('source','source_draft_id');
-- 期望：能看到 UNIQUE 索引 (source, source_draft_id) 或类似名字的复合唯一索引。

-- 进一步验证幂等：
INSERT INTO purchase_order (source, source_draft_id, ...)
VALUES ('AI_REPLENISHMENT_AGENT', 'drf_smoke_$(date +%s)', ...);
-- 同样的 source_draft_id 第二次 INSERT 必须 23000 / Duplicate entry
```

### 1.4 检查 4：V2 MCP dry-run + 全量 E2E 口径

```bash
# 1) 指向真实 V2 MCP 和已用 V2 启动的 agent-service（仅测试 / staging）
export V2_MCP_URL="http://erp-mcp-staging:8080/mcp"
export V2_AGENT_BASE_URL="http://agent-service-staging:7100"
export MCP_TENANT_SHARED_SECRET="<staging tenant secret>"
export ERP_MCP_SERVER_URL="${V2_MCP_URL}"

# 2) 真实 V2 MCP dry-run：tools/list=7、schema 存在、/health/mcp=UP
pnpm test:e2e:v2
# 期望：V2 tools/list 精确等于 shared-contracts 7 工具，agent /health/mcp 返回 UP + 7 工具

# 3) 回归 20 条 E2E
# 注意：仓库默认 pnpm test:e2e 是本地 / 进程内 fixture 回归，不能单独证明真实 V2 已接通。
# 若 staging E2E harness 已配置成走真实 V2 agent-service，则在该环境跑：
pnpm test:e2e
# 期望：T-01 .. T-20 全绿；总耗时 < 8 分钟（任务卡 19 §7 MUST DO §3）

# 4) 重点关注
# - T-08..T-11（HITL 4 条）：suspend / resume / 幂等
# - T-12（tool_calls 泄漏）：OutputGuard 必须仍然防住
# - T-19（30 分钟 suspend 过期）
```

### 1.5 检查 5：`/health/mcp` 绿灯

```bash
# agent-service 暂用 V2 URL 启动一次（dry-run / staging）
ERP_MCP_SERVER_URL="${V2_MCP_URL}" pnpm dev:agent &
sleep 5
curl -s http://localhost:7100/health/mcp
# 期望：{"status":"UP","tools":["createPurchaseOrder",..."queryStoreSalesSummary"]}

# 启动六行绿灯第 4 行
grep "[startup] mcp-tools-verified" /tmp/agent-startup.log
# 期望：1 行
```

### 1.6 5 项 check 汇总表

| # | 检查 | 通过判定 | 失败动作 |
| - | ---- | -------- | -------- |
| 1 | `tools/list = 7` 且字典序 = TOOL_NAMES                  | `diff` 无差异        | V2 团队补齐工具；不切 |
| 2 | 每工具 IO schema 与 shared-contracts 1:1                | consistency-check OK | V2 团队修 schema；不切 |
| 3 | `createPurchaseOrder` DB 有 `(source + sourceDraftId)` UNIQUE | `SHOW INDEX` 命中    | DBA 加索引；不切 |
| 4 | V2 dry-run + E2E 20 条全绿                               | `pnpm test:e2e:v2` OK；staging V2 E2E OK | 修复缺陷；不切 |
| 5 | `/health/mcp` 绿灯                                      | 200 + 7 工具         | 网络 / Auth / 协议；不切 |

## 2. 切换动作（Agent Service 零代码改动）

### 2.1 步骤

```bash
# 1) 发布 Spring AI MCP Server 到内网（V2 团队负责）

# 2) 更新 agent-service 环境变量（K8s）
kubectl set env deploy/agent-service -n storepilot \
  ERP_MCP_SERVER_URL="http://erp-mcp-prod:8080/mcp"
# Compose
sed -i.bak 's|ERP_MCP_SERVER_URL=http://mcp-mock-server:7300/mcp|ERP_MCP_SERVER_URL=http://erp-mcp-prod:8080/mcp|' .env.agent.prod

# 3) Rolling update（切片 20 优雅停机：在途 SSE 25s 完成）
kubectl rollout restart deploy/agent-service -n storepilot
kubectl rollout status deploy/agent-service -n storepilot --timeout=120s

# 4) 启动期 verifyMcpToolsAtStartup 严格校验 7 工具白名单（切片 08）
kubectl logs -n storepilot deploy/agent-service --tail=20 \
  | grep -E "env-ok|db-ok|mastra-storage-ok|mcp-tools-verified|skill-def-verified|listening :"
# 期望：6 行齐全；任意一行缺失 = 切换失败 → 回退（§3）

# 5) 灰度先单商家 24h（GRAY_MERCHANT_WHITELIST=M-pilot），按 03-grayscale-release.md 阶段 3
#    无 P0 告警 → 进入阶段 4 → … → 全量
```

### 2.2 验收（切换后 5 分钟内）

- [ ] 启动六行绿灯齐全（runbook 01）
- [ ] `/health/mcp` 200 + 7 工具
- [ ] `/health/ready` 200
- [ ] OTel：`mcp.tool` span 的 `peer.address` 已经是 V2 域名
- [ ] 抽 1 条真实读请求（非写）→ SSE 正常响应
- [ ] 一段灰度 24h 监控指标：误提单 = 0 / MCP 调用成功率 ≥ 95 %

## 3. 回退动作（如有 P0）

> **MUST NOT（任务卡 §7 MUST NOT §5）**：已经创建到 V2 真实 ERP 的采购单
> **不得程序化撤销**；必须通知 ERP 侧手动审批撤销。

### 3.1 立即切回 Mock / 上一稳定 V2

```bash
# 1) ERP_MCP_SERVER_URL 切回 Mock（或上一稳定 V2 build）
kubectl set env deploy/agent-service -n storepilot \
  ERP_MCP_SERVER_URL="http://mcp-mock-server:7300/mcp"
kubectl rollout restart deploy/agent-service -n storepilot
kubectl rollout status deploy/agent-service -n storepilot --timeout=120s

# 2) 验证启动六行绿灯 + /health/mcp 回到 Mock
curl -s http://localhost:7100/health/mcp | jq .
```

### 3.2 真实采购单的处理

| 状况 | 动作 | 责任方 |
| ---- | ---- | ------ |
| V2 切换期间 createPurchaseOrder 已成功落 ERP                  | 通知 ERP 团队按工单审批撤销；agent-service 在 `agent_runlog` 写补偿事件 | ERP / 运维 |
| draftStatus = SUBMITTED 但客户反馈错误                        | 同上；不能 SQL 撤销 SUBMITTED 行（保留资金 / 库存追溯）              | ERP / CS   |
| draftStatus = WAIT_CONFIRM / DRAFT（尚未 submit）             | ConfirmManager.cancelInflight 或老板取消；agent-service 侧操作 OK   | agent-service |

## 4. 与切片 19 / 20 协同

- 切片 19 `T-08..T-11`（HITL 4 条）必须在 V2 fixture 下连续跑通；切前必跑。
- 切片 19 `T-16-mcp-whitelist`（缺工具启动失败）保证：如果 V2 端有任何工具缺失，
  agent-service 启动会在 mcp-tools-verified 这一行报错并 `process.exit(1)`，
  绝不让"半残"的 V2 端进入业务（任务卡 §10 测试场景 7）。
- 切片 20 `terminationGracePeriodSeconds=35` + 优雅停机保证 V2 切换的 rolling
  update 不会打断在途 SSE。

## 5. 自检清单（切前必填）

- [ ] V2 团队已发布 Spring AI MCP Server（地址、TLS、ACL 已确认）
- [ ] 5 项检查全部 PASS（§1.1 - §1.5）
- [ ] 灰度计划准备好（先 1 商家 24h；按 `03-grayscale-release.md`）
- [ ] 回退动作演练过（§3）
- [ ] CS / 业务 / 财务侧已知会 V2 切换窗口（含真实采购单可能产生）
- [ ] 切换执行人 + 复核人 + oncall 名单已对齐
