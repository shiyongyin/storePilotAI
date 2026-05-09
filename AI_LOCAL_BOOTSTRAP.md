# StorePilotAI AI 本地启动 Runbook

本文档的目标是让新人把必要信息准备好之后，AI agent 可以**无歧义、可复现**地把 StorePilotAI 在本地跑起来。

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

---

## 0. AI Agent 协议总则（必读 / 高于一切）

AI 必须按下面的硬约束执行，**任何冲突时以本节优先**。

### 0.1 执行流水线

```text
收齐新人信息（§1）
  → 启动前自检（§2）— 任意 [BLOCK] 立即停下，不继续
  → 按 §3~§14 顺序执行
  → 输出 §15 的最终报告（模板必填）
```

### 0.2 占位标记规约（理解每个 dummy 的语义）

文档里所有 `<...>`、`change-me-*` 都属于以下 **三类之一**，AI 必须按类别处理：

| 标记 | 含义 | AI 行为 |
|---|---|---|
| **[FIXED-OK]** | 本地 dummy，仓库内多处必须一致 | **原样抄写**，不得改、不得"看起来更安全"地替换 |
| **[NEEDS-REPLACE: 来源]** | 必须替换为运行时值 | 用 brackets 内"来源"指定的值替换 |
| **[GEN-ONCE]** | 启动过程动态生成 | 由 AI 在指定步骤生成并回填，不向新人索要 |

每个本文出现的占位都会显式带上其中一种标记。AI 看到没有标记的占位，停下问新人。

### 0.3 长命令处理

下列命令**必须按 long-running 处理**（允许 ≥5 分钟，或在支持后台执行的工具里 background）：

- `pnpm install --frozen-lockfile`
- `docker compose ... up -d --build`（首次会拉镜像 + 构建）
- `docker compose ... up -d agent-service lobechat`（首次有镜像 build）

不要用默认 2 分钟超时跑这几条命令。

### 0.4 健康检查必须 retry

任何 `curl /health*` 不得只跑一次。**统一使用 §10 给的 retry 模板**（最多 30 次，每次 sleep 5 秒）。

### 0.5 Secret 脱敏与文件读取硬约束

AI 在本任务中**禁止**：

- 用 `cat` / `Read` 工具读取 `.env.agent.dev`、`.env.lobechat.dev`、`.env.mock.dev` 的文件内容（写入用 `Write`/`Edit` / `sed`，无需读回校对）；
- 在对话、最终报告、commit、日志、curl 示例里出现完整 `MODEL_API_KEY` 或完整 `sk-agent-*`；
- 把签发出来的明文 `sk-agent-*` 重复打印到 stdout 之外的任何地方；
- 提交任何 `.env.*.dev` 到 Git；
- 修改 `.gitignore` 让 `.env.*.dev` 可被提交；
- 未授权执行 `docker compose down -v` / `git reset --hard` / `git clean -fdx` / `kill` 非本项目进程。

如果必须验证 env 文件已经写入正确字段，使用 `grep -c '^KEY=' .env.xxx.dev`（只校对存在性，不打印值）。

### 0.6 进度与输出契约

- 每个 §3~§14 步骤完成后输出一行：`[stepN] ok` 或 `[stepN] BLOCK: <一句话原因>`。
- 遇到 BLOCK 立即停下，按 §16 故障处理给出建议动作，**等待新人确认后**再继续，不要绕过。
- 最终报告必须严格使用 §15 的 Markdown 模板。

---

## 1. 第一轮提问（AI 必须按此模板向新人收齐信息）

AI 收到本任务后的第一条回复，必须使用下面的格式（不要重写、不要省略字段）：

```text
我会按 AI_LOCAL_BOOTSTRAP.md 帮你把 StorePilotAI 本地跑起来。请提供或确认下面信息。

1. 仓库地址 Repo URL（默认 https://github.com/shiyongyin/storePilotAI）：
   作用：AI 用它 clone 项目代码；如果仓库是私有的，你需要先给当前账号访问权限。
   私有仓库时请额外告诉我使用以下哪种鉴权：
     a) 当前 shell 的 SSH key（git@github.com:...）
     b) 已登录的 gh CLI（gh auth status 通过）
     c) Personal Access Token（粘贴到 https URL）
     d) 这台机器已有本地副本，跳过 clone

2. 目标分支 Branch（默认 main）：
   作用：AI 会切到这个分支启动项目；一般填 main，除非你要验证某个开发分支。

3. 本地目录 Local path：
   作用：AI 会把项目放在这个目录，或在已有目录中继续操作。
   示例：/Users/yourname/work/storePilotAI

4. DeepSeek API Key（写入 MODEL_API_KEY）：
   作用：agent-service 调用大模型时使用的鉴权密钥。
   安全要求：只写入本地 .env.agent.dev，不提交 Git，最终报告也不能完整展示。
   提供方式（任选其一）：
     - 直接粘贴（AI 不会回显，仅写入文件）
     - 已存在于本机 ~/.storepilot/deepseek.key 或环境变量 DEEPSEEK_API_KEY，告诉我即可

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

固定模型配置（不向你确认，AI 直接写入）：
- MODEL_BASE_URL=https://api.deepseek.com/v1
- MODEL_NAME=deepseek-chat

请同时确认我可以执行：
- pnpm install --frozen-lockfile
- docker compose 启动本地容器
- 创建 .env.*.dev 本地文件（不会提交 Git）
- 执行 pnpm migrate:up
- 签发本地 sk-agent-* API Key
```

