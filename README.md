# 门店助手 Agent V1 — Monorepo

> 基于 [docs/tanks/](./docs/tanks/) 21 切片任务卡执行的工程基线。本仓库当前已完成 **切片 01(infra-monorepo-env)** + **切片 02(infra-docker-compose)**。

## 工程结构

```
storePilotAI/
├── packages/
│   ├── agent-service/         # @storepilot/agent-service — 主服务(Hono + env zod + pino)
│   │   └── Dockerfile         # 多阶段(deps/build/runtime) + 非 root user app(切片 02)
│   ├── mcp-mock-server/       # @storepilot/mcp-mock-server — Mock(切片 05 完整化)
│   │   └── Dockerfile         # 多阶段 + 非 root(切片 02);仅 dev/CI,生产不打此镜像
│   └── shared-contracts/      # @storepilot/shared-contracts — Zod 契约(切片 04/05 完整化)
├── tools/
│   ├── api-key-issuer/        # sk-agent-* 颁发 CLI(切片 09)
│   ├── seed-strategy/         # 商家策略种子(切片 11)
│   └── migrate-runner/        # MySQL 迁移(切片 03)
├── docs/                      # 21 切片任务卡 + prompt + 上游设计文档
├── docker-compose.dev.yml     # 五件套本地编排(切片 02)
├── .env.agent.dev             # agent-service 容器 env 模板(切片 02)
├── .env.mock.dev              # mcp-mock-server 容器 env 模板(切片 02)
├── .env.lobechat.dev          # LobeChat 容器 env 模板(切片 02)
├── tsconfig.base.json         # TS 严格模式 13 项配置(全 workspace 继承)
├── .eslintrc.cjs              # V2.1 红线 5 条规则
└── pnpm-workspace.yaml        # packages/* + tools/*
```

## 一、启动

需要 **Node 22.x LTS**(≥ 22.13.0, < 23)+ **pnpm ≥ 9.7**。

```bash
# 1. 工具链
nvm use                                 # 自动读取 .nvmrc(22)
corepack enable
corepack prepare pnpm@9.7.0 --activate

# 2. 安装依赖
pnpm install --frozen-lockfile

# 3. 配置 env(切片 01 仅启动壳;切片 03 后才能跑 DB 相关功能)
cp packages/agent-service/.env.example packages/agent-service/.env
# 编辑 packages/agent-service/.env,至少填:
#   DATABASE_URL / MODEL_BASE_URL / MODEL_API_KEY / MODEL_NAME
#   ERP_MCP_SERVER_URL / MCP_TENANT_SHARED_SECRET(≥32 字符)
#   AGENT_API_KEY_HASH_SALT(≥16 字符) / CORS_ALLOWED_ORIGINS

# 4. 启动 agent-service(仅 /health,业务路由属切片 09/10)
pnpm dev:agent
```

## 二、测试

```bash
# 工程化质量门(切片 01 验收)
pnpm install --frozen-lockfile          # 0 errors
pnpm lint                               # ESLint 5 红线 + TS 类型检查
pnpm -r exec tsc --noEmit               # TS strict 四件套
pnpm -r run build                       # 三 workspace 各产出 dist/

# pino redact 单测
pnpm --filter @storepilot/agent-service test

# 一致性 grep(0 命中)
rg -n 'experimental_createMCPClient|streamText.*maxSteps' packages/
rg -n 'process\.env\.' packages/agent-service/src --glob '!**/config/env.ts'
```

## 三、Smoke

```bash
# /health 冒烟
pnpm dev:agent &
sleep 2
curl -s http://localhost:7100/health
# 期望输出:{"status":"UP"}
kill %1

# env 缺失 fail-fast(必须退出码 1)
unset MODEL_API_KEY && pnpm dev:agent ; echo $?

# 生产 CORS 保护(必须退出码 1)
NODE_ENV=production CORS_ALLOWED_ORIGINS=* pnpm dev:agent ; echo $?

# PORT 类型错误(必须退出码 1)
PORT=abc pnpm dev:agent ; echo $?
```

启动期会输出运维 6 行绿灯的第 1 行 `[startup] env-ok` 与第 6 行 `[startup] listening :<port>`;
其余 4 行(`db-ok` / `mastra-storage-ok` / `mcp-tools-verified` / `skill-def-verified`)
分别由切片 03 / 07 / 08 / 20 落地。

---

---

## 四、Docker Compose 五件套(切片 02)

```bash
# 0) 复制三个 env 模板;若需保留个人 secret,复制为 .env.*.dev.local 并 git skip-worktree
ls .env.agent.dev .env.mock.dev .env.lobechat.dev

# 1) 构建 + 启动五件套(MySQL → mcp-mock → agent-service → LobeChat;依赖关系 service_healthy 兜底)
docker compose -f docker-compose.dev.yml up -d --build

# 2) 等 30s,健康检查
sleep 30
docker compose -f docker-compose.dev.yml ps     # 期望全部 (healthy)
curl -s http://localhost:7100/health             # {"status":"UP"}
curl -s http://localhost:7300/health             # {"status":"UP"} (切片 05 完整化为 toolCount:7)
curl -s -I http://localhost:3210                 # 200

# 3) 启动顺序硬约束(关 mysql → /health/db 503 / liveness 仍 UP)
docker compose -f docker-compose.dev.yml stop mysql
sleep 3
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:7100/health/db   # 期望 503

# 4) 业务真相隔离(LobeChat Postgres 不得有 agent_api_key)
docker compose -f docker-compose.dev.yml exec lobechat-postgres \
  psql -U postgres lobechat -c '\dt agent_api_key'
# 期望:Did not find any relation named "agent_api_key".

# 5) Dockerfile 非 root
docker compose -f docker-compose.dev.yml exec agent-service whoami        # app

# 6) LobeChat 浏览器(无 /v1/v1 重复 404)
open http://localhost:3210
```

> **生产 compose 不在本切片交付**。生产部署属切片 20;**生产环境必须不启用 mcp-mock-server**(由真实 ERP MCP 替代);
> Nginx 反代 / SSL / 优雅停机参数(`terminationGracePeriodSeconds >= 35`)由切片 20 完整化。

---

## 切片状态

| #  | 切片                              | 状态     | 备注                                              |
| -- | --------------------------------- | -------- | ------------------------------------------------- |
| 01 | infra-monorepo-env                | ✅ 完成  | 工程基线 + env 23 字段 + redact 5 路径            |
| 02 | infra-docker-compose              | ✅ 完成  | 五件套 compose + 双 Dockerfile + 三 env 模板      |
| 03-21 | 见 [docs/tanks/README.md](./docs/tanks/README.md) | 待执行 | 每切片单次对话,严禁混入 |

详细 SSOT:
- 切片 01: [docs/tanks/01-infra-monorepo-env.md](./docs/tanks/01-infra-monorepo-env.md)
- 切片 02: [docs/tanks/02-infra-docker-compose.md](./docs/tanks/02-infra-docker-compose.md)
