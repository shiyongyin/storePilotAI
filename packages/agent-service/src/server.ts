import './observability/otel.js';

/**
 * 切片 06 — 必须**第一行** import OTel SDK（早于其他 import 副作用）
 * 切片 06 任务卡 §7 MUST DO §7：OTel 自动 instrument 必须在 Hono / pino / mysql2 加载前生效
 * 本文件任何写在 import './observability/otel.js' 之上的 import 都视为违规。
 */
/**
 * 切片 01 — Hono 启动壳 + /health（env zod fail-fast，启动 6 行绿灯第 1 / 第 6 行）
 * 切片 06 — 增 traceId 中间件 + child logger 注入 + createMastra() 启动
 * 切片 08 — 启动序列接入 verifyMcpToolsAtStartup（绿灯第 4 行）
 * 切片 20 — 启动序列 6 行绿灯完整化 + 优雅停机（25s SSE + abort + dispose + pool.end）：
 *
 *   getEnv()                → [startup] env-ok               (line 1)
 *   db.ping() + 11 表校验    → [startup] db-ok                (line 2，本切片落地真实 ping)
 *   mastraStorage.init()    → [startup] mastra-storage-ok    (line 3，切片 07 落地)
 *   verifyMcpToolsAtStartup → [startup] mcp-tools-verified   (line 4，切片 08 落地)
 *   verifySkillDef()  (hook)→ [startup] skill-def-verified   (line 5，仅 hook 占位 / 切片 21 落地)
 *   app.listen(env.PORT)    → [startup] listening :PORT      (line 6)
 *
 * 任一启动步骤失败 → process.exit(1) + 错误日志（切片 08 §7 MUST DO §4：含 missing/extra）。
 *
 * 优雅停机（任务卡 20 §7 MUST DO §4）：
 *   SIGTERM → server.close + waitForActiveStreams(25_000) + abortAllInflight
 *           + disposeMcpClient + closeMysqlStoragePool + process.exit(0)
 *   K8s terminationGracePeriodSeconds=35（25s SSE + 10s 保险），见 deploy/k8s/deployment.yaml。
 */
import { serve } from '@hono/node-server';
import { generateText } from 'ai';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import {
  chatCompletionsRouter,
  setDispatcher,
  setHitlPreDispatchHook,
} from './api/chat-completions.js';
import { createBusinessReportDispatcher } from './api/business-report-dispatcher.js';
import { health, setHealthDeps } from './api/health.js';
import { setAuthPool } from './bridge/auth.js';
import { getEnv } from './config/env.js';
import { classifyIntent } from './mastra/agents/intent-classifier.js';
import { createMastra } from './mastra/index.js';
import { getModel } from './mastra/llm-provider.js';
import {
  McpWhitelistError,
  disposeMcpClient,
  mcpTools,
  verifyMcpToolsAtStartup,
} from './mastra/mcp/client.js';
import { buildRuntimeContext } from './mastra/runtime-context.js';
import { createMysqlStorage } from './mastra/storage/mysql-adapter.js';
import {
  closeMysqlStoragePool,
  getOrCreateMysqlStoragePool,
  type MysqlStoragePool,
} from './mastra/storage/sql.js';
import {
  createPurchaseOrderStarter,
  createPurchaseOrderWorkflowHandle,
} from './mastra/workflows/purchase-order-hitl-runtime.js';
import {
  buildHttpRequestLogFields,
  logger,
  withTraceLogger,
} from './observability/logger.js';
import { createTraceId, isValidTraceId } from './observability/trace.js';
import {
  abortAllInflight,
  activeStreamCount,
  waitForActiveStreams,
} from './safety/active-streams.js';
import {
  SkillDefMismatchError,
  verifySkillDef as verifySkillDefImpl,
} from './mastra/agents/skill-registry.js';
import {
  PREEMPT_MARKDOWN_PREFIX,
  setConfirmManagerPool,
  setMastraResolver,
  setPurchaseOrderStarter,
  tickAtUserMessage,
  type ConfirmManagerPool,
} from './safety/confirm-manager.js';
import { setDraftPool } from './safety/draft-manager.js';
import { startCompensateMarkSubmittedCron } from './safety/jobs/compensate-mark-submitted.js';
import { startExpireDraftsCron } from './safety/jobs/expire-drafts.js';
import { startExpireSuspendedRunsCron } from './safety/jobs/expire-suspended-runs.js';
import { createMysqlStrategyLoader } from './safety/mysql-strategy-loader.js';
import { setStrategyLoader } from './safety/strategy-engine.js';

