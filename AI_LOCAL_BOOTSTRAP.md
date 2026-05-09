# StorePilotAI AI 本地启动 Runbook

本文档的目标是让新人把必要信息准备好之后，AI 可以无歧义地把 StorePilotAI 在本地跑起来。

适用范围：

- 本地开发环境启动。
- 使用 Docker Compose 启动 MySQL、MCP mock、agent-service、LobeChat。
- 默认使用 DeepSeek（`https://api.deepseek.com/v1` + `deepseek-chat`）完成模型连通性检查。
- 使用本地签发的 `sk-agent-*` API Key 连接 LobeChat 和 agent-service。

不适用范围：

- 生产部署。
- 真实 ERP MCP 切换。
- 云端 CI/CD 配置。
- 销毁数据库 volume 或重置历史数据。

## 角色分工

## AI 交互协议

AI 读取本文档后，必须先收集配置，再执行命令。不要在配置缺失时自行猜测模型服务、API Key、本地目录或访问码。

第一条回复应按下面格式向新人提问：

```text
我会按 AI_LOCAL_BOOTSTRAP.md 帮你把 StorePilotAI 本地跑起来。请提供或确认下面信息。

1. 仓库地址 Repo URL（默认 https://github.com/shiyongyin/storePilotAI）：
   作用：AI 用它 clone 项目代码；如果仓库是私有的，你需要先给当前账号访问权限。

2. 目标分支 Branch（默认 main）：
   作用：AI 会切到这个分支启动项目；一般填 main，除非你要验证某个开发分支。

3. 本地目录 Local path：
   作用：AI 会把项目放在这个目录，或在已有目录中继续操作。
   示例：/Users/yourname/work/storePilotAI

4. DeepSeek API Key（写入 MODEL_API_KEY）：
   作用：agent-service 调用大模型时使用的鉴权密钥。
   安全要求：只写入本地 .env.agent.dev，不提交 Git，最终报告也不能完整展示。

5. LobeChat 访问码 ACCESS_CODE（默认 storepilot）：
   作用：打开 http://localhost:3210 时输入的本地访问密码。
   说明：只保护本地 UI，不是模型 Key，也不是 GitHub 密码。

6. 商家 ID merchantId（默认 M001）：
   作用：签发本地 sk-agent-* API Key 时绑定商家租户；后续请求会带着这个租户上下文。
   本地演示可用默认值。

7. 门店 ID storeId（默认 S001）：
   作用：签发本地 sk-agent-* API Key 时绑定门店；日报、补货等能力会按这个门店上下文执行。
   本地演示可用默认值。

8. 用户 ID userId（默认 boss-001）：
   作用：签发本地 sk-agent-* API Key 时绑定操作者；用于日志、会话和确认链路。
   本地演示可用默认值。

固定模型配置：
- MODEL_BASE_URL=https://api.deepseek.com/v1
- MODEL_NAME=deepseek-chat
- 新人不需要填写或修改 MODEL_BASE_URL / MODEL_NAME。

请同时确认我可以执行：
- pnpm install --frozen-lockfile
- docker compose 启动本地容器
- 创建 .env.*.dev 本地文件
- 执行 pnpm migrate:up
- 签发本地 sk-agent-* API Key
```

收齐信息后，AI 才能进入执行步骤。执行过程中如果遇到以下情况，必须暂停并向新人确认：

- 需要删除 Docker volume。
- 需要 kill 非本项目进程。
- 需要修改 Git 已跟踪文件。
- 需要变更端口。
- 发现工作区已有未提交修改且会影响启动。
- 模型 Key、Git 权限、Docker 权限缺失。

AI 最终报告不得包含完整 `MODEL_API_KEY` 或完整 `sk-agent-*`，只能展示前缀或脱敏值。

### 新人必须准备

新人只负责准备信息和授权，不负责手工执行启动命令。

必填信息：

| 项 | 示例 | 说明 |
| --- | --- | --- |
| Git 仓库地址 | `https://github.com/shiyongyin/storePilotAI` | 私有仓库需要先获得访问权限。 |
| 目标分支 | `main` | 默认用 `main`。 |
| 本地目录 | `/Users/xxx/work/storePilotAI` | AI 会在该目录 clone 或使用已有仓库。 |
| DeepSeek API Key | `sk-...` | 写入 `MODEL_API_KEY`；真实模型 Key 只写入本地 `.env`，不得提交。 |
| LobeChat 访问码 | `storepilot` | 本地 UI 访问密码。 |
| 商家 ID | `M001` | 本地 API Key 绑定租户。 |
| 门店 ID | `S001` | 本地 API Key 绑定门店。 |
| 用户 ID | `boss-001` | 本地 API Key 绑定用户。 |