收齐 8 个字段 + 5 项授权前，**不进入 §2**。如果新人只回了部分字段，AI 必须再追问缺失项。

新人推荐的最简回复模板：

```text
请按 AI_LOCAL_BOOTSTRAP.md 把 StorePilotAI 本地跑起来。

仓库地址 Repo URL: https://github.com/shiyongyin/storePilotAI
目标分支 Branch: main
本地目录 Local path: /Users/xxx/work/storePilotAI

DeepSeek API Key（MODEL_API_KEY）: sk-...

LobeChat 访问码 ACCESS_CODE: storepilot

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

---

## 2. 启动前自检（AI 必须先跑这一段，再决定是否继续）

进入仓库目录后，AI 必须**先**执行下面的自检脚本（一段 bash 跑完即可），并把每行 `[ok]` / `[BLOCK]` 输出贴回对话。任何 `[BLOCK]` 立即停下问新人。

```bash
set +e
echo "== AI 启动前自检 =="

# 仓库结构假设
[ -f docker-compose.dev.yml ] && echo "[ok] compose 文件存在" || echo "[BLOCK] 缺 docker-compose.dev.yml"
[ -f package.json ] && echo "[ok] package.json 存在" || echo "[BLOCK] 缺 package.json"
grep -qE '"migrate:up"' package.json && echo "[ok] scripts.migrate:up 存在" || echo "[BLOCK] package.json 缺 migrate:up"
grep -qE '"issue:apikey"' package.json && echo "[ok] scripts.issue:apikey 存在" || echo "[BLOCK] package.json 缺 issue:apikey"
[ -f .nvmrc ] && echo "[ok] .nvmrc 期望 Node: $(cat .nvmrc)" || echo "[warn] 无 .nvmrc"
[ -f packages/agent-service/.env.example ] && echo "[ok] agent .env.example 存在" || echo "[warn] 缺 agent .env.example"

# 工具链
node -v 2>/dev/null   | grep -qE '^v22\.'             && echo "[ok] node 22.x"          || echo "[BLOCK] 需 Node 22.x（见 .nvmrc）"
pnpm -v 2>/dev/null   | grep -qE '^9\.'               && echo "[ok] pnpm 9.x"           || echo "[BLOCK] 需 pnpm 9.x（corepack enable）"
docker info >/dev/null 2>&1                           && echo "[ok] docker daemon up"   || echo "[BLOCK] Docker daemon 未启动"

# docker compose v1/v2 兼容（向下记录使用哪个 CLI）
if docker compose version >/dev/null 2>&1; then
  echo "[ok] docker compose CLI: docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  echo "[ok] docker compose CLI: docker-compose（v1 兜底）"
else
  echo "[BLOCK] 找不到 docker compose / docker-compose"
fi

# 端口（被占用不一定 BLOCK，但要打印）
for P in 3306 7100 7300 3210; do
  if lsof -nP -iTCP:$P -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[warn] 端口 $P 已被占用：$(lsof -nP -iTCP:$P -sTCP:LISTEN | awk 'NR==2{print $1}')"
  else
    echo "[ok] 端口 $P 空闲"
  fi
