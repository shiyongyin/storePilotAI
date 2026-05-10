/**
 * 切片 20 — 5 个健康检查路由（4 基础接口 + readiness 聚合）
 *
 * 严格按 docs/tanks/20-ops-deploy-health-graceful.md §7 / §8 + 任务卡 I-运维 §T-OPS-01.5 落地。
 *
 * 路由清单：
 *   GET /health         → 进程存活；liveness 唯一探针；返回 `{ status: 'UP' }`
 *   GET /health/db      → MySQL ping + 表数量校验（任务卡口径 ≥ 11 张表）
 *   GET /health/mcp     → MCP listToolsets + 7 工具白名单严格相等
 *   GET /health/model   → LLM 文本生成冒烟（generateText({ prompt: 'ping', maxOutputTokens: 1 })）
 *   GET /health/ready   → K8s readinessProbe；聚合 db + mcp（**不含 model**）
 *
 * 强约束（任务卡 §7）：
 *   1. liveness 仅 `/health`；K8s livenessProbe / Nginx /health location 都用它（避免 MCP/模型抖动反复杀容器）
 *   2. readinessProbe 仅 `/health/ready`，内部聚合 db + mcp，不调 model（外网模型抖动会让所有 pod 不可用）
 *   3. `/health/model` 仅用于发布前烟雾测试 / `pnpm verify:*`，绝不进 readiness 路径
 *   4. `/health` 必须 P95 < 100ms；不得在 liveness 路径里做任何 IO（仅返回 status）
 *   5. 5 个路由都通过 DI 注入依赖（pool / mcpToolsFn / generateTextFn），便于单测在不依赖真实 mysql / mcp / model 的前提下回归
 *
 * 设计决策：
 *   - 与 draft-manager / strategy-engine 同模式做模块级 DI（`setHealthDeps()`）；
 *     生产由 server bootstrap 注入；测试 beforeEach 注入 fake，afterEach 调用 reset。
 *   - `/health/db` 的"11 张表"门禁取自任务卡 §8.1 示例（`<11 tables`）；
 *     migrations 实际落地 13 张（10 业务 + 3 mastra），≥ 11 即通过；
 *     未来如减表导致 < 11，启动期 fail-fast（切片 07 三表校验）已有更严格的兜底。
 *   - `/health/model` 不依赖白名单，**只校验 LLM 网关可达性**；
 *     一次调用 maxOutputTokens=1，控制 token 成本；任意错误 → 503。
 *   - `/health/ready` 直接复用 `checkDb` / `checkMcp` 内部 helper，
 *     不再走 HTTP 自调，避免 K8s probe 嵌套触发额外网络调用 / 超时叠加。
 *
 * @since 切片 20
 */
import { Hono } from 'hono';

import {
  TOOL_WHITELIST,
  mcpTools as defaultMcpTools,
} from '../mastra/mcp/client.js';
import { logger } from '../observability/logger.js';

/* ============================================================================
 * 1) DI 接口与默认依赖
 * ========================================================================== */

/**
 * Health 路由依赖的最小 mysql2 Pool 子集。
 *
 * 与 {@link ../mastra/storage/sql.MysqlStoragePool} 形状一致，
 * 生产由 server bootstrap 注入同一个进程内单例 pool，避免连接数浪费。
 */
export interface HealthPool {
  query<T extends Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<[T[], unknown]>;
}

/**
 * MCP 工具列表函数签名 —— 与 `mastra/mcp/client.ts` 的 `mcpTools()` 保持一致；
 * 测试可注入 fake（返回少 / 多工具，验证 503 路径）。
 */
export type McpToolsFn = () => Promise<Record<string, unknown>>;

/**
 * 模型 ping 函数签名 —— 默认实现走 `ai.generateText({ model: getModel(), prompt: 'ping', maxOutputTokens: 1 })`；
 * 测试可注入 fake，避免真实 LLM 网关调用。
 */
export type ModelPingFn = () => Promise<void>;

export interface ExternalSkillsHealthSummary {
  enabled: boolean;
  count: number;
}

/**
 * Health 模块依赖注入容器。任一依赖未注入 → 该路由直接返回 503，绝不挂死或走默认网络调用。
 */
export interface HealthDeps {
  pool: HealthPool | null;
  mcpToolsFn: McpToolsFn | null;
  modelPingFn: ModelPingFn | null;
  externalSkills: ExternalSkillsHealthSummary;
}

