/**
 * 切片 19 — 构造 E2E 在用 Hono app（与 server.ts 同 app.route 但不启 listen）
 *
 * 严格按 docs/tanks/19-test-e2e-20-cases.md §6 / §7 落地：
 *   - 不依赖外网（任务卡 §7 MUST NOT §2）；
 *   - 真 MySQL（任务卡 §7 MUST NOT §3）；
 *   - 用 in-process MCP mock；
 *   - 用 setDispatcher 注入受控 dispatcher（避免 LLM 外网依赖）；
 *   - 兼容 startAgentForTest({ envOverrides }) 形态（任务卡 §7 MUST DO §10）。
 *
 * 用法：
 *   ```ts
 *   const handle = await startAgentForTest({
 *     poolFactory: () => mysqlPool,
 *     dispatcher: async (args) => ({ finalText: '...' }),
 *     mastraResolver: { getWorkflow: () => ({ resume: async () => ... }) },
 *   });
 *   const res = await handle.app.fetch(req);
 *   handle.cleanup();
 *   ```
 *
 * @since 切片 19
 */
import { Hono } from 'hono';

import {
  chatCompletionsRouter,
  resetDispatcherForTest,
  resetHitlPreDispatchHookForTest,
  setDispatcher,
  setHitlPreDispatchHook,
  type DispatchFn,
  type HitlPreDispatchHook,
} from '../../../src/api/chat-completions.js';
import {
  resetAuthPoolForTest,
  setAuthPool,
  type AuthPool,
} from '../../../src/bridge/auth.js';
import {
  resetConfirmManagerForTest,
  setConfirmManagerPool,
  setMastraResolver,
  type ConfirmManagerPool,
  type MastraResolver,
} from '../../../src/safety/confirm-manager.js';
import {
  resetDraftManagerForTest,
  setDraftPool,
  type DraftPool,
} from '../../../src/safety/draft-manager.js';
import {
  resetStrategyEngineForTest,
  setStrategyLoader,
  type StrategyLoader,
} from '../../../src/safety/strategy-engine.js';

/* ============================================================================
 * 类型
 * ========================================================================== */

export interface StartAgentArgs {
  /** AuthPool（命中 agent_api_key） */
  authPool?: AuthPool;
  /** DraftPool（命中 replenishment_draft） */
  draftPool?: DraftPool;
  /** ConfirmManagerPool（含 transaction） */
  confirmManagerPool?: ConfirmManagerPool;
  /** StrategyLoader（命中 agent_merchant_strategy / agent_store_strategy） */
  strategyLoader?: StrategyLoader;
  /**
   * Mastra workflow resolver（仅 HITL 链路用；
   * 默认 resume 抛 NOT_INJECTED 错误，方便发现忘了注入）
   */
  mastraResolver?: MastraResolver;
  /** 业务 dispatcher（任务卡 §6 — 受控 fixture 注入） */
  dispatcher?: DispatchFn;
  /** HITL 抢占 hook；不传则用 NULL（保持 chat-completions 默认行为） */
  hitlPreDispatchHook?: HitlPreDispatchHook | null;
}

export interface AgentTestHandle {
  /** Hono app（直接用 `app.fetch(req)` 驱动） */
  app: Hono;
  /** 一次性清理：撤销所有 DI hook */
  cleanup: () => void;
}

/* ============================================================================
 * 主函数
 * ========================================================================== */

/**
 * 构造一个最小可运行的 Hono app（路径与 server.ts 1:1）。
 *
 * 强约束（任务卡 §7 MUST NOT §6）：本函数本身不写 process.env；
 * 调用方在 beforeAll 用 vi.stubEnv 注入 env（见 ensureBaseEnv）。
 */
export function startAgentForTest(args: StartAgentArgs = {}): AgentTestHandle {
  if (args.authPool) setAuthPool(args.authPool);
  if (args.draftPool) setDraftPool(args.draftPool);
  if (args.confirmManagerPool) setConfirmManagerPool(args.confirmManagerPool);
  if (args.strategyLoader) setStrategyLoader(args.strategyLoader);
  if (args.mastraResolver) setMastraResolver(args.mastraResolver);
  if (args.dispatcher) setDispatcher(args.dispatcher);
  if (args.hitlPreDispatchHook !== undefined) {
    if (args.hitlPreDispatchHook === null) resetHitlPreDispatchHookForTest();
    else setHitlPreDispatchHook(args.hitlPreDispatchHook);
  }

  const app = new Hono();
  app.get('/health', (c) => c.json({ status: 'UP' }));
  app.get('/health/db', (c) =>
    c.json({ status: 'NOT_READY', detail: 'DB readiness 由切片 20 完整化' }, 503),
  );
  app.route('/v1', chatCompletionsRouter);

  const cleanup = (): void => {
    resetAuthPoolForTest();
    resetDraftManagerForTest();
    resetConfirmManagerForTest();
    resetStrategyEngineForTest();
    resetDispatcherForTest();
    resetHitlPreDispatchHookForTest();
  };

  return { app, cleanup };
}
