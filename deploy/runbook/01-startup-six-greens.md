# Runbook 01 — 启动六行绿灯日志（切片 20 / T-OPS-01）

> 版本：V1（切片 20 落地）
> 作用：上线 / 重启 agent-service 时，运维以这 6 行日志为唯一绿灯标志。
> 任意一行缺失 = 部署失败，必须立即回滚或排障。

## 1. 6 行绿灯顺序（任务卡 20 §7 MUST DO §3）

```text
[startup] env-ok                # 切片 01 落地：env zod parse 通过（23 字段）
[startup] db-ok                 # 切片 20 落地：mysql2 SELECT 1 + ≥ 11 张表存在
[startup] mastra-storage-ok     # 切片 07 落地：mastra_workflow_{snapshot,event,suspend} 三表存在
[startup] mcp-tools-verified    # 切片 08 落地：MCP listToolsets == 7 工具白名单（字典序严格相等）
[startup] skill-def-verified    # 切片 21 落地：agent_skill_def 5 行种子 + 必需 Skill 状态校验
[startup] listening :7100       # 切片 20 落地：Hono server.listen 成功
```

历史说明：切片 20 初版只预留 `skill-def-verified` 日志位；当前源码已由切片 21
替换为真实 `verifySkillDef(storagePool)`，会读取 `agent_skill_def` 并校验必需
Skill 已启用 / 灰度行存在。该行缺失或启动失败时，不能再按 stub 处理。

## 2. 一键观察命令

```bash
# 本地 dev
pnpm dev:agent 2>&1 \
  | grep -E "env-ok|db-ok|mastra-storage-ok|mcp-tools-verified|skill-def-verified|listening :"

# Docker compose
docker logs storepilot-agent-service --since 5m \
  | grep -E "env-ok|db-ok|mastra-storage-ok|mcp-tools-verified|skill-def-verified|listening :"

# K8s
kubectl logs -n storepilot deploy/agent-service --tail=50 \
  | grep -E "env-ok|db-ok|mastra-storage-ok|mcp-tools-verified|skill-def-verified|listening :"
```

期望：6 行齐全且按上述顺序出现。

## 3. 缺哪一行 → 排障路径

| 缺失行                    | 根因排查                                                                                                                | 行动                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `env-ok`                  | env zod parse 失败；进程已 `process.exit(1)` + `console.error '[env] 配置错误'`                                          | 看 `[env]` 错误行的 `flatten()` 输出；补齐 `.env.agent.dev` 或 K8s Secret 后重启                  |
| `db-ok`                   | `SELECT 1` 失败 / 表数量 < 11；日志 `[startup] db tables count=<n> < 11`                                                | 跑 `pnpm migrate:up`；确认 `DATABASE_URL` 指向正确 schema；本地用 `docker compose ps mysql`        |
| `mastra-storage-ok`       | `mastra_workflow_{snapshot,event,suspend}` 三张表中任一缺失；日志 `BizError(INTERNAL_ERROR)` 含具体表名                    | 跑切片 03 migration 008/009/010；mysql `SHOW TABLES` 校验                                          |
| `mcp-tools-verified`      | MCP server 不可达（5s 超时） / 工具白名单漂移；日志含 `missing=` 或 `extra=`                                              | 检查 `ERP_MCP_SERVER_URL` 是否可达；检查 mock-server / V2 Spring AI 是否注册了正确的 7 工具       |
| `skill-def-verified`      | `agent_skill_def` 缺行 / 多余行 / 必需 Skill disabled；日志含 missing / extra / disabledRequired 或启动失败               | 跑 migration 011；确认 5 行种子与灰度状态；看 `[startup] bootstrap failed; exiting` 上下文        |
| `listening :7100`         | 端口被占 / OS 限制；Node.js `EADDRINUSE`                                                                                 | `lsof -i :7100`；切环境变量 `PORT` 后重启                                                          |

## 4. 性能门禁

`/health` 必须 P95 < 100ms（任务卡 20 §7 MUST DO §5）。冒烟命令：

```bash
ab -n 1000 -c 10 http://localhost:7100/health
# 期望：Time per request (mean across all concurrent) < 10ms
#       95% percentile latency < 100ms
```

如果超阈：

1. 检查 `/health` 路由是否被中间件接管（CORS / OTel auto-instrument 不应阻塞）。
2. 确认 `/health` 实现里没有任何 IO（DB / MCP / 模型）。看 `packages/agent-service/src/api/health.ts` 第 1 个路由必须只 `c.json({ status: 'UP' })`。

## 5. 关联资料

- `docs/任务卡/I-运维.md` §T-OPS-01.5 §8.3
- `docs/tanks/20-ops-deploy-health-graceful.md` §7 §8.3
- `packages/agent-service/src/server.ts` `bootstrap()` 函数体
- `deploy/k8s/deployment.yaml` livenessProbe / readinessProbe 配置
