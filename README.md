# StorePilotAI 门店助手 Agent V1

StorePilotAI 是面向门店经营场景的 AI Agent 后端。它把 LobeChat 或其他 OpenAI 兼容客户端接入到一个受控的 Agent 服务中，由 Agent 识别用户意图、调用 ERP MCP 工具、读取 MySQL 中的策略和业务状态，并以 Markdown/SSE 形式返回日报、月报、补货建议、补货调整和采购单确认结果。

这个仓库适合三类人阅读：

- 业务：了解系统能解决哪些门店经营问题，以及哪些动作需要人工确认。
- 产品：理解 V1 的能力边界、交互链路和安全约束。
- 开发：按本文步骤在本地启动服务、跑测试、执行迁移、签发 API Key，并理解各包职责。

## 当前能力

### 业务能力

| 能力 | 说明 | 风险控制 |
| --- | --- | --- |
| 门店日报 | 汇总门店销售、品类占比、商品排行和库存概况，输出经营摘要与指标卡片。 | 只读 ERP 数据，不写业务系统。 |
| 门店月报 | 拉取当月与对比周期数据，生成月度经营摘要、异常洞察和数据源摘要。 | 缺失数据会降级展示，不伪造指标。 |
| 补货预测 | 基于 ERP 补货基础数据、库存、销量和商家策略生成补货草稿。 | 草稿落库，采购单不会自动创建。 |
| 补货调整 | 根据用户指令调整已有补货草稿，并记录调整日志。 | 每次调整写入审计日志，受策略上限约束。 |
| 采购单创建确认 | 用户确认后通过 MCP 写工具创建采购单。 | HITL 人工确认，V1 禁止自动采购。 |
| 经营问答 / 指标解释 | 回答通用经营问题或解释指标含义。 | 输出经过桥接层和安全校验。 |

### Agent 能力边界

系统识别 11 类意图：

- `BUSINESS_DAILY_REPORT`
- `BUSINESS_MONTHLY_REPORT`
- `REPLENISHMENT_PLAN`
- `ADJUST_REPLENISHMENT_DRAFT`
- `CONFIRM_CREATE_PURCHASE_ORDER`
- `CANCEL_REPLENISHMENT_DRAFT`
- `COLLECT_REQUIREMENT`
- `GENERAL_QA`
- `EXPLAIN_METRIC`
- `MULTI_INTENT`
- `UNKNOWN`

V1 明确不做：

- 不允许模型直接发起工具调用给客户端。
- 不允许客户端传入 `tools` / `tool_choice` / `functions` / `function_call` / `response_format`。
- 不允许自动创建采购单，写操作必须经过用户确认。
- 生产环境不运行 `mcp-mock-server`，必须接真实 ERP MCP 服务。
- Liveness 不依赖 DB、MCP 或模型，避免外部抖动导致容器反复重启。

## 系统架构

```text
LobeChat / OpenAI-compatible client
        |
        | POST /v1/chat/completions
        v
packages/agent-service
  - Hono HTTP server
  - OpenAI Chat Completions compatible SSE bridge
  - API Key auth and tenant context
  - Intent classifier and Mastra workflows
  - Safety guards, HITL, strategy engine
        |
        | MCP Streamable HTTP
        v
ERP MCP server
  - dev: packages/mcp-mock-server
  - prod: real ERP MCP endpoint
        |
        v
MySQL 8
  - agent_api_key
  - agent_skill_def
  - agent_* run logs and sessions
  - replenishment_draft and adjustment logs
  - mastra_workflow_* state
```

## Monorepo 结构