需要新人确认的本机前提：

- 已安装 Docker Desktop，且允许 AI 启动容器。
- 已安装 Node.js 22，或允许 AI 通过 `nvm use` 使用仓库 `.nvmrc`。
- 允许 AI 执行 `pnpm install --frozen-lockfile`。
- 本机端口 `3306`、`7100`、`7300`、`3210` 未被重要服务占用。

推荐把下面这段直接发给 AI：

```text
请按 AI_LOCAL_BOOTSTRAP.md 把 StorePilotAI 本地跑起来。

仓库地址 Repo URL:
目标分支 Branch: main
本地目录 Local path:

DeepSeek API Key（MODEL_API_KEY）:

LobeChat 访问码 ACCESS_CODE:

商家 ID merchantId: M001
门店 ID storeId: S001
用户 ID userId: boss-001

我允许你：
- 安装 pnpm 依赖
- 启动 Docker Compose 服务
- 创建本地 .env.*.dev 文件
- 执行数据库 migration
- 签发本地 sk-agent-* API Key

不要：
- 提交 .env 文件
- 把完整 API Key 打印到最终报告
- 删除 Docker volume，除非先问我
```

### AI 负责

AI 负责完整执行：

- 检查仓库、工具链和端口。
- 安装依赖。
- 创建本地环境文件。
- 启动 MySQL 和 MCP mock。
- 执行 migration。
- 签发本地 API Key。
- 写入 LobeChat 本地环境文件。
- 启动 agent-service 和 LobeChat。
- 执行健康检查。
- 给出最终访问地址和排障摘要。

AI 必须遵守：

- 不提交 `.env`、`.env.*.dev`、`.env.*.local`。
- 不把模型 Key、完整 `sk-agent-*` Key 写入 README、代码、Git commit 或最终报告。
- 不用 `git reset --hard`、`git clean -fdx`、删除 Docker volume 等破坏性命令，除非新人明确授权。
- 如果端口冲突、Docker 不可用、模型 Key 无效、依赖安装失败，应先说明阻塞点和建议动作。

## 启动口径

本项目本地启动顺序固定：

```text
安装依赖
  -> 创建 .env.*.dev
  -> 启动 mysql + mcp-mock-server
  -> 执行 pnpm migrate:up
  -> 签发 sk-agent-* API Key
  -> 写入 .env.lobechat.dev
  -> 启动 agent-service + lobechat
  -> 健康检查
```

不要直接一上来执行完整：

```bash
docker compose -f docker-compose.dev.yml up -d
```

原因：`agent-service` 启动期会校验 MySQL 表数量、Mastra workflow 表、MCP 7 工具白名单和 skill 定义。migration 未执行时直接启动 agent-service 会失败或反复重启。

## AI 执行步骤

以下步骤假设工作目录是仓库根目录。

### 0. 进入或拉取仓库

如果本地目录不存在：

```bash
git clone <Repo URL> <Local path>
cd <Local path>
git switch <Branch>
```

如果本地目录已存在：

```bash
cd <Local path>
git status --short --branch
git remote -v
git branch --show-current
```

如果当前分支不是新人要求的分支：

```bash
git switch <Branch>
```

如果有未提交修改：

- 先向新人报告。
- 不要覆盖、不回滚。
- 只要这些修改不影响本地启动，可以继续。

### 1. 检查工具链

```bash
node -v
corepack --version
pnpm -v
docker --version
docker compose version
```

期望：

- Node.js `>=22.13.0 <23`
- pnpm `>=9.7.0 <10`
- Docker 正常运行

如果 `pnpm` 不可用：

```bash
corepack enable
corepack prepare pnpm@9.7.0 --activate
pnpm -v
```

如果仓库有 `.nvmrc` 且本机有 nvm：

```bash
nvm use
```

### 2. 检查端口

```bash
lsof -nP -iTCP:3306 -sTCP:LISTEN
lsof -nP -iTCP:7100 -sTCP:LISTEN
lsof -nP -iTCP:7300 -sTCP:LISTEN
lsof -nP -iTCP:3210 -sTCP:LISTEN
```

如果端口被本项目旧容器占用，可以继续或重启对应容器。

如果端口被其他服务占用，先让新人确认是否释放端口。不要擅自 kill 不认识的进程。

### 3. 安装依赖

```bash
pnpm install --frozen-lockfile
```

如果依赖安装失败：

