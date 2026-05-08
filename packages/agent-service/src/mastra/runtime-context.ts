/**
 * 切片 06 — RuntimeContext / AgentRuntime 7 字段
 * 严格按 docs/任务卡/D-Mastra.md §T-MASTRA-01.5.2 + 切片 06 任务卡 §8.2 落地。
 *
 * !! API drift（mastra 1.0 vs 任务卡 0.x 文本）!!
 * 任务卡 §8.2 写的是 `RuntimeContext<AgentRuntime>` 来自 `@mastra/core/runtime-context`；
 * mastra 1.0.0 已迁移为 `RequestContext<Values>` 来自 `@mastra/core/di`。
 * 本文件保留任务卡的"RuntimeContext"概念（导出 `RuntimeContext` 类型别名 + `buildRuntimeContext` 函数名），
 * 实现层用 mastra 1.0.0 的 `RequestContext`，语义完全一致（set/get/registry 三件套）。
 *
 * 7 字段（任务卡 §7 MUST DO §3）:
 *   traceId / sessionId / merchantId / storeId / userId / apiKeyPrefix / requestStartedAt
 */
import { RequestContext } from '@mastra/core/di';

export interface AgentRuntime extends Record<string, unknown> {
  traceId: string;
  sessionId: string;
  merchantId: string;
  storeId: string;
  userId: string;
  apiKeyPrefix: string;
  requestStartedAt: number;
}

/**
 * 任务卡概念 → 实现：mastra 1.0.x `RequestContext` = 任务卡 0.x `RuntimeContext`。
 * 下游切片（07/08/09/10/11..17）从本 barrel 导入，不要直接 import RequestContext。
 */
export type RuntimeContext<T extends Record<string, unknown> = AgentRuntime> = RequestContext<T>;

export function buildRuntimeContext(input: AgentRuntime): RuntimeContext<AgentRuntime> {
  const ctx = new RequestContext<AgentRuntime>();
  for (const [k, v] of Object.entries(input) as Array<
    [keyof AgentRuntime, AgentRuntime[keyof AgentRuntime]]
  >) {
    ctx.set(k, v as never);
  }
  return ctx;
}