```text
storePilotAI/
├── packages/
│   ├── agent-service/          # 主服务：Hono + Mastra + MCP + MySQL + SSE bridge
│   ├── mcp-mock-server/        # 开发和测试用 ERP MCP mock，生产禁用
│   └── shared-contracts/       # Zod 契约、Intent、Skill、Strategy、MCP tool contracts
├── tools/
│   ├── api-key-issuer/         # sk-agent-* API Key 签发 CLI
│   ├── migrate-runner/         # MySQL migration runner
│   └── seed-strategy/          # 商家 / 门店策略种子 CLI
├── migrations/                 # MySQL DDL 和初始种子
├── deploy/
│   ├── docker-compose.prod.yml # 生产 compose：agent-service + nginx
│   ├── k8s/                    # Kubernetes deployment / service
│   └── runbook/                # 运维 runbook
├── docker-compose.dev.yml      # 本地开发编排：MySQL / MCP mock / Agent / LobeChat
├── vitest.workspace.ts         # Vitest workspace 项目配置
├── package.json                # 根脚本和工具链版本
└── pnpm-workspace.yaml         # packages/* + tools/*
```

## 技术栈

| 领域 | 技术 |
| --- | --- |
| Runtime | Node.js 22.13.x, pnpm 9.7.x, TypeScript ESM |
| HTTP | Hono, OpenAI Chat Completions compatible SSE |
| Agent / Workflow | Mastra 1.0, AI SDK |
| MCP | `@mastra/mcp`, MCP Streamable HTTP, 7 工具白名单 |
| 数据库 | MySQL 8, mysql2, Umzug migrations |
| 契约 | Zod 4, `@storepilot/shared-contracts` |
| 鉴权 | `sk-agent-*` API Key, argon2id hash, server pepper |
| 可观测性 | pino, traceId, OpenTelemetry optional |
| 测试 | Vitest workspace, integration tests, E2E, coverage gates |
| 本地 UI | LobeChat client mode |

## 前置要求

- Node.js `>=22.13.0 <23`
- pnpm `>=9.7.0 <10`
- Docker Desktop 或兼容 Docker Compose
- MySQL 8，本地推荐直接使用 `docker-compose.dev.yml` 的 `mysql` 服务

建议使用仓库内 `.nvmrc`：

```bash
nvm use
corepack enable
corepack prepare pnpm@9.7.0 --activate
pnpm install --frozen-lockfile
```

## 本地快速启动

本地启动建议分两段：先启动 MySQL 和 MCP mock，完成迁移后再启动 agent-service。agent-service 启动期会校验 MySQL 表数量、Mastra 存储表、MCP 7 工具白名单和 skill 定义；如果迁移未执行，直接 `docker compose up` 会导致 agent-service 健康检查失败。

### AI 辅助启动

新人不需要手工理解下面所有命令。把这句话发给 AI 即可：

```text
请先阅读 AI_LOCAL_BOOTSTRAP.md，然后用交互方式问我缺少的配置。等我提供配置后，你负责创建本地 env、启动 Docker Compose、执行 migration、签发本地 API Key、启动 LobeChat，并给出健康检查结果。不要提交 .env 文件，不要在最终报告展示完整 Key。
```

AI 会按 [AI_LOCAL_BOOTSTRAP.md](./AI_LOCAL_BOOTSTRAP.md) 执行。新人只需要准备：

- GitHub 仓库访问权限。
- 本地目录。
- DeepSeek API Key。模型地址固定为 `https://api.deepseek.com/v1`，模型名固定为 `deepseek-chat`，新人不需要填写。
- LobeChat 本地访问码。
- 本地测试用 `merchantId`、`storeId`、`userId`。
- 授权 AI 安装依赖、启动 Docker、创建本地 `.env.*.dev` 文件、执行 migration 和签发 API Key。

### 1. 准备本地环境文件

`.env.*.dev` 属于本地密钥文件，默认不纳入 Git。首次启动需要在仓库根创建下面 3 个文件。

`./.env.agent.dev`：