const deps: HealthDeps = {
  pool: null,
  mcpToolsFn: null,
  modelPingFn: null,
  externalSkills: { enabled: false, count: 0 },
};

/**
 * 注入 Health 路由依赖（生产由 server bootstrap 调一次）。
 *
 * 参数中的字段为 `null` → 表示该 health 子项当前不可用（路由会直接 503）；
 * 这种语义让本地 `pnpm dev:agent` 可以在缺 LLM 网关的情况下仍然把 `/health` / `/health/db` 跑通。
 */
export function setHealthDeps(partial: Partial<HealthDeps>): void {
  if (partial.pool !== undefined) deps.pool = partial.pool;
  if (partial.mcpToolsFn !== undefined) deps.mcpToolsFn = partial.mcpToolsFn;
  if (partial.modelPingFn !== undefined) deps.modelPingFn = partial.modelPingFn;
  if (partial.externalSkills !== undefined) deps.externalSkills = partial.externalSkills;
}

/**
 * 测试辅助：清空全部依赖，避免用例间互相污染。
 *
 * @internal 测试专用
 */
export function resetHealthDepsForTest(): void {
  deps.pool = null;
  deps.mcpToolsFn = null;
  deps.modelPingFn = null;
  deps.externalSkills = { enabled: false, count: 0 };
}

/* ============================================================================
 * 2) 内部 helper（被 /health/db / /health/mcp / /health/ready 共享）
 * ========================================================================== */

/**
 * /health/db 与 /health/ready 共享的 DB 检查内部实现。
 *
 * 通过标准（任务卡 §8.1）：
 *   1. `SELECT 1` 必须成功（连接池可达）
 *   2. `information_schema.tables WHERE table_schema = DATABASE()` 计数 ≥ {@link MIN_TABLE_COUNT}
 *      （migrations 当前落 13 张：10 agent 侧 + 3 mastra；任务卡口径 11，预留 2 张安全边界）
 *
 * @returns `{ ok: true }` 或 `{ ok: false, reason }`；不抛错。
 */
const MIN_TABLE_COUNT = 11;

interface DbCheckResult {
  ok: boolean;
  reason?: string;
  tables?: number;
}