done
```

记录 **`docker compose` 还是 `docker-compose`**（下文统一写作 `docker compose`，AI 实际执行时按自检结果替换）。

---

## 3. 进入或拉取仓库

如果本地目录不存在：

```bash
git clone <Repo URL> <Local path>     # <Repo URL> [NEEDS-REPLACE: 新人字段 1]
cd <Local path>                       # <Local path> [NEEDS-REPLACE: 新人字段 3]
git switch <Branch>                   # <Branch> [NEEDS-REPLACE: 新人字段 2]
```

如果本地目录已存在：

```bash
cd <Local path>
git status --short --branch
git remote -v
git branch --show-current
```

判断与处理：

- 当前分支不是新人要求的分支 → `git switch <Branch>`，失败时报告并停下。
- 有未提交修改 → **不要回滚、不要 stash、不要覆盖**。先在对话中报告"工作区有 N 个未提交文件"。如果这些文件不在 `.env.*.dev`、`docker-compose.dev.yml`、`package.json`、`tools/**`、`packages/**` 路径里，可继续；否则停下问新人。
- 私有仓库 clone 失败 → 按 §1 第 1 项收集到的鉴权方式重试一次；仍失败则停下。

---

## 4. 检查工具链（细化）

```bash
node -v
corepack --version 2>/dev/null || echo "no corepack"
pnpm -v
docker --version
docker compose version 2>/dev/null || docker-compose --version
```

期望（与 §2 自检一致）：

- Node.js `>=22.13.0 <23`（`.nvmrc` 写的是 `22`）
- pnpm `>=9.7.0 <10`
- Docker daemon 正在运行

如果 `pnpm` 不可用：

```bash
corepack enable
corepack prepare pnpm@9.7.0 --activate
pnpm -v
```

如果 Node 不是 22 且本机有 nvm（**nvm 是 shell function，必须先 source**）：

```bash
# AI 必须先 source 再 use；直接执行 nvm 会报 "command not found"
[ -s "$HOME/.nvm/nvm.sh" ] && \. "$HOME/.nvm/nvm.sh"
nvm install   # 若 .nvmrc 里 22 还没装
nvm use       # 切到 .nvmrc 指定的 22
node -v
```

如果本机既无 nvm 也不是 Node 22 → 停下问新人是否允许装 nvm/Node 22，**不要擅自下载安装包**。

---

## 5. 检查端口（再次精确确认）

```bash
lsof -nP -iTCP:3306 -sTCP:LISTEN
lsof -nP -iTCP:7100 -sTCP:LISTEN
lsof -nP -iTCP:7300 -sTCP:LISTEN
lsof -nP -iTCP:3210 -sTCP:LISTEN
```

判定：

- 输出为空 → 端口空闲，继续。
- 输出包含 `storepilot-*` 容器进程（COMMAND 列形如 `com.docke`、PID 来自 Docker） → 是本项目旧容器，可继续；下一步 `docker compose up -d` 会复用或重建。
- 输出是其它进程（例如本机 mysqld、Postgres.app、本地开发服务器） → **停下问新人**是否释放端口，不要 kill。

---

## 6. 安装依赖（[LONG-RUNNING ≥3 分钟，建议后台]）

```bash
pnpm install --frozen-lockfile
```

完成后校验：

```bash
test -d node_modules && echo "[ok] node_modules"
pnpm -w exec tsx --version >/dev/null 2>&1 && echo "[ok] tsx 可用" || echo "[warn] tsx 调用前会即时 resolve"
```

失败兜底：

| 现象 | 处理 |
|---|---|
| 网络超时 / `EAI_AGAIN` | 让新人确认网络/代理/registry，**不要**改 registry |
| `ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE` | **不要**自行 `pnpm install` 升 lockfile，停下报告 |
| Node 版本错误 | 回 §4 切到 22 |

---

## 7. 创建本地环境文件

本项目 `.gitignore` 已忽略 `.env.*.dev`。创建后**禁止 cat 文件内容**（违反 §0.5），如需校对仅可：

```bash
grep -c '^[A-Z_]*=' .env.agent.dev      # 行数计数，不展示值
grep -c '^[A-Z_]*=' .env.mock.dev
grep -c '^[A-Z_]*=' .env.lobechat.dev
```

### 7.1 创建 `.env.mock.dev`

下列每个值都已带标记。AI 直接 `Write` 写入，不询问新人。

```dotenv
NODE_ENV=development
PORT=7300
MCP_TENANT_SHARED_SECRET=change-me-32-char-secret-xxxxxxxxxx          # [FIXED-OK] 与 .env.agent.dev 同值；本地 dummy
MCP_PROTOCOL_VERSION=2025-06-18                                       # [FIXED-OK]
MCP_TOOL_TIMEOUT_MS=15000                                             # [FIXED-OK]
MCP_ENABLE_WRITE_TOOLS=true                                           # [FIXED-OK] 必须 true，否则 7 工具白名单不全
MCP_ALLOWED_HOSTS=localhost:7300,127.0.0.1:7300,mcp-mock-server:7300  # [FIXED-OK]
MCP_CORS_ORIGIN=*                                                     # [FIXED-OK]
FIXTURE_PROFILE=happy-path                                            # [FIXED-OK]
```

### 7.2 创建 `.env.agent.dev`

本地默认使用 DeepSeek。`MODEL_API_KEY` 是新人提供的真实 key（**禁止读回**）。

```dotenv
NODE_ENV=development
PORT=7100
DATABASE_URL=mysql://root:rootpw@mysql:3306/store_pilot?timezone=Z&dateStrings=true&supportBigNumbers=true&bigNumberStrings=true&charset=utf8mb4&decimalNumbers=true   # [FIXED-OK] 容器主机名 mysql

MODEL_PROVIDER=openai-compatible                  # [FIXED-OK]
MODEL_BASE_URL=https://api.deepseek.com/v1        # [FIXED-OK]
MODEL_API_KEY=<USER_MODEL_API_KEY>                # [NEEDS-REPLACE: 新人字段 4]
MODEL_NAME=deepseek-chat                          # [FIXED-OK]
MODEL_TIMEOUT_MS=25000                            # [FIXED-OK]
MAX_OUTPUT_TOKENS=4096                            # [FIXED-OK]
MAX_TOOL_CALLS_PER_REQUEST=8                      # [FIXED-OK]

ERP_MCP_SERVER_URL=http://mcp-mock-server:7300/mcp                    # [FIXED-OK] 容器主机名
MCP_TENANT_SHARED_SECRET=change-me-32-char-secret-xxxxxxxxxx          # [FIXED-OK] 必须与 .env.mock.dev 完全相同
MCP_PROTOCOL_VERSION=2025-06-18                                       # [FIXED-OK]
TOOL_CALL_TIMEOUT_MS=15000                                            # [FIXED-OK]

DB_POOL_MAX=20                                                        # [FIXED-OK]
DB_QUEUE_LIMIT=200                                                    # [FIXED-OK]
AGENT_API_KEY_HASH_SALT=local-dev-salt-32chars-storepilot             # [FIXED-OK] ≥16 字符；签发与运行时必须用同值
AGENT_API_KEY_PREFIX=sk-agent-                                        # [FIXED-OK] 必须固定 sk-agent-，否则 issue:apikey 直接 reject
CORS_ALLOWED_ORIGINS=http://localhost:3210,http://localhost:3000      # [FIXED-OK]
USER_MESSAGE_MAX_CHARS=4000                                           # [FIXED-OK]
SUSPEND_TTL_MINUTES=30                                                # [FIXED-OK]
RETENTION_DAYS_RUN_LOG=180                                            # [FIXED-OK]
NUMBER_CONSISTENCY_CHECK_ENABLED=true                                 # [FIXED-OK]
GRAY_MERCHANT_WHITELIST=                                              # [FIXED-OK] 留空
```

写入后检查（不打印值）：

```bash
grep -q '^MODEL_API_KEY=sk-' .env.agent.dev      && echo "[ok] MODEL_API_KEY 写入"      || echo "[BLOCK] MODEL_API_KEY 未写入"
grep -q '^MCP_TENANT_SHARED_SECRET=' .env.agent.dev && echo "[ok] MCP secret 已写入"
```

### 7.3 创建 `.env.lobechat.dev`

```dotenv
APP_URL=http://localhost:3210                                                       # [FIXED-OK]
ACCESS_CODE=<USER_LOBECHAT_ACCESS_CODE>                                             # [NEEDS-REPLACE: 新人字段 5，默认 storepilot]
KEY_VAULTS_SECRET=change-me-base64-32bytes-xxxxxxxxxxxxxxxxxxxxxxxx==               # [FIXED-OK] LobeChat 仅本地存储，dummy 即可
NEXT_AUTH_SECRET=dev-nextauth-secret-32chars-xxxxxxxxxxxx                           # [FIXED-OK]
NEXTAUTH_SECRET=dev-nextauth-secret-32chars-xxxxxxxxxxxx                            # [FIXED-OK]
AUTH_SECRET=dev-nextauth-secret-32chars-xxxxxxxxxxxx                                # [FIXED-OK]
S3_ENDPOINT=http://localhost:3210                                                   # [FIXED-OK] dev 占位
S3_PUBLIC_DOMAIN=http://localhost:3210                                              # [FIXED-OK] dev 占位

OPENAI_PROXY_URL=http://agent-service:7100/v1                                       # [FIXED-OK] 容器主机名 + 必须以 /v1 结尾
OPENAI_API_KEY=sk-agent-pending-replace-after-issue                                 # [GEN-ONCE] §9 签发后回填
DEFAULT_AGENT_CONFIG=model=store-agent-v1;provider=openai                           # [FIXED-OK]
CUSTOM_MODELS=+store-agent-v1                                                       # [FIXED-OK]

ENABLED_OPENAI_VISION=0                                                             # [FIXED-OK]
ENABLED_TTS=0                                                                       # [FIXED-OK]
ENABLED_PLUGINS=0                                                                   # [FIXED-OK]
ENABLED_FUNCTION_CALLING=0                                                          # [FIXED-OK]
PORT=3210                                                                           # [FIXED-OK]
```

写入后检查：

```bash
grep -q '^ACCESS_CODE=' .env.lobechat.dev && echo "[ok] ACCESS_CODE 写入"
grep -q '^OPENAI_PROXY_URL=http://agent-service:7100/v1$' .env.lobechat.dev && echo "[ok] OPENAI_PROXY_URL 正确" || echo "[BLOCK] OPENAI_PROXY_URL 必须严格等于 http://agent-service:7100/v1"
```

---

## 8. 启动 MySQL 和 MCP mock（[LONG-RUNNING 首次镜像 build]）

```bash
docker compose -f docker-compose.dev.yml up -d mysql mcp-mock-server
```

`mysql` 用官方镜像，`mcp-mock-server` 首次会本地 build（看 `packages/mcp-mock-server/Dockerfile`），允许 5 分钟。

启动后等待 healthy（不要立刻打 healthcheck，先用 docker 等）：

```bash
# 阻塞等待 MySQL healthy（最多 90 秒）
for i in $(seq 1 18); do
  s=$(docker inspect -f '{{.State.Health.Status}}' storepilot-mysql 2>/dev/null)
  echo "[mysql] $s"
  [ "$s" = "healthy" ] && break
  sleep 5
done

# MCP mock 同样等待
for i in $(seq 1 18); do
  s=$(docker inspect -f '{{.State.Health.Status}}' storepilot-mcp-mock-server 2>/dev/null)
  echo "[mcp-mock] $s"
  [ "$s" = "healthy" ] && break
  sleep 5
done

curl -fs http://localhost:7300/health | head -c 400; echo
```

`/health` 应返回 JSON，含 `status` / `toolCount` 等字段。

> 注：`docker-compose.dev.yml` 也定义了 `lobechat-postgres` 服务，dev 模式（client 镜像 + ACCESS_CODE）**不需要启动**它，跳过即可。

---

## 9. 执行数据库迁移（host 机器跑，注意 DSN 主机名）

迁移命令在**宿主机**执行，因此 DSN 必须用 `127.0.0.1`，**不能用容器主机名 `mysql`**。

```bash
DATABASE_URL='mysql://root:rootpw@127.0.0.1:3306/store_pilot?timezone=Z&dateStrings=true&supportBigNumbers=true&bigNumberStrings=true&charset=utf8mb4&decimalNumbers=true' \
pnpm migrate:up
```

成功后校验表数量：

```bash
mysql --protocol=TCP -uroot -prootpw -h127.0.0.1 -P3306 store_pilot \
  -e "SELECT COUNT(*) AS tables_count FROM information_schema.tables WHERE table_schema = DATABASE();"
```

期望 `tables_count >= 11`。少于 11 → BLOCK，回看 migrate 日志。

---

## 10. 签发本地 API Key（[GEN-ONCE]，明文只出现一次）

`merchantId` / `storeId` / `userId` 用新人字段 6/7/8，未填用默认 `M001` / `S001` / `boss-001`。

### 10.1 一次性脚本（必须在**单次** Bash 调用里跑完）

> AI 重要约束：Claude Code / Codex 的 Bash 工具**每次调用都是独立 shell**，shell 变量（`KEY`、`PREFIX`）不会跨调用持久。本节脚本必须**完整作为一条 Bash 命令**执行，不要拆成多次。

把下面这段整体替换 `<merchantId>` / `<storeId>` / `<userId>` 后，作为**一条** Bash 命令运行：

```bash
set -e

ISSUE_OUT=$(mktemp -t storepilot-issue.XXXXXX)
cleanup() { rm -f "$ISSUE_OUT"; }
trap cleanup EXIT

# --- 1) 签发：stdout/stderr 全部重定向到临时文件，避免明文进入对话上下文 ---
DATABASE_URL='mysql://root:rootpw@127.0.0.1:3306/store_pilot?timezone=Z&dateStrings=true&supportBigNumbers=true&charset=utf8mb4&decimalNumbers=true' \
AGENT_API_KEY_HASH_SALT='local-dev-salt-32chars-storepilot' \
pnpm issue:apikey -- \
  --merchantId <merchantId> \
  --storeId    <storeId> \
  --userId     <userId> \
  --ttlDays    90 \
  > "$ISSUE_OUT" 2>&1
echo "[issue] exit=$?"

# --- 2) 解析 stdout（固定 5 行格式，详见 §10.2）---
PREFIX=$(grep -oE 'apiKeyPrefix=sk-agent-[A-Za-z0-9_-]{7}' "$ISSUE_OUT" | head -1 | cut -d= -f2)
KEY=$(tail -1 "$ISSUE_OUT" | sed 's/^[[:space:]]*//')