```dotenv
NODE_ENV=development
PORT=7100
DATABASE_URL=mysql://root:rootpw@mysql:3306/store_pilot?timezone=Z&dateStrings=true&supportBigNumbers=true&bigNumberStrings=true&charset=utf8mb4&decimalNumbers=true

MODEL_PROVIDER=openai-compatible
MODEL_BASE_URL=https://api.deepseek.com/v1
MODEL_API_KEY=sk-change-me-deepseek
MODEL_NAME=deepseek-chat
MODEL_TIMEOUT_MS=25000
MAX_OUTPUT_TOKENS=4096
MAX_TOOL_CALLS_PER_REQUEST=8

ERP_MCP_SERVER_URL=http://mcp-mock-server:7300/mcp
MCP_TENANT_SHARED_SECRET=change-me-32-char-secret-xxxxxxxxxx
MCP_PROTOCOL_VERSION=2025-06-18
TOOL_CALL_TIMEOUT_MS=15000

DB_POOL_MAX=20
DB_QUEUE_LIMIT=200
AGENT_API_KEY_HASH_SALT=change-me-16char-minimum
AGENT_API_KEY_PREFIX=sk-agent-
CORS_ALLOWED_ORIGINS=http://localhost:3210,http://localhost:3000
USER_MESSAGE_MAX_CHARS=4000
SUSPEND_TTL_MINUTES=30
RETENTION_DAYS_RUN_LOG=180
NUMBER_CONSISTENCY_CHECK_ENABLED=true
GRAY_MERCHANT_WHITELIST=
```

`./.env.mock.dev`：

```dotenv
NODE_ENV=development
PORT=7300
MCP_TENANT_SHARED_SECRET=change-me-32-char-secret-xxxxxxxxxx
MCP_PROTOCOL_VERSION=2025-06-18
MCP_TOOL_TIMEOUT_MS=15000
MCP_ENABLE_WRITE_TOOLS=true
MCP_ALLOWED_HOSTS=localhost:7300,127.0.0.1:7300,mcp-mock-server:7300
MCP_CORS_ORIGIN=*
FIXTURE_PROFILE=happy-path
```

`./.env.lobechat.dev`：

```dotenv
APP_URL=http://localhost:3210
ACCESS_CODE=storepilot
KEY_VAULTS_SECRET=change-me-base64-32bytes-xxxxxxxxxxxxxxxxxxxxxxxx==
NEXT_AUTH_SECRET=dev-nextauth-secret-32chars-xxxxxxxxxxxx
NEXTAUTH_SECRET=dev-nextauth-secret-32chars-xxxxxxxxxxxx
AUTH_SECRET=dev-nextauth-secret-32chars-xxxxxxxxxxxx
S3_ENDPOINT=http://localhost:3210
S3_PUBLIC_DOMAIN=http://localhost:3210

OPENAI_PROXY_URL=http://agent-service:7100/v1
OPENAI_API_KEY=sk-agent-replace-after-issue
DEFAULT_AGENT_CONFIG=model=store-agent-v1;provider=openai
CUSTOM_MODELS=+store-agent-v1

ENABLED_OPENAI_VISION=0
ENABLED_TTS=0
ENABLED_PLUGINS=0
ENABLED_FUNCTION_CALLING=0
PORT=3210
```

注意：

- `MCP_TENANT_SHARED_SECRET` 在 agent 和 mock 中必须一致。
- `MODEL_API_KEY` 使用新人提供的 DeepSeek API Key，本地不要提交。
- `OPENAI_API_KEY` 后续用 `pnpm issue:apikey` 生成的 `sk-agent-*` 替换。

### 2. 启动 MySQL 和 MCP mock

```bash
docker compose -f docker-compose.dev.yml up -d mysql mcp-mock-server
```

确认基础服务健康：

```bash
docker compose -f docker-compose.dev.yml ps
curl http://localhost:7300/health
```

### 3. 执行数据库迁移

迁移命令在宿主机执行，因此 `DATABASE_URL` 使用 `127.0.0.1`：

```bash
DATABASE_URL='mysql://root:rootpw@127.0.0.1:3306/store_pilot?timezone=Z&dateStrings=true&supportBigNumbers=true&bigNumberStrings=true&charset=utf8mb4&decimalNumbers=true' \
pnpm migrate:up
```

当前迁移会创建 Agent、补货草稿、API Key、Session、Mastra workflow state 等表，并写入平台默认策略和 skill 定义种子。

### 4. 签发本地 API Key