- 网络错误：让新人确认网络、代理或 registry。
- lockfile 错误：不要擅自更新 lockfile，先报告。
- Node 版本错误：切换到 Node 22 后重试。

### 4. 创建本地环境文件

本项目 `.gitignore` 已忽略 `.env.*.dev`。这些文件只能存在本地，不提交。

#### 4.1 创建 `.env.mock.dev`

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

#### 4.2 创建 `.env.agent.dev`

本地默认使用 DeepSeek。AI 只需要把新人提供的 DeepSeek API Key 写入 `MODEL_API_KEY`，不要询问或修改 `MODEL_BASE_URL` / `MODEL_NAME`。

```dotenv
NODE_ENV=development
PORT=7100
DATABASE_URL=mysql://root:rootpw@mysql:3306/store_pilot?timezone=Z&dateStrings=true&supportBigNumbers=true&bigNumberStrings=true&charset=utf8mb4&decimalNumbers=true

MODEL_PROVIDER=openai-compatible
MODEL_BASE_URL=https://api.deepseek.com/v1
MODEL_API_KEY=<USER_MODEL_API_KEY>
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
AGENT_API_KEY_HASH_SALT=local-dev-salt-32chars-storepilot
AGENT_API_KEY_PREFIX=sk-agent-
CORS_ALLOWED_ORIGINS=http://localhost:3210,http://localhost:3000
USER_MESSAGE_MAX_CHARS=4000
SUSPEND_TTL_MINUTES=30
RETENTION_DAYS_RUN_LOG=180
NUMBER_CONSISTENCY_CHECK_ENABLED=true
GRAY_MERCHANT_WHITELIST=
```

注意：

- `MCP_TENANT_SHARED_SECRET` 必须与 `.env.mock.dev` 一致。
- `AGENT_API_KEY_HASH_SALT` 后面签发 API Key 时必须使用同一个值。
- `DATABASE_URL` 这里使用容器内主机名 `mysql`，因为 agent-service 会跑在 Docker Compose 网络里。

#### 4.3 创建 `.env.lobechat.dev`

先用占位 API Key，等签发完成后再替换。

```dotenv
APP_URL=http://localhost:3210
ACCESS_CODE=<USER_LOBECHAT_ACCESS_CODE>
KEY_VAULTS_SECRET=change-me-base64-32bytes-xxxxxxxxxxxxxxxxxxxxxxxx==
NEXT_AUTH_SECRET=dev-nextauth-secret-32chars-xxxxxxxxxxxx
NEXTAUTH_SECRET=dev-nextauth-secret-32chars-xxxxxxxxxxxx
AUTH_SECRET=dev-nextauth-secret-32chars-xxxxxxxxxxxx
S3_ENDPOINT=http://localhost:3210
S3_PUBLIC_DOMAIN=http://localhost:3210

OPENAI_PROXY_URL=http://agent-service:7100/v1
OPENAI_API_KEY=sk-agent-pending-replace-after-issue
DEFAULT_AGENT_CONFIG=model=store-agent-v1;provider=openai
CUSTOM_MODELS=+store-agent-v1

ENABLED_OPENAI_VISION=0
ENABLED_TTS=0
ENABLED_PLUGINS=0
ENABLED_FUNCTION_CALLING=0
PORT=3210
```

关键点：

- `OPENAI_PROXY_URL` 必须以 `/v1` 结尾。
- `OPENAI_API_KEY` 必须在签发后替换成真实 `sk-agent-*`。

### 5. 启动 MySQL 和 MCP mock

```bash
docker compose -f docker-compose.dev.yml up -d mysql mcp-mock-server
```

检查容器状态：

```bash
docker compose -f docker-compose.dev.yml ps
curl -f http://localhost:7300/health
```

MCP mock 健康检查应返回 `status`、`toolCount` 或工具相关信息。

### 6. 执行数据库迁移

迁移命令在宿主机执行，所以 `DATABASE_URL` 必须使用 `127.0.0.1`，不能使用容器内主机名 `mysql`。

```bash
DATABASE_URL='mysql://root:rootpw@127.0.0.1:3306/store_pilot?timezone=Z&dateStrings=true&supportBigNumbers=true&bigNumberStrings=true&charset=utf8mb4&decimalNumbers=true' \
pnpm migrate:up
```

迁移成功后可以检查表数量：

```bash
mysql --protocol=TCP -uroot -prootpw -h127.0.0.1 -P3306 store_pilot \
  -e "SELECT COUNT(*) AS tables_count FROM information_schema.tables WHERE table_schema = DATABASE();"
```

期望表数量至少 `11`。