if [ -z "$PREFIX" ]; then
  echo "[BLOCK] 没解析到 apiKeyPrefix；issue:apikey 可能失败，错误概要："
  grep -vE 'sk-agent-[A-Za-z0-9_-]{20,}' "$ISSUE_OUT" | tail -n 20
  exit 2
fi

case "$KEY" in
  sk-agent-*) echo "[ok] prefix=$PREFIX  key.len=${#KEY}";;
  *)          echo "[BLOCK] 抓取的 key 不是 sk-agent- 开头"; exit 3;;
esac

# --- 3) 用 sed 替换 .env.lobechat.dev 的 OPENAI_API_KEY（不 cat、不打印明文）---
if sed --version >/dev/null 2>&1; then
  sed -i    "s|^OPENAI_API_KEY=.*|OPENAI_API_KEY=$KEY|" .env.lobechat.dev
else
  sed -i '' "s|^OPENAI_API_KEY=.*|OPENAI_API_KEY=$KEY|" .env.lobechat.dev
fi

grep -q "^OPENAI_API_KEY=sk-agent-" .env.lobechat.dev \
  && echo "[ok] OPENAI_API_KEY 已替换" \
  || { echo "[BLOCK] OPENAI_API_KEY 替换失败"; exit 4; }

# --- 4) 主动清理（trap 兜底）---
unset KEY
echo "[ok] §10 完成；明文 key 仅在 .env.lobechat.dev 内"
```

执行结束后向新人**只**汇报：`[ok] prefix=sk-agent-XXXXXXX`，**不要**汇报完整 key、不要 cat `.env.lobechat.dev`。

### 10.2 stdout 格式参考（来自 `tools/api-key-issuer/src/issue.ts`）

成功输出固定 5 行：

```text
[api-key-issuer] 颁发成功
  merchantId=M001  storeId=S001  userId=boss-001
  apiKeyPrefix=sk-agent-XXXXXXX  ttlDays=90
  明文 sk（仅此一次，请立即保存）：
  sk-agent-<43 chars base64url>