```bash
DATABASE_URL='mysql://root:rootpw@127.0.0.1:3306/store_pilot?timezone=Z&dateStrings=true&supportBigNumbers=true&bigNumberStrings=true&charset=utf8mb4&decimalNumbers=true' \
AGENT_API_KEY_HASH_SALT='change-me-16char-minimum' \
pnpm issue:apikey -- --merchantId M001 --storeId S001 --userId boss-001 --ttlDays 90
```

命令会打印一次明文 `sk-agent-*`。把它填入 `./.env.lobechat.dev` 的 `OPENAI_API_KEY`。数据库只保存 argon2id hash，不保存明文。

### 5. 启动 Agent 和 LobeChat

```bash
docker compose -f docker-compose.dev.yml up -d agent-service lobechat
```

访问入口：

| 服务 | 地址 | 用途 |
| --- | --- | --- |
| Agent liveness | `http://localhost:7100/health` | 进程存活 |
| Agent readiness | `http://localhost:7100/health/ready` | DB + MCP 聚合就绪 |
| MCP mock health | `http://localhost:7300/health` | Mock ERP 工具健康 |
| LobeChat | `http://localhost:3210` | 本地对话 UI |

LobeChat 首次进入会要求访问码，使用你在 `.env.lobechat.dev` 中设置的 `ACCESS_CODE`。

## 纯本地进程启动

如果不想让 agent-service 跑在容器里，也可以只用 Docker 启动 MySQL 和 MCP mock，然后在宿主机启动服务：

```bash
docker compose -f docker-compose.dev.yml up -d mysql

cp packages/mcp-mock-server/.env.example packages/mcp-mock-server/.env
node --env-file=packages/mcp-mock-server/.env --import tsx packages/mcp-mock-server/src/server.ts
```

另开一个终端：

```bash
cp packages/agent-service/.env.example packages/agent-service/.env
# 编辑 packages/agent-service/.env:
# - DATABASE_URL 使用 127.0.0.1:3306
# - ERP_MCP_SERVER_URL 使用 http://localhost:7300/mcp
# - MCP_TENANT_SHARED_SECRET 与 mock 一致
# - MODEL_* 填真实模型服务

node --env-file=packages/agent-service/.env --import tsx tools/migrate-runner/src/migrate.ts up
node --env-file=packages/agent-service/.env --import tsx tools/api-key-issuer/src/issue.ts --merchantId M001 --storeId S001 --userId boss-001
node --env-file=packages/agent-service/.env --import tsx packages/agent-service/src/server.ts
```

## API 使用示例

Agent 对外暴露 OpenAI 兼容接口：

```bash
curl http://localhost:7100/v1/chat/completions \
  -H 'Authorization: Bearer sk-agent-your-key' \
  -H 'Content-Type: application/json' \
  -H 'X-Trace-Id: trace_01HZ0000000000000000000000' \
  -d '{
    "model": "store-agent-v1",
    "stream": true,
    "messages": [
      { "role": "user", "content": "帮我看一下今天门店日报" }
    ]
  }'
```

响应为 `text/event-stream`，兼容 OpenAI Chat Completions streaming chunk，并最终发送 `data: [DONE]`。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm build` | 构建所有 workspace 包。 |
| `pnpm lint` | 执行 ESLint。 |
| `pnpm typecheck` | 执行 TypeScript 类型检查。 |
| `pnpm test` | 根级 canonical 集成测试入口，内部调用 Vitest。 |
| `pnpm test:integration` | 与 `pnpm test` 等价。 |
| `pnpm test:cov` | 全量 coverage 测试。 |
| `pnpm cov:check` | 覆盖率 3 档门禁：bridge >= 95%、safety >= 90%、workflows >= 80%。 |
| `pnpm check:consistency` | 一致性 grep 门禁，防止关键红线漂移。 |
| `pnpm test:e2e` | E2E 回归，使用真实 MySQL、进程内 MCP mock 和 HTTP 入口。 |
| `pnpm migrate:up` | 执行 pending migrations。 |
| `pnpm migrate:down -- --dry-run` | 输出回滚 SQL，不直接删表。 |
| `pnpm issue:apikey -- --merchantId M001 --storeId S001 --userId boss-001` | 签发本地或测试用 API Key。 |
| `pnpm dev:agent` | 启动 agent-service 开发进程。 |
| `pnpm dev:mcp` | 启动 mcp-mock-server 开发进程。 |

## 测试与质量门禁

Vitest workspace 覆盖 6 个项目：

- `packages/shared-contracts`
- `packages/agent-service`
- `packages/mcp-mock-server`
- `tools/api-key-issuer`
- `tools/migrate-runner`
- `tools/seed-strategy`

PR CI 的主门禁：

1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test:cov`
4. `pnpm check:consistency`
5. `pnpm cov:check`

