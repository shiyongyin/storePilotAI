# Runbook 02 — SIGTERM 优雅停机 SOP（切片 20 / T-OPS-01）

> 版本：V1（切片 20 落地）
> 作用：上线灰度 / 回滚 / K8s rolling update / 手动重启 agent-service 时，
>       保证正在跑的 SSE 长连接（日报 / 月报 / 补货）能平滑收尾，不让用户看到半截 markdown。

## 1. 优雅停机 5 步（任务卡 20 §7 MUST DO §4）

```text
SIGTERM
  ├─ 1. logger.info '[shutdown] SIGTERM received'
  ├─ 2. server.close()                                # 阻止接受新连接
  ├─ 3. waitForActiveStreams({ timeoutMs: 25_000 })   # 给现有 SSE 25s 完成
  ├─ 4. abortAllInflight()                            # 仍未完成的强制 abort（LLM/MCP）
  ├─ 5. disposeMcpClient()                            # 释放 MCPClient 单例
  ├─ 6. stopExpire*Cron / stopCompensateMarkSubmittedCron()
  ├─ 7. closeMysqlStoragePool()                       # mysql2 pool.end()
  └─ 8. logger.info '[shutdown] graceful exit' + process.exit(0)
```

K8s `terminationGracePeriodSeconds` 必须 ≥ 35（25s SSE + 10s 保险），见
`deploy/k8s/deployment.yaml`。

## 2. 关键约束（违反即拒收）

1. **绝不**在 SIGTERM 立即 `process.exit(0)`（任务卡 §7 MUST NOT §2）；业务 SSE 需平滑收尾。
2. **绝不**让 SIGTERM 回调里的异常冒泡冒出（每步用 try/catch 兜底，全部失败也要保证 `process.exit`）。
3. **绝不**在 K8s 把 `terminationGracePeriodSeconds < 35`（25s SSE + 10s 保险不够 = SSE 被 kill -9 截断）。
4. **绝不**让 readiness 在 SIGTERM 后再返回 UP（K8s preStop sleep 5s 让 endpoint 摘流量先于业务清理）。

## 3. 验证流程

### 3.1 本地 dev 模拟

```bash
# 终端 A：启动 agent
pnpm dev:agent &
PID=$!

# 终端 B：发起一个长 SSE 请求（30s 业务）
curl -N -H "Authorization: Bearer sk-agent-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"store-agent-v1","stream":true,"messages":[{"role":"user","content":"出本月经营月报"}]}' \
  http://localhost:7100/v1/chat/completions \
  > /tmp/long-sse.log &

# 终端 A：等 5s 后发 SIGTERM
sleep 5
kill -TERM $PID
wait $PID
echo "exit code: $?"

# 期望：
#   - 25s 内进程退出码 0
#   - /tmp/long-sse.log 含完整 markdown + 'data: [DONE]'
#   - agent stdout 含：
#       [shutdown] SIGTERM received
#       [shutdown] waiting for active streams (active=1)
#       [shutdown] disposeMcpClient ok
#       [shutdown] graceful exit
```

### 3.2 K8s 滚动升级模拟

```bash
# 模拟升级
kubectl -n storepilot rollout restart deploy/agent-service

# 观察 termination 期间业务 SSE
kubectl -n storepilot logs -f deploy/agent-service \
  | grep -E "shutdown|active streams"

# 期望：
#   - 旧 pod 在 endpoint 摘除（preStop sleep 5s）后才收 SIGTERM
#   - 30s 内退出码 0；新 pod 已就绪（readiness UP）后才接流量
#   - kubectl rollout status 不超过 60s
```

## 4. HTTP/2 警告（任务卡 §7 MUST DO §7）

LobeChat ↔ Agent 必须 **HTTP/1.1**：

- HTTP/2 默认 32KB buffer；buffer 满才下发，破坏 SSE 实时体验。
- HTTP/2 与 `chunked_transfer_encoding off` 互相干扰。

`deploy/nginx.conf` 已显式 `http2 off` + `proxy_http_version 1.1`；浏览器 → Nginx
段可以 HTTP/2，但 Nginx → Agent 段必须 HTTP/1.1。

如果上线后用户反馈"日报要等 60s 才一次性出现"：

1. 检查 Nginx access log 的 `request_protocol`，必须 `HTTP/1.1`。
2. 检查 `proxy_buffering off` / `chunked_transfer_encoding off` 是否被覆盖。
3. 直连 `http://agent-service:7100/v1/chat/completions` 验证业务侧 chunk 真实下发，
   把问题边界缩小到反代层。

## 5. 故障兜底

| 现象                                                 | 排查                                                                                                                | 缓解                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| SIGTERM 后进程 35s 仍未退出 → kubelet `kill -9`       | `disposeMcpClient` / `pool.end()` 卡住；看 `[shutdown] disposeMcpClient` 是否打印                                    | 当前实现 25s 等待 + 强制 abort；如卡死，`stop_grace_period` 可拉到 45s 临时缓解，根因仍要修复     |
| SIGTERM 后业务 SSE 收到半截 markdown                  | `chat-completions.ts` finally 阶段忘记 unregister；或 `abortAllInflight` 触发后业务忽略 abortSignal 仍然在写流          | 检查 dispatcher 是否 honor `abortController.signal`；检查 `unregisterActiveStream` 是否被调用      |
| K8s `endpoint` 在 SIGTERM 后仍接到新流量              | preStop sleep 太短 / readinessProbe period 太长                                                                      | preStop sleep 5s（已默认）；readiness `periodSeconds: 5`（已默认）                                |
| `/health/ready` 在停机阶段还返 UP                    | server.close 后端口仍 listen / app 仍能 handle / health 路由未受 shutdown 影响                                       | 任务卡 §10：preStop sleep 5s 期间 readiness 自然失败；不需要业务侧再标志 `shuttingDown`           |

## 6. 关联资料

- `docs/任务卡/I-运维.md` §T-OPS-01.5 §8.4
- `docs/tanks/20-ops-deploy-health-graceful.md` §8.2 §8.3
- `packages/agent-service/src/server.ts` shutdown 实现
- `packages/agent-service/src/safety/active-streams.ts` SSE 注册 / 等待 / abort
- `deploy/k8s/deployment.yaml` `terminationGracePeriodSeconds` + preStop hook