```

§10.1 的 `grep -oE 'apiKeyPrefix=sk-agent-[A-Za-z0-9_-]{7}'` 抓第 3 行 prefix，`tail -1` 抓第 5 行明文。如果实际输出与此不符（例如多了 deprecation warning），说明上游脚本格式变了，**停下让新人确认**。

签发失败的判定：

| 现象 | 根因 | 处理 |
|---|---|---|
| `DATABASE_URL 必须以 mysql://` | DSN 字符串错 | 检查 §10.1 命令中 DSN |
| `AGENT_API_KEY_HASH_SALT 必须 ≥ 16` | salt 太短 | 必须用 §7.2 给的固定值 |
| `Table 'store_pilot.agent_api_key' doesn't exist` | migration 没跑 | 回 §9 |
| `connect ECONNREFUSED 127.0.0.1:3306` | MySQL 没起 | 回 §8 |

---

## 11. 启动 agent-service 和 LobeChat（[LONG-RUNNING 首次有 build]）

```bash
docker compose -f docker-compose.dev.yml up -d --build agent-service lobechat
```

阻塞等待 healthy：

```bash
for i in $(seq 1 30); do
  a=$(docker inspect -f '{{.State.Health.Status}}' storepilot-agent-service 2>/dev/null)
  l=$(docker inspect -f '{{.State.Health.Status}}' storepilot-lobechat 2>/dev/null)
  echo "[wait $i] agent=$a lobechat=$l"
  [ "$a" = "healthy" ] && [ "$l" = "healthy" ] && break
  sleep 5
done
```

