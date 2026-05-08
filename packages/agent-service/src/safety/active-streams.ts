/**
 * 切片 20 — 活跃 SSE 流追踪 + 优雅停机辅助
 *
 * 提供两类能力：
 *
 *   1. **register / unregister AbortController**
 *      桥接层 (chat-completions.ts) 在每个 SSE 请求开始时把请求级 AbortController 注册进来，
 *      finally 阶段移除；优雅停机阶段调用 {@link abortAllInflight} 让所有正在跑的 dispatcher
 *      / LLM / MCP 调用立即返回。
 *
 *   2. **waitForActiveStreams + abortAllInflight**
 *      SIGTERM 接到后：
 *        - server.close() 阻止新连接
 *        - 等 25s 让现有 SSE 自然完成（{@link waitForActiveStreams}）
 *        - 仍有未完成的 → 强制 abort（{@link abortAllInflight}）
 *        - 释放 MCPClient + DB pool
 *        - process.exit(0)
 *
 * 强约束（任务卡 §7 MUST DO §4）：
 *   - SIGTERM 必须给 SSE 25 秒平滑收尾，**绝不**立即 process.exit
 *   - 25s 之后未结束的请求强制 abort，避免一直挂死阻塞 K8s terminationGracePeriodSeconds=35
 *   - 该模块与 chat-completions.ts 解耦：register 只接 AbortController，
 *     不依赖 Hono / streamSSE / Mastra 任何实现细节
 *
 * @since 切片 20
 */

const activeStreams = new Set<AbortController>();

/**
 * 等待轮询步长（默认 50ms 用于测试快通；生产由 SIGTERM handler 间接走默认值）。
 *
 * @internal 测试可调；不打算暴露成生产配置项。
 */
let pollIntervalMs = 200;

/**
 * 测试辅助：把 wait 轮询步长调小，便于在 50ms 内复现优雅停机的 deadline 行为。
 *
 * @internal 测试专用
 */
export function _setActiveStreamsPollIntervalForTest(ms: number): void {
  if (!Number.isInteger(ms) || ms <= 0) {
    throw new RangeError(`poll 间隔必须正整数毫秒，收到 ${ms}`);
  }
  pollIntervalMs = ms;
}

/**
 * 测试辅助：复位为生产默认 200ms。
 *
 * @internal 测试专用
 */
export function _resetActiveStreamsPollIntervalForTest(): void {
  pollIntervalMs = 200;
}

/**
 * 注册一个活跃流（桥接层每个 SSE 请求开始时调用一次）。
 *
 * 多次 register 同一 controller 是幂等的（Set 语义）。
 */
export function registerActiveStream(controller: AbortController): void {
  activeStreams.add(controller);
}

/**
 * 解除注册（桥接层 finally 调用）。
 *
 * 不存在时静默；不抛错。
 */
export function unregisterActiveStream(controller: AbortController): void {
  activeStreams.delete(controller);
}

/**
 * 当前活跃流数量。
 *
 * 用于：
 *   - {@link waitForActiveStreams} 内部 deadline 判断
 *   - 测试断言
 *   - 运维 `/health/...` 调试日志（本切片暂未输出，保留 hook）
 */
export function activeStreamCount(): number {
  return activeStreams.size;
}

/**
 * 强制中断所有活跃流。
 *
 * 用于 SIGTERM 25s deadline 之后兜底；调用方 (server.ts shutdown) 再调
 * dispose MCPClient / pool.end / process.exit。
 *
 * 每个 controller.abort() 用 try/catch 兜底，不让"已 abort"等异常阻断后续清理。
 */
export function abortAllInflight(): void {
  for (const ctrl of [...activeStreams]) {
    try {
      ctrl.abort(new Error('graceful shutdown'));
    } catch {
      // 已 abort 或 abort signal 监听器抛错；不阻断后续控制器
    }
  }
  activeStreams.clear();
}

/**
 * 等待当前活跃流自然结束，直到 deadline。
 *
 * @param opts.timeoutMs 最大等待毫秒数（生产 25_000；测试可注 100）
 * @returns 结束时仍残留的活跃流数（0 = 全部完成；> 0 = 超时被切断）
 *
 * 实现说明：
 *   - 用轮询而非 EventEmitter，避免引入额外的事件订阅生命周期；
 *     200ms 步长在 25s 上限下最多 125 次 poll，CPU 损耗忽略不计。
 *   - 进程退出阶段，所有 setTimeout 不应被 unref（避免计时器先于 SSE 业务退出）。
 */
export async function waitForActiveStreams(opts: { timeoutMs: number }): Promise<number> {
  const deadline = Date.now() + opts.timeoutMs;
  while (activeStreams.size > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return activeStreams.size;
}

/**
 * 测试辅助：清空注册表。
 *
 * 用例间共享 module-level state 时务必 afterEach 调用，避免互相污染。
 *
 * @internal 测试专用
 */
export function _resetActiveStreamsForTest(): void {
  activeStreams.clear();
}
