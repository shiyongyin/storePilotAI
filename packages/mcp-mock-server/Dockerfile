# ============================================================================
# 切片 02 / T-INFRA-02 — mcp-mock-server 多阶段构建
# 比 agent-service 轻：不依赖 argon2 / mysql2，无需 python3/make/g++ 工具链
# 红线：runtime 不得 root；只装生产依赖
# 注意：本镜像仅用于本地 / CI；生产 compose（V2 切真实 ERP）不得包含本镜像
# ============================================================================

# --- 1) deps：纯 Node 依赖 --------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.7.0 --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY packages/mcp-mock-server/package.json packages/mcp-mock-server/
COPY packages/shared-contracts/package.json packages/shared-contracts/
COPY packages/agent-service/package.json packages/agent-service/

RUN --mount=type=cache,id=pnpm-store-mock,target=/pnpm/store \
    pnpm install --frozen-lockfile \
        --filter '@storepilot/mcp-mock-server...' \
        --filter '@storepilot/shared-contracts'

# --- 2) build：编译 TS -----------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json ./
COPY packages/shared-contracts packages/shared-contracts
COPY packages/mcp-mock-server  packages/mcp-mock-server

RUN pnpm --filter '@storepilot/shared-contracts' build \
 && pnpm --filter '@storepilot/mcp-mock-server'  build

RUN --mount=type=cache,id=pnpm-store-mock,target=/pnpm/store \
    CI=true pnpm install --prod --frozen-lockfile --force \
        --filter '@storepilot/mcp-mock-server...' \
        --filter '@storepilot/shared-contracts'

# --- 3) runtime：slim + 非 root -------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends wget ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r app -g 10001 \
    && useradd  -r -g app -u 10001 -m -d /home/app -s /usr/sbin/nologin app

ENV NODE_ENV=production
ENV NODE_OPTIONS=--enable-source-maps

COPY --from=build --chown=app:app /app/package.json                                ./package.json
COPY --from=build --chown=app:app /app/pnpm-workspace.yaml                         ./pnpm-workspace.yaml
COPY --from=build --chown=app:app /app/node_modules                                ./node_modules
COPY --from=build --chown=app:app /app/packages/mcp-mock-server/package.json       ./packages/mcp-mock-server/package.json
COPY --from=build --chown=app:app /app/packages/mcp-mock-server/dist               ./packages/mcp-mock-server/dist
COPY --from=build --chown=app:app /app/packages/mcp-mock-server/node_modules       ./packages/mcp-mock-server/node_modules
COPY --from=build --chown=app:app /app/packages/shared-contracts/package.json      ./packages/shared-contracts/package.json
COPY --from=build --chown=app:app /app/packages/shared-contracts/dist              ./packages/shared-contracts/dist
COPY --from=build --chown=app:app /app/packages/shared-contracts/node_modules      ./packages/shared-contracts/node_modules

USER app
EXPOSE 7300

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "packages/mcp-mock-server/dist/server.js"]