type ServerVars = {
  Variables: {
    traceId: string;
    log: ReturnType<typeof withTraceLogger>;
  };
};

/**
 * 切片 20 — 优雅停机时给 SSE 完成的预算窗口；K8s `terminationGracePeriodSeconds`
 * 必须 ≥ 35（25s SSE + 10s 保险，见 deploy/k8s/deployment.yaml）。
 */
const SHUTDOWN_SSE_GRACE_MS = 25_000;

/**
 * 切片 21 — `verifySkillDef` 真校验（替换切片 20 临时 hook）：
 *
 *   - 读 `agent_skill_def` 表所有行；
 *   - 与 createMastra workflows barrel 暴露的 5 个 Workflow id 严格相等
 *     （任务卡 §7 MUST DO §7 / §9 step 8 / §9 step 9）；
 *   - 缺一 / 多一 / required 项落到 disabled → 抛 `SkillDefMismatchError`；
 *   - 通过后输出绿灯日志 `[startup] skill-def-verified` + 缓存 SkillRegistry
 *     单例供 dispatcher 灰度网关使用。
 *
 * 任一步抛错 → bootstrap 顶层 catch → `process.exit(1)`（任务卡 §9 step 9：
 * 删一行 → 启动失败 + 错误信息含 missing / extra / disabledRequired）。
 */
async function verifySkillDef(storagePool: MysqlStoragePool): Promise<void> {
  await verifySkillDefImpl(storagePool);
}

/**
 * 切片 20 — 真实 db ping + 11 表存在性校验（取代切片 08 dbPingStub）。
 *
 * 通过标准（任务卡 §8.3 + §9 step 2）：
 *   1. `SELECT 1` 必须成功（连接池可达）
 *   2. `information_schema.tables WHERE table_schema = DATABASE()` 计数 ≥ 11
 *
 * 任一失败 → 抛错，bootstrap 顶层 catch → process.exit(1)。
 *
 * 注意：本函数与 `/health/db` 共享 11 表门禁，但**不**依赖 health 路由依赖注入；
 * 启动期直接拿 storagePool 跑，避免顺序耦合（先 db-ok 再 setHealthDeps）。
 *
 * @param storagePool 已在 bootstrap 第 2 行 `getOrCreateMysqlStoragePool(env)` 创建的进程内单例
 */
async function verifyDbAtStartup(storagePool: MysqlStoragePool): Promise<void> {
  await storagePool.query('SELECT 1 AS ok');
  const [rows] = await storagePool.query<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE()',
  );
  const cnt = Number(rows[0]?.cnt ?? 0);
  if (cnt < 11) {
    throw new Error(
      `[startup] db tables count=${cnt} < 11；请先 pnpm migrate:up（切片 03 落 13 张表）`,
    );
  }
  logger.info({ tables: cnt }, '[startup] db-ok');
}

/**
 * 把启动期共享 MySQL pool 适配成 ConfirmManagerPool。
 *
 * ConfirmManager 的 resume 锁必须在单连接事务中执行 `SELECT ... FOR UPDATE`，
 * 因此生产 pool 必须提供 transaction 能力；缺失时 fail-fast，避免 HITL 网关静默降级。
 */
function asConfirmManagerPool(storagePool: MysqlStoragePool): ConfirmManagerPool {
  if (!storagePool.transaction) {
    throw new Error('[startup] MysqlStoragePool 缺少 transaction，ConfirmManager 无法启用 resume 锁');
  }
  return {
    query: storagePool.query.bind(storagePool),
    execute: storagePool.execute.bind(storagePool),
    transaction: storagePool.transaction.bind(storagePool),
  };
}