如果某个容器处于 `unhealthy` 或反复 `restarting`，立即抓最近 200 行日志（**只贴日志的非 secret 行**）：

```bash
docker compose -f docker-compose.dev.yml logs --tail=200 agent-service | \
  grep -vE 'MODEL_API_KEY|sk-agent-[A-Za-z0-9_-]+|MCP_TENANT_SHARED_SECRET'
```

agent-service 启动正常应看到（来自 `[startup]` 行）：

- `[startup] env-ok`
- `[startup] db-ok`
- `[startup] mastra-storage-ok`
- `[startup] mcp-tools-verified`
- `[startup] skill-def-verified`
- `[startup] listening :7100`

---

## 12. 健康检查（必须按 retry 模板，不要单次 curl）

通用 retry 模板（**整段必须作为一条 Bash 命令执行**：函数定义和调用之间不能跨 Bash 调用，否则 `retry_curl` 不存在）：

```bash
retry_curl() {
  local url=$1
  for i in $(seq 1 30); do
    if curl -fs "$url" >/tmp/_hc 2>&1; then
      echo "[ok] $url"
      head -c 400 /tmp/_hc; echo
      return 0
    fi
    sleep 5
  done
  echo "[BLOCK] $url 30 次仍未通过"
  return 1
}

retry_curl http://localhost:7100/health
retry_curl http://localhost:7100/health/db
retry_curl http://localhost:7100/health/mcp
retry_curl http://localhost:7100/health/ready
retry_curl http://localhost:7300/health
```

模型烟雾检查（**单独**做，可能失败但不阻塞 base ready）：

```bash
if curl -fs http://localhost:7100/health/model >/tmp/_hc 2>&1; then
  echo "[ok] /health/model"
  HEALTH_MODEL=pass
else
  echo "[warn] /health/model 失败 — 不阻塞，但报告里必须标注 fail"
  HEALTH_MODEL=fail
fi
```

判定边界：