async function checkDb(): Promise<DbCheckResult> {
  if (!deps.pool) {
    return { ok: false, reason: 'pool not injected' };
  }
  try {
    await deps.pool.query('SELECT 1 AS ok');
    const [rows] = await deps.pool.query<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE()',
    );
    const cnt = Number(rows[0]?.cnt ?? 0);
    if (cnt < MIN_TABLE_COUNT) {
      return { ok: false, reason: `tables=${cnt} < ${MIN_TABLE_COUNT}`, tables: cnt };
    }
    return { ok: true, tables: cnt };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

interface McpCheckResult {
  ok: boolean;
  reason?: string;
  tools?: ReadonlyArray<string>;
}

async function checkMcp(): Promise<McpCheckResult> {
  const fn = deps.mcpToolsFn ?? defaultMcpTools;
  try {
    const tools = await fn();
    const found = Object.keys(tools).sort();
    const expected = [...TOOL_WHITELIST].sort();
    if (JSON.stringify(found) !== JSON.stringify(expected)) {
      return {
        ok: false,
        reason: `whitelist drift; found=${JSON.stringify(found)} expected=${JSON.stringify(expected)}`,
        tools: found,
      };
    }
    return { ok: true, tools: found };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function externalSkillsReadySummary(): {
  enabled: boolean;
  count: number;
  status: 'ok' | 'disabled';
} {
  return {
    enabled: deps.externalSkills.enabled,
    count: deps.externalSkills.count,
    status: deps.externalSkills.enabled ? 'ok' : 'disabled',
  };
}

/* ============================================================================
 * 3) 路由
 * ========================================================================== */

type HealthVars = {
  Variables: { traceId?: string };
};

/**
 * 5 个 health 路由 barrel。由 server.ts 通过 `app.route('/', health)` 挂载。
 */
export const health = new Hono<HealthVars>();

/**
 * GET /health — 进程存活（liveness 唯一探针）
 *
 * 强约束：
 *   - **绝不**做任何 IO（任务卡 §7 MUST NOT §6 + §3 性能 P95 < 100ms）
 *   - **绝不**接 MCP / 模型 / DB（避免抖动反复杀容器）
 */
health.get('/health', (c) => c.json({ status: 'UP' }));

/**
 * GET /health/db — MySQL 连接池 + 11 表存在性
 *
 * 通过 → `{ status: 'UP', tables: <count> }`
 * 失败 → 503 `{ status: 'DOWN', reason }`（K8s readinessProbe 据此摘流量）
 */
health.get('/health/db', async (c) => {
  const r = await checkDb();
  if (!r.ok) {
    logger.warn({ reason: r.reason }, '[health/db] DOWN');
    return c.json({ status: 'DOWN', reason: r.reason ?? 'unknown' }, 503);
  }
  return c.json({ status: 'UP', tables: r.tables });
});

/**
 * GET /health/mcp — MCP listToolsets + 7 工具白名单严格相等
 *
 * 通过 → `{ status: 'UP', tools: [...7], whitelist: [...7] }`
 * 失败 → 503 `{ status: 'DOWN', reason, whitelist }`
 *
 * 历史保留：切片 08 期间字段为 `protocolVersion / service`；切片 20 切换为统一形态，
 * `/health/mcp` 与 `/health/db` 同口径（status + reason + payload），
 * verify-slice-08 仍校验 `tools.length === 7` 不变。
 */
health.get('/health/mcp', async (c) => {
  const r = await checkMcp();
  if (!r.ok) {
    logger.warn({ reason: r.reason }, '[health/mcp] DOWN');
    return c.json(
      {
        status: 'DOWN',
        reason: r.reason ?? 'unknown',
        whitelist: [...TOOL_WHITELIST].sort(),
      },
      503,
    );
  }
  return c.json({
    status: 'UP',
    tools: r.tools,
    whitelist: [...TOOL_WHITELIST].sort(),
  });
});

/**
 * GET /health/model — LLM 文本生成冒烟（仅烟雾测试用）
 *
 * 通过 → `{ status: 'UP' }`
 * 失败 → 503 `{ status: 'DOWN', reason }`
 *
 * 强约束（任务卡 §7 MUST NOT §4 + §1）：
 *   - **绝不**进 readinessProbe（外网模型抖动 = 所有 pod 不可用）
 *   - 单次调用 maxOutputTokens=1，避免烟雾测试占 token 预算
 *   - modelPingFn 未注入 → 503 `{ reason: 'model ping not injected' }`，
 *     避免本地 dev 缺 MODEL_API_KEY 时把 `/health/model` 跑成长耗时挂死
 */
health.get('/health/model', async (c) => {
  if (!deps.modelPingFn) {
    return c.json({ status: 'DOWN', reason: 'model ping not injected' }, 503);
  }
  try {
    await deps.modelPingFn();
    return c.json({ status: 'UP' });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '[health/model] DOWN',
    );
    return c.json(
      { status: 'DOWN', reason: err instanceof Error ? err.message : String(err) },
      503,
    );
  }
});

/**
 * GET /health/ready — K8s readinessProbe 聚合接口
 *
 * 通过标准（任务卡 §7 MUST DO §1 / §2）：
 *   - **必须**聚合 `/health/db` + `/health/mcp`
 *   - **绝不**调 `/health/model`（外网抖动 = 所有 pod 不可用）
 *
 * 任一子项失败 → 503 + 详细 reason；运维据此定位摘流量根因。
 */
health.get('/health/ready', async (c) => {
  const [db, mcp] = await Promise.all([checkDb(), checkMcp()]);
  if (!db.ok || !mcp.ok) {
    return c.json(
      {
        status: 'DOWN',
        db: db.ok ? { status: 'UP' } : { status: 'DOWN', reason: db.reason },
        mcp: mcp.ok ? { status: 'UP' } : { status: 'DOWN', reason: mcp.reason },
        externalSkills: externalSkillsReadySummary(),
      },
      503,
    );
  }
  return c.json({
    status: 'UP',
    db: { status: 'UP', tables: db.tables },
    mcp: { status: 'UP', tools: mcp.tools },
    externalSkills: externalSkillsReadySummary(),
  });
});

/* ============================================================================
 * 4) 历史导出别名（避免 server.ts / verify-slice-08 旧路径破坏）
 * ========================================================================== */

/**
 * 切片 08 旧 barrel 名；切片 20 起以 {@link health} 为唯一 barrel，
 * 历史 import 路径继续可用直到下一次重构。
 *
 * @deprecated 请改用 {@link health}；切片 21 后清理。
 */
export const healthMcpRouter = health;