### 7. 签发本地 API Key

使用新人提供的商家、门店、用户 ID。没有提供时使用默认：

- `merchantId=M001`
- `storeId=S001`
- `userId=boss-001`

```bash
DATABASE_URL='mysql://root:rootpw@127.0.0.1:3306/store_pilot?timezone=Z&dateStrings=true&supportBigNumbers=true&charset=utf8mb4&decimalNumbers=true' \
AGENT_API_KEY_HASH_SALT='local-dev-salt-32chars-storepilot' \
pnpm issue:apikey -- --merchantId <merchantId> --storeId <storeId> --userId <userId> --ttlDays 90
```

命令会打印一次完整 `sk-agent-*`。AI 需要：

1. 复制完整明文 Key。
2. 写入 `.env.lobechat.dev` 的 `OPENAI_API_KEY`。
3. 最终报告只展示前缀，例如 `sk-agent-AbCd...`，不要重复完整 Key。

如果签发失败：

- `DATABASE_URL` 错误：确认 MySQL 是否启动、端口是否正确。
- `AGENT_API_KEY_HASH_SALT` 太短：必须至少 16 字符。
- 表不存在：回到 migration 步骤。

### 8. 更新 `.env.lobechat.dev`

把：

```dotenv
OPENAI_API_KEY=sk-agent-pending-replace-after-issue
```

替换为刚签发的完整 `sk-agent-*`。

不要把这个文件提交到 Git。

### 9. 启动 agent-service 和 LobeChat

```bash
docker compose -f docker-compose.dev.yml up -d --build agent-service lobechat
```

检查状态：

```bash
docker compose -f docker-compose.dev.yml ps
docker compose -f docker-compose.dev.yml logs --tail=120 agent-service
```

agent-service 日志中应看到启动绿灯：

- `[startup] env-ok`
- `[startup] db-ok`
- `[startup] mastra-storage-ok`
- `[startup] mcp-tools-verified`
- `[startup] skill-def-verified`
- `[startup] listening :7100`

### 10. 健康检查

```bash
curl -f http://localhost:7100/health
curl -f http://localhost:7100/health/db
curl -f http://localhost:7100/health/mcp
curl -f http://localhost:7100/health/ready
curl -f http://localhost:7300/health
```

期望：

- `/health` 返回 `UP`。
- `/health/db` 返回 `UP` 且表数量满足要求。
- `/health/mcp` 返回 `UP` 且工具白名单完整。
- `/health/ready` 返回 `UP`。
- MCP mock health 正常。

模型烟雾检查：

```bash
curl -f http://localhost:7100/health/model
```

如果 `/health/model` 失败，但 `/health/ready` 成功：

- 服务仍可认为基础就绪。
- 需要检查新人提供的 DeepSeek API Key、网络连通性，或 DeepSeek 服务状态。

### 11. API 冒烟

如果模型配置有效，执行一次 OpenAI 兼容接口请求。

```bash
curl http://localhost:7100/v1/chat/completions \
  -H 'Authorization: Bearer <ISSUED_SK_AGENT_KEY>' \
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

通过标准：

- HTTP 不是 401。
- 响应是 SSE。
- 最终出现 `data: [DONE]`。
- 如果模型或业务工具失败，响应应是友好错误文本，而不是服务崩溃。

### 12. LobeChat 验证

打开：

```text
http://localhost:3210
```

输入新人设置的 `ACCESS_CODE`。

在 LobeChat 中确认：

- 模型列表有 `store-agent-v1`。
- 发送“帮我看一下今天门店日报”后有 SSE 输出。
- 如果 401，检查 `.env.lobechat.dev` 的 `OPENAI_API_KEY`。
- 如果 404，检查 `OPENAI_PROXY_URL=http://agent-service:7100/v1`。

## 完成标准

AI 只有在以下项目全部完成后，才可以报告“本地已跑起来”：

- `docker compose -f docker-compose.dev.yml ps` 显示 MySQL、MCP mock、agent-service、LobeChat 正常运行或 healthy。
- `curl -f http://localhost:7100/health` 成功。
- `curl -f http://localhost:7100/health/ready` 成功。
- `curl -f http://localhost:7300/health` 成功。
- 已签发本地 `sk-agent-*`，并写入 `.env.lobechat.dev`。
- LobeChat 可以打开。
- `git status --short` 没有出现 `.env.*.dev` 被跟踪。

最终报告格式：