- `/health` ~ `/health/ready` 任一失败 → BLOCK，看日志，不要进入 §13。
- `/health/model` 失败但前 4 个 pass → **可以继续**，但 §15 报告必须写 `model: fail` 并列出可能原因（key 无效 / 网络 / DeepSeek 限流）。

---

## 13. API 冒烟（仅 `/health/model` pass 时执行）

> 这一步会让明文 key 出现在 curl 命令里。AI 必须从 `.env.lobechat.dev` 内联读取，**不要 echo、不要 cat、不要写进对话**。

```bash
SK=$(grep '^OPENAI_API_KEY=' .env.lobechat.dev | cut -d= -f2-)

curl -sS http://localhost:7100/v1/chat/completions \
  -H "Authorization: Bearer $SK" \
  -H 'Content-Type: application/json' \
  -H 'X-Trace-Id: trace_01HZ0000000000000000000000' \
  -d '{
    "model": "store-agent-v1",
    "stream": true,
    "messages": [
      { "role": "user", "content": "帮我看一下今天门店日报" }
    ]
  }' | tee /tmp/_smoke | tail -n 5

unset SK
```

通过标准：

- HTTP 状态非 401 / 403。
- 响应是 SSE（`data: ` 前缀）。
- 末尾出现 `data: [DONE]`。
- 即便业务工具失败，也应是友好错误文本而非进程崩溃。

把判定结果（pass/fail + 一句原因）写进 §15 的 `smoke` 字段。**不要把 SSE 全文贴回对话**，只贴 5 行尾巴。

---

## 14. LobeChat 验证

打开 `http://localhost:3210`，输入 `ACCESS_CODE`。
AI 自身无法点击浏览器，只把以下检查清单告诉新人即可：

- 模型列表里能否看到 `store-agent-v1`。
- 发送"帮我看一下今天门店日报"是否有 SSE 输出。
- 401 → 检查 `.env.lobechat.dev` 的 `OPENAI_API_KEY`（必须是 §10 签发的完整 sk-agent-）。
- 404 → 检查 `OPENAI_PROXY_URL=http://agent-service:7100/v1`（必须以 `/v1` 结尾）。

---

## 15. 完成标准与最终报告（强制模板）

只有以下全部满足，AI 才能宣告"已跑起来"：

- `docker compose ps` 中 `storepilot-mysql` / `storepilot-mcp-mock-server` / `storepilot-agent-service` / `storepilot-lobechat` 全部 `Up (healthy)`。
- `/health` / `/health/db` / `/health/mcp` / `/health/ready` 全 pass。
- 已签发本地 `sk-agent-*` 并写入 `.env.lobechat.dev`。
- `git status --short` 中**没有** `.env.*.dev` 出现（被 .gitignore 正确忽略）。

最终报告**必须**用下面的 Markdown 模板（字段全部填，没做的写"未执行"，失败的写"fail + 原因"）：

```markdown
## 本地启动结果

- 仓库路径: <Local path>
- 分支: <Branch>
- Node / pnpm: vXX.X.X / X.X.X
- Docker Compose 服务:
  - storepilot-mysql: Up (healthy)
  - storepilot-mcp-mock-server: Up (healthy)
  - storepilot-agent-service: Up (healthy)
  - storepilot-lobechat: Up (healthy)
- 访问入口:
  - Agent: http://localhost:7100
  - LobeChat: http://localhost:3210（ACCESS_CODE 见 .env.lobechat.dev）
  - MCP mock: http://localhost:7300
- API Key prefix: sk-agent-XXXXXXX...（仅前缀；完整 key 在本机 .env.lobechat.dev）

## 验证

| 项 | 结果 |
|---|---|
| /health | pass / fail |
| /health/db | pass / fail |
| /health/mcp | pass / fail |
| /health/ready | pass / fail |
| /health/model | pass / fail（fail 时附原因） |
| API 冒烟 (SSE [DONE]) | pass / fail / 未执行 |
| LobeChat（新人手动确认） | 待新人确认 |

## Git 工作区

- `.env.*.dev` 是否被 git 跟踪: 否
- 工作区有无未提交修改: 有/无（如有，列出文件）

## 风险或未完成项

- 如无，写"无"
- 如有，逐条列：现象 / 影响 / 建议处理
```

---

## 16. 故障处理（按现象索引）

### 16.1 Docker 未启动

```text
Cannot connect to the Docker daemon
```

→ 让新人启动 Docker Desktop（macOS GUI），AI 自己**不要**尝试启动。等待新人确认后回到 §2。

### 16.2 端口被占用

```text
Bind for 0.0.0.0:7100 failed: port is already allocated
```

→ `lsof -nP -iTCP:7100 -sTCP:LISTEN`：

- 是 `storepilot-*` 容器：`docker compose -f docker-compose.dev.yml restart agent-service` 即可。
- 是其他进程：BLOCK，问新人是否释放。