`main` 分支 push 后会触发 E2E 工作流，执行 `pnpm migrate:up` 和 `pnpm test:e2e`。

本地跑 MySQL 集成测试时，推荐显式设置：

```bash
MYSQL_TEST_URL='mysql://root:rootpw@127.0.0.1:3306' \
DATABASE_URL='mysql://root:rootpw@127.0.0.1:3306/store_pilot' \
pnpm test
```

## 数据库

迁移目录：`migrations/`

核心表域：

- `agent_api_key`：API Key hash、租户、门店、用户、状态和过期时间。
- `agent_skill_def`：skill 定义、风险等级、启用 / 禁用 / 灰度状态。
- `agent_merchant_strategy` / `agent_store_strategy`：商家和门店策略。
- `replenishment_draft`：补货草稿、状态、明细、过期时间。
- `replenishment_adjustment_log`：补货调整审计日志。
- `agent_session`：会话、HITL active run、active draft。
- `agent_run_log` / `agent_skill_run_log`：运行日志。
- `mastra_workflow_snapshot` / `mastra_workflow_event` / `mastra_workflow_suspend`：Mastra workflow 状态。

迁移原则：

- `up` 可重复执行。
- 生产环境禁止直接执行破坏性 `down`，只允许 `--dry-run` 输出可审阅 SQL。
- JSON 字段用于保存结构化业务状态，业务判断尽量放在 TypeScript 层。

## CLI 工具

### API Key issuer

```bash
DATABASE_URL='mysql://root:rootpw@127.0.0.1:3306/store_pilot' \
AGENT_API_KEY_HASH_SALT='change-me-16char-minimum' \
pnpm issue:apikey -- --merchantId M001 --storeId S001 --userId boss-001 --ttlDays 90
```

行为：

- 生成 `sk-agent-*` 明文。
- 使用 argon2id + `AGENT_API_KEY_HASH_SALT` 做 hash。
- 明文只在命令行打印一次。
- DB 中只保存 hash 和前缀。

### Migration runner

```bash
DATABASE_URL='mysql://root:rootpw@127.0.0.1:3306/store_pilot' pnpm migrate:up
DATABASE_URL='mysql://root:rootpw@127.0.0.1:3306/store_pilot' pnpm migrate:down -- --dry-run
```

### Strategy seed

```bash
DATABASE_URL='mysql://root:rootpw@127.0.0.1:3306/store_pilot' \
pnpm --filter @storepilot/tools-seed-strategy start -- --file strategy.json --dry-run
```

输入 JSON 支持单条或数组。`strategyJson` 必须通过 `StrategySchema` 校验。

## MCP 工具白名单

Agent 启动时会校验 ERP MCP server 暴露的工具集合必须严格等于以下 7 个工具：

- `createPurchaseOrder`
- `getStoreReportConfig`
- `queryCategorySalesRatio`
- `queryInventoryOverview`
- `queryProductSalesRank`
- `queryReplenishmentBaseData`
- `queryStoreSalesSummary`

任意 missing、extra 或 schema 缺失都会导致 agent-service fail-fast。这样可以避免 ERP 工具漂移后业务在运行时才失败。

## 安全设计