/**
 * 启动序列（任务卡 20 §8.3）。
 * 任一步抛错 → 写错误日志后 process.exit(1)；不允许跳过任一步直接进入业务（§7 MUST NOT §1）。
 */
async function bootstrap(): Promise<void> {
  // line 1: env-ok
  const env = getEnv();
  logger.info('[startup] env-ok');

  // line 2: db-ok（切片 20 真实 ping + 11 表校验，取代切片 08 dbPingStub）
  // 单例 pool 在第一次创建时就持有 mysql2 连接池；后续 storage / draft / strategy 共享。
  const storagePool = getOrCreateMysqlStoragePool(env);
  await verifyDbAtStartup(storagePool);

  // line 3: mastra-storage-ok —— 切片 07 落地：三表存在性校验 + fail-fast。
  //   - storage.init() 缺任一表 → 抛错 → 上游 catch 后 process.exit(1)。
  //   - logger.info('[startup] mastra-storage-ok') 在 init() 内部输出。
  const storage = createMysqlStorage({ env, pool: storagePool });
  await storage.init();

  // 实例化 Mastra；红线 3：不传 memory（双保险：mysql-adapter saveMemory/loadMemory
  // 抛 NOT_IMPLEMENTED_IN_V1）。createMastra 不再触发 storage 副作用（切片 07 上移）。
  createMastra();

  // line 4: mcp-tools-verified —— 切片 08 主交付：严格 7 工具白名单校验
  await verifyMcpToolsAtStartup();

  // line 5: skill-def-verified（切片 21 落地：5 行 agent_skill_def 与 createMastra
  // workflows barrel 严格相等；缺一抛错 → process.exit(1)）。
  await verifySkillDef(storagePool);

  // 切片 09 V2.1 补丁 — 注入 AuthPool；缺则 /v1/chat/completions 鉴权直接 401。
  // 复用 storagePool，全 workspace 共用同一个 mysql2 连接池。
  setAuthPool(storagePool);

  // 切片 11 V2.1 补丁 — 注入 StrategyLoader；缺则 mergeStrategy 抛
  // `StrategyLoader 未注入...`，导致 BUSINESS_DAILY_REPORT / REPLENISHMENT_PLAN 等
  // 业务 case 在 dispatcher 内部被 friendlyMessage 兜底为"系统忙"。
  // 复用 storagePool；查 agent_merchant_strategy / agent_store_strategy。
  setStrategyLoader(createMysqlStrategyLoader(storagePool));

  // 切片 13 — 注入并注册 expire-drafts cron（5 分钟分批 UPDATE LIMIT 500 + sleep 100ms）。
  // 复用 storagePool，避免额外连接池；未注入会导致 cron tick 运行时报 DraftPool 未注入。
  setDraftPool(storagePool);
  const stopExpireDraftsCron = startExpireDraftsCron();

  // 切片 16 — 注册 expire-suspended-runs cron（5 分钟 LIMIT 200 FOR UPDATE SKIP LOCKED）。
  // 复用 storagePool 的 transaction 能力做 `SELECT ... FOR UPDATE` resume 锁；
  // 同时把同一个 Mastra 实例注入 resolver，保证 tick / cancel / confirm / cron 均使用生产依赖。
  setConfirmManagerPool(asConfirmManagerPool(storagePool));
  setMastraResolver({
    getWorkflow: (workflowId) => {
      if (workflowId === 'purchase_order_create') {
        return createPurchaseOrderWorkflowHandle(storagePool);
      }
      throw new Error(`[startup] unsupported HITL workflow id: ${workflowId}`);
    },
  });
  setPurchaseOrderStarter(createPurchaseOrderStarter());
  const stopExpireSuspendedRunsCron = startExpireSuspendedRunsCron();

  // 切片 17 — 注册 markSubmitted 失败补偿 cron（1 分钟 LIMIT 100 + 30s grace + ERP 反查回填）。
  // 复用 storagePool（已 setDraftPool）与 mcpTools（默认参数走 default 单例），无需额外 DI。
  // 任一 tick 失败 swallow + audit log，不阻断主流程；下一轮 60s 后再扫。
  const stopCompensateMarkSubmittedCron = startCompensateMarkSubmittedCron();

  // 切片 20 — 注入 health 路由依赖（pool / mcpToolsFn / modelPingFn）。
  // 启动期 hook：模型 ping 走 ai.generateText({ prompt: 'ping', maxOutputTokens: 1 })，
  // 控制 token 成本并屏蔽 modelMessage 复杂输入；任意错误由 /health/model 内部 try/catch 转 503。
  setHealthDeps({
    pool: storagePool,
    mcpToolsFn: () => mcpTools(),
    modelPingFn: async () => {
      await generateText({
        model: getModel(),
        prompt: 'ping',
        maxOutputTokens: 1,
      });
    },
  });

  // 切片 16 — 注入桥接层 HITL pre-dispatch hook
  // - 在 dispatch 之前调用 ConfirmManager.tickAtUserMessage（任务卡 §7 MUST DO §2）
  // - 抢占（PREEMPT）场景返回 prependMarkdown，桥接层在 markdown 顶部加"已为您取消上一次的待确认采购单"
  setHitlPreDispatchHook(async ({ body, auth, sessionId, traceId }) => {
    const userMessage = [...body.messages].reverse().find((m) => m.role === 'user');
    const content = userMessage?.content?.trim() ?? '';
    if (!content) return {};

    const { intent } = await classifyIntent(content);
    const runtimeContext = buildRuntimeContext({
      traceId,
      sessionId,
      merchantId: auth.merchantId,
      storeId: auth.storeId,
      userId: auth.userId,
      apiKeyPrefix: auth.apiKeyPrefix,
      requestStartedAt: Date.now(),
    });
    const tick = await tickAtUserMessage({
      sessionId,
      userIntent: intent,
      runtimeContext,
    });
    if (tick.kind === 'CANCELLED') {
      return { prependMarkdown: PREEMPT_MARKDOWN_PREFIX };
    }
    return {};
  });
  setDispatcher(createBusinessReportDispatcher());

  const app = new Hono<ServerVars>();

  // 切片 09 V2.1 补丁 — CORS：让 LobeChat client 模式 / 浏览器侧 fetch 能直连 /v1/*。
  // env.CORS_ALLOWED_ORIGINS 是逗号分隔白名单（生产已禁 *，由 env.ts zod 校验）。
  // 注意：必须在 traceId 中间件之前注册，确保 OPTIONS preflight 直接由 cors() 短路返回，
  // 不被业务中间件拦截。
  const allowedOrigins = env.CORS_ALLOWED_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  app.use(
    '*',
    cors({
      origin: allowedOrigins,
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'X-Trace-Id'],
      exposeHeaders: ['X-Trace-Id'],
      credentials: false,
      maxAge: 600,
    }),
  );

  // 切片 06 §8.5 — traceId 5 层贯穿入口
  app.use('*', async (c, next) => {
    const startedAt = Date.now();
    const headerTrace = c.req.header('X-Trace-Id');
    const traceId = isValidTraceId(headerTrace) ? (headerTrace as string) : createTraceId();
    const log = withTraceLogger(traceId);
    c.set('traceId', traceId);
    c.set('log', log);
    c.header('X-Trace-Id', traceId);
    try {
      await next();
    } finally {
      log.info(
        buildHttpRequestLogFields({
          method: c.req.method,
          path: c.req.path,
          authorization: c.req.header('Authorization'),
          status: c.res.status,
          durationMs: Date.now() - startedAt,
        }),
        '[http] request',
      );
    }
  });

  // 切片 20 — 5 个 health 路由（/health 仅 liveness；/health/db / /health/mcp /
  // /health/model 用作烟雾；/health/ready 聚合 db + mcp 给 K8s readinessProbe）。
  app.route('/', health);

  // 切片 10 — POST /v1/chat/completions（OpenAI Chat Completions SSE + OutputGuard）。
  // chatCompletionsRouter 内部仅声明 `POST /chat/completions`，挂在 /v1 下生成最终 path。
  app.route('/v1', chatCompletionsRouter);

  const server = serve(
    {
      fetch: app.fetch,
      port: env.PORT,
    },
    (info) => {
      // line 6: listening :PORT
      logger.info(`[startup] listening :${info.port}`);
    },
  );

  /**
   * 切片 20 §7 MUST DO §4 — 优雅停机：
   *   1. logger.info '[shutdown] SIGTERM received'
   *   2. server.close()                       // 阻止接受新连接
   *   3. waitForActiveStreams({ timeoutMs: 25_000 })   // 给现有 SSE 25s 完成
   *   4. abortAllInflight()                   // 仍未完成的强制 abort（LLM/MCP）
   *   5. disposeMcpClient()                   // 释放 MCPClient（切片 08）
   *   6. stop cron + closeMysqlStoragePool()  // 切片 07/13/16/17 兜底
   *   7. logger.info '[shutdown] graceful exit' + process.exit(0)
   *
   * mcp/client.ts 也注册了 SIGTERM/SIGINT hook（模块顶层副作用 fire-and-forget），
   * disposeMcpClient 内部幂等（_client 置空后再次调用为 NOOP）。本 shutdown 串行 await，
   * 保证清理完成且日志完整。
   *
   * 进程级再注册 SIGTERM/SIGINT；信号最多触发一次本 handler（{ once: true }），
   * 重复信号直接 fall-through 走默认行为（避免 graceful 流程被自身打断）。
   */
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      logger.warn({ signal }, '[shutdown] already in progress; ignoring repeat signal');
      return;
    }
    shuttingDown = true;

    logger.info({ signal }, '[shutdown] SIGTERM received');

    // 1. 停止接受新连接（已建立的 SSE 不会被打断）
    server.close();

    // 2. 等 25s 让现有 SSE 自然完成
    const activeBefore = activeStreamCount();
    if (activeBefore > 0) {
      logger.info(
        { active: activeBefore, timeoutMs: SHUTDOWN_SSE_GRACE_MS },
        '[shutdown] waiting for active streams',
      );
    }
    const remaining = await waitForActiveStreams({ timeoutMs: SHUTDOWN_SSE_GRACE_MS });
    if (remaining > 0) {
      logger.warn({ remaining }, '[shutdown] deadline exceeded; aborting inflight streams');
    }

    // 3. abort 所有 LLM/MCP（remaining=0 时 NOOP）
    abortAllInflight();

    // 4. 释放 MCPClient（切片 08；幂等，模块顶层 hook 已 fire-and-forget 兜底过一次）
    await disposeMcpClient();

    // 5. 停 cron（切片 13 / 16 / 17）；避免 cron 与 pool.end 打架
    stopExpireDraftsCron();
    stopExpireSuspendedRunsCron();
    stopCompensateMarkSubmittedCron();

    // 6. 释放 mysql2 storage pool（切片 07）；幂等，未创建时 NOOP
    await closeMysqlStoragePool();

    logger.info({ signal }, '[shutdown] graceful exit');
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM').catch((e: unknown) => {
      logger.error({ err: e instanceof Error ? e.message : String(e) }, '[shutdown] SIGTERM failed');
      process.exit(1);
    });
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT').catch((e: unknown) => {
      logger.error({ err: e instanceof Error ? e.message : String(e) }, '[shutdown] SIGINT failed');
      process.exit(1);
    });
  });
}

void bootstrap().catch((e: unknown) => {
  if (e instanceof McpWhitelistError) {
    logger.error(
      {
        missing: e.missing,
        extra: e.extra,
        schemaMissing: e.schemaMissing,
        err: e.message,
      },
      '[startup] mcp tools verification failed; exiting',
    );
  } else if (e instanceof SkillDefMismatchError) {
    logger.error(
      {
        missing: e.missing,
        extra: e.extra,
        disabledRequired: e.disabledRequired,
        err: e.message,
      },
      '[startup] skill-def verification failed; exiting',
    );
  } else {
    logger.error(
      { err: e instanceof Error ? e.message : String(e) },
      '[startup] bootstrap failed; exiting',
    );
  }
  process.exit(1);
});