### 16.3 agent-service 反复重启

```bash
docker compose -f docker-compose.dev.yml logs --tail=200 agent-service | \
  grep -vE 'MODEL_API_KEY|sk-agent-[A-Za-z0-9_-]+|MCP_TENANT_SHARED_SECRET'
```

| 日志关键字 | 根因 | 修复 |
|---|---|---|
| `tables count < 11` | migration 未跑 | 回 §9 |
| `mcp tools verification failed` | secret 不一致 / mock 未起 / write 未启 | 比对 §7.1 与 §7.2 的 `MCP_TENANT_SHARED_SECRET`；确认 `MCP_ENABLE_WRITE_TOOLS=true` |
| `skill-def verification failed` | seed 不全 | 重跑 `pnpm migrate:up` |
| `[env] 配置错误` | `.env.agent.dev` 字段缺失/格式错 | 按 §7.2 重写 |

### 16.4 `/health/mcp` 失败

确认：

- `.env.agent.dev` 与 `.env.mock.dev` 的 `MCP_TENANT_SHARED_SECRET` **完全相同**（含尾部字符）。
- `.env.mock.dev` 的 `MCP_ENABLE_WRITE_TOOLS=true`。
- `.env.agent.dev` 的 `ERP_MCP_SERVER_URL=http://mcp-mock-server:7300/mcp`（容器主机名）。

### 16.5 `/health/model` 失败

不阻塞本地启动。检查：

- `MODEL_BASE_URL=https://api.deepseek.com/v1`
- `MODEL_NAME=deepseek-chat`
- `MODEL_API_KEY` 是否来自 DeepSeek（前缀 `sk-`，长度合理）
- 容器是否能访问外网：`docker compose exec agent-service wget -qO- https://api.deepseek.com/v1/models` 返回 401（无 key）即网络可达。

### 16.6 LobeChat 401

- `.env.lobechat.dev` 的 `OPENAI_API_KEY` 必须是 §10 签发的完整 `sk-agent-*`，不是占位 `sk-agent-pending-*`。
- `.env.agent.dev` 的 `AGENT_API_KEY_HASH_SALT` 必须**与签发命令使用的值完全一致**（即 `local-dev-salt-32chars-storepilot`）。
- DB 里 `agent_api_key` 表对应行 `status='ENABLED'` 且未过期。

### 16.7 LobeChat 404

```dotenv
OPENAI_PROXY_URL=http://agent-service:7100/v1   # 必须带 /v1
```

### 16.8 依赖安装失败

按顺序排查：

1. Node 版本（必须 22）。
2. pnpm 版本（必须 9.x）。
3. 网络/代理/registry。
4. **不要**擅自删除 lockfile。
5. **不要**擅自升级依赖。

### 16.9 MySQL 数据异常

不要直接删除 volume。如果新人确认要清空：

```bash
docker compose -f docker-compose.dev.yml down -v   # 销毁 volume，需新人显式授权
```

---

## 17. 重启与停止

### 重启（已经初始化过的机器）

```bash
docker compose -f docker-compose.dev.yml up -d mysql mcp-mock-server agent-service lobechat
# 仍按 §12 retry 模板做健康检查
```

`.env.lobechat.dev` 仍保留已签发的 `sk-agent-*` 时，不需要重新签发。

### 停止（保留 volume）

```bash
docker compose -f docker-compose.dev.yml stop lobechat agent-service mcp-mock-server mysql
```

### 彻底清理（销毁 volume，需新人明确授权）

```bash
docker compose -f docker-compose.dev.yml down -v
```

---

## 18. AI 禁止事项清单（汇总，便于查阅）

AI 在执行本 Runbook 时禁止：

- 把 `.env.*.dev` 加入 Git。
- 修改 `.gitignore` 以便提交本地密钥。
- 用 `cat` / `Read` 工具读取 `.env.agent.dev` / `.env.lobechat.dev` / `.env.mock.dev` 的内容（写入 OK，读回不行；校对用 `grep -c`/`grep -q`）。
- 在最终报告或对话里出现完整 `MODEL_API_KEY` 或完整 `sk-agent-*`（仅允许前缀，例如 `sk-agent-AbCdE12...`）。
- 直接改生产部署文件来绕过本地问题。
- 关闭 `NUMBER_CONSISTENCY_CHECK_ENABLED` 等安全校验来让服务启动。
- 在生产环境使用 `mcp-mock-server`。
- 未经新人显式授权执行：`docker compose down -v`、`git reset --hard`、`git clean -fdx`、`kill` 非本项目进程、`rm -rf node_modules` 后改 lockfile。
- 在新人未提供 `MODEL_API_KEY` 时，自行猜测、留空或用占位值跳过。
- 跳过 §10 的临时文件机制，把签发明文用 `pnpm issue:apikey ... | tee /dev/tty` 或类似方式直接打印到对话。