- API Key 使用 `sk-agent-*` 前缀，DB 只存 argon2id hash。
- `AGENT_API_KEY_HASH_SALT` 是服务端 pepper，必须作为生产密钥管理。
- 租户上下文由 API Key 派生，贯穿 runtime context、MCP header、日志和草稿。
- OpenAI 请求 schema 显式拒绝工具调用字段，防止客户端绕过 Agent 工具治理。
- OutputGuard 阻断工具调用内容泄漏到 SSE。
- 数字一致性校验生产环境禁止关闭。
- 采购单创建必须经过 HITL 确认，V1 策略中 `allowAutoPurchaseOrder` 固定为 `false`。
- `.env`、`.env.*.dev`、`.env.*.local` 不进入 Git。

## 健康检查

| Path | 含义 | 是否用于 liveness/readiness |
| --- | --- | --- |
| `GET /health` | 进程存活，只返回 `{ "status": "UP" }`，不做 IO。 | liveness |
| `GET /health/db` | MySQL ping + 表数量检查。 | 手动诊断 |
| `GET /health/mcp` | MCP 工具白名单检查。 | 手动诊断 |
| `GET /health/model` | LLM ping，发布前烟雾使用。 | 不进入 readiness |
| `GET /health/ready` | 聚合 DB + MCP，不调用模型。 | readiness |

## 部署说明

生产 compose 位于 `deploy/docker-compose.prod.yml`，只包含：

- `agent-service`
- `nginx`

生产环境不包含：

- MySQL 容器，生产应使用 RDS 或内部 DB 集群。
- `mcp-mock-server`，生产必须接真实 ERP MCP。
- LobeChat，生产前端作为独立部署单元。
- LobeChat Postgres。

生产关键环境变量通过 `/etc/storepilot/agent.prod.env` 注入，至少包括：

- `DATABASE_URL`
- `MODEL_BASE_URL`
- `MODEL_API_KEY`
- `MODEL_NAME`
- `ERP_MCP_SERVER_URL`
- `MCP_TENANT_SHARED_SECRET`
- `AGENT_API_KEY_HASH_SALT`
- `CORS_ALLOWED_ORIGINS`

生产部署后建议检查：

```bash
curl -f http://127.0.0.1:7100/health
curl -f http://127.0.0.1:7100/health/ready
```

`/health/model` 只作为发布前烟雾，不要放进 readiness，避免模型服务抖动导致所有实例被摘流量。

## 常见问题

### agent-service 启动失败，日志提示表数量不足

先执行迁移：

```bash
DATABASE_URL='mysql://root:rootpw@127.0.0.1:3306/store_pilot' pnpm migrate:up
```

### `/health/mcp` 返回白名单不一致

检查：

- `ERP_MCP_SERVER_URL` 是否指向正确的 MCP server。
- `MCP_TENANT_SHARED_SECRET` 是否与 MCP server 一致。
- dev mock 是否启用了 `MCP_ENABLE_WRITE_TOOLS=true`。
- 真实 ERP MCP 是否暴露完整 7 工具和 input/output schema。

### LobeChat 请求 401

检查：

- `OPENAI_API_KEY` 是否为 `pnpm issue:apikey` 新签发的 `sk-agent-*`。
- `AGENT_API_KEY_HASH_SALT` 是否与签发时一致。
- `agent_api_key.status` 是否为 `ENABLED`，且未过期。

### LobeChat 请求路径 404

`OPENAI_PROXY_URL` 必须以 `/v1` 结尾：

```dotenv
OPENAI_PROXY_URL=http://agent-service:7100/v1
```

### 本地测试 DB 用例被跳过

显式设置 MySQL 测试连接：

```bash
MYSQL_TEST_URL='mysql://root:rootpw@127.0.0.1:3306' pnpm test
```

## Git 与文档边界

当前仓库 `.gitignore` 会忽略：

- `docs/`
- `.claude/`
- `.specstory/`
- `.env*` 本地密钥文件
- `test-audit-*.md`
- `task_plan.md` / `findings.md` / `progress.md` / `research.md`

根目录 `README.md` 是项目入口文档，应纳入 Git 管理。