```text
本地启动结果：
- 仓库路径：
- 分支：
- Node / pnpm 版本：
- Docker Compose 服务：
- Agent: http://localhost:7100
- LobeChat: http://localhost:3210
- MCP mock: http://localhost:7300
- API Key prefix: sk-agent-xxxx...（不展示完整 Key）

验证：
- /health: pass
- /health/ready: pass
- /health/mcp: pass
- /health/model: pass / fail（如 fail，说明模型配置问题）
- LobeChat: pass / fail

未完成或风险：
- 如无，写“无”
```

## 常见故障处理

### Docker 未启动

症状：

```text
Cannot connect to the Docker daemon
```

处理：

- 让新人启动 Docker Desktop。
- 不要继续执行 compose 命令。

### 端口被占用

症状：

```text
Bind for 0.0.0.0:7100 failed: port is already allocated
```

处理：

```bash
lsof -nP -iTCP:7100 -sTCP:LISTEN
```

- 如果是本项目旧容器，可以重启 compose。
- 如果是其他进程，先问新人是否释放端口。

### agent-service 反复重启

先看日志：

```bash
docker compose -f docker-compose.dev.yml logs --tail=200 agent-service
```

常见原因：

- `tables count < 11`：未执行 migration，回到步骤 6。
- `mcp tools verification failed`：MCP mock 未启动、secret 不一致、写工具未启用。
- `skill-def verification failed`：migration 种子未执行完整，重新跑 `pnpm migrate:up`。
- `[env] 配置错误`：`.env.agent.dev` 字段缺失或格式错误。

### `/health/mcp` 失败

检查：

```bash
curl http://localhost:7300/health
docker compose -f docker-compose.dev.yml logs --tail=120 mcp-mock-server
```

重点核对：

- `.env.agent.dev` 和 `.env.mock.dev` 的 `MCP_TENANT_SHARED_SECRET` 一致。
- `.env.mock.dev` 中 `MCP_ENABLE_WRITE_TOOLS=true`。
- `ERP_MCP_SERVER_URL=http://mcp-mock-server:7300/mcp`。

### `/health/model` 失败

基础 readiness 不依赖模型，所以这不一定阻止本地服务启动。

检查：

- `MODEL_BASE_URL` 是否固定为 `https://api.deepseek.com/v1`。
- `MODEL_API_KEY` 是否为有效 DeepSeek API Key。
- `MODEL_NAME` 是否固定为 `deepseek-chat`。
- 本机或容器是否能访问外网。

### LobeChat 401

检查：

- `.env.lobechat.dev` 的 `OPENAI_API_KEY` 是否为刚签发的完整 `sk-agent-*`。
- `.env.agent.dev` 的 `AGENT_API_KEY_HASH_SALT` 是否与签发时一致。
- `agent_api_key` 表中该 key 是否 `ENABLED` 且未过期。

### LobeChat 404

检查：

```dotenv
OPENAI_PROXY_URL=http://agent-service:7100/v1
```

必须带 `/v1`，否则 LobeChat 会请求错误路径。

### 依赖安装失败

处理顺序：

1. 确认 Node 版本。
2. 确认 pnpm 版本。
3. 确认网络和 npm registry。
4. 不要擅自删除 lockfile。
5. 不要擅自升级依赖。

### MySQL 数据异常

不要直接删除 Docker volume。

如果确实需要清空本地 DB，必须先问新人，并说明会删除本地 MySQL 数据。

需要明确授权后才可执行类似操作：

```bash
docker compose -f docker-compose.dev.yml down -v
```

## 重启流程

如果已经完成过首次初始化，后续只需：

```bash
docker compose -f docker-compose.dev.yml up -d mysql mcp-mock-server agent-service lobechat
curl -f http://localhost:7100/health/ready
```

如果 `.env.lobechat.dev` 仍保留已签发的 `sk-agent-*`，不需要重新签发 API Key。

## 停止流程

```bash
docker compose -f docker-compose.dev.yml stop lobechat agent-service mcp-mock-server mysql
```

保留 volume，方便下次继续使用。

如果新人要求彻底清理，再解释风险并等待授权后执行：

```bash
docker compose -f docker-compose.dev.yml down -v
```

## AI 禁止事项清单

AI 在执行本 Runbook 时禁止：

- 把 `.env.*.dev` 加入 Git。
- 修改 `.gitignore` 以便提交本地密钥。
- 把完整 `MODEL_API_KEY` 或完整 `sk-agent-*` 写入最终报告。
- 直接改生产部署文件来绕过本地问题。
- 直接关闭安全校验来让服务启动。
- 在生产环境使用 `mcp-mock-server`。
- 未经授权删除 Docker volume。
- 未经授权 kill 非本项目进程。
