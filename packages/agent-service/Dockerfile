# ============================================================================
# 切片 02 / T-INFRA-02 — agent-service 多阶段构建
# 阶段：deps（node:22-bookworm，带 python3/make/g++） → build → runtime（node:22-bookworm-slim + 非 root）
# 红线：runtime 不得 root；deps 必须装 argon2 编译依赖；非 monorepo 单包构建
# ============================================================================

# --- 1) deps：装编译工具 + pnpm 依赖（含 argon2 prebuilt 回退） -------------
FROM node:22-bookworm AS deps
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.7.0 --activate

# 仅拷依赖清单 + lockfile，最大化 layer 命中
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY packages/agent-service/package.json packages/agent-service/
COPY packages/shared-contracts/package.json packages/shared-contracts/
COPY packages/mcp-mock-server/package.json packages/mcp-mock-server/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile \
        --filter '@storepilot/agent-service...' \
        --filter '@storepilot/shared-contracts'

# --- 2) build：编译 TS → dist ---------------------------------------------
FROM deps AS build
WORKDIR /app

# 拷源码（.dockerignore 排除测试 / 文档 / 历史归档）
COPY tsconfig.base.json ./
COPY packages/shared-contracts packages/shared-contracts
COPY packages/agent-service packages/agent-service

RUN pnpm --filter '@storepilot/shared-contracts' build \
 && pnpm --filter '@storepilot/agent-service' build

# 仅保留生产依赖（剪掉 devDeps，缩小 runtime 镜像）
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    CI=true pnpm install --prod --frozen-lockfile --force \
        --filter '@storepilot/agent-service...' \
        --filter '@storepilot/shared-contracts'

# --- 3) runtime：slim + 非 root + 仅产物 ----------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# wget 用于 docker healthcheck；ca-certificates 给 fetch HTTPS 用
RUN apt-get update \
    && apt-get install -y --no-install-recommends wget ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r app -g 10001 \
    && useradd  -r -g app -u 10001 -m -d /home/app -s /usr/sbin/nologin app

ENV NODE_ENV=production
ENV NODE_OPTIONS=--enable-source-maps

# 拷构建产物 + 生产依赖（保持 monorepo 目录布局给 workspace: 协议）
COPY --from=build --chown=app:app /app/package.json                                ./package.json
COPY --from=build --chown=app:app /app/pnpm-workspace.yaml                         ./pnpm-workspace.yaml
COPY --from=build --chown=app:app /app/node_modules                                ./node_modules
COPY --from=build --chown=app:app /app/packages/agent-service/package.json         ./packages/agent-service/package.json
COPY --from=build --chown=app:app /app/packages/agent-service/dist                 ./packages/agent-service/dist
COPY --from=build --chown=app:app /app/packages/agent-service/node_modules         ./packages/agent-service/node_modules
COPY --from=build --chown=app:app /app/packages/shared-contracts/package.json      ./packages/shared-contracts/package.json
COPY --from=build --chown=app:app /app/packages/shared-contracts/dist              ./packages/shared-contracts/dist
COPY --from=build --chown=app:app /app/packages/shared-contracts/node_modules      ./packages/shared-contracts/node_modules

USER app
EXPOSE 7100

# tini 收紧 PID 1，转发 SIGTERM 给 Node（与切片 20 优雅停机联动）
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "packages/agent-service/dist/server.js"]
