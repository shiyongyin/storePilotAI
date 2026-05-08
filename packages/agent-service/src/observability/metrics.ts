/**
 * 切片 10 — Metrics 适配器（最小 stub；切片 21 完整化为真正的 P0 面板）
 *
 * 严格按 docs/tanks/10-bridge-sse-output-guard.md §7 MUST DO §11 + §8.2 落地。
 *
 * 当前实现说明：
 *   - 默认 {@link metrics} 仅落 pino 日志 + 内存计数器；切片 21（P0 告警面板：ELK / Grafana）
 *     会替换为真正的 OTel Metrics / Prometheus exporter。
 *   - 暴露 {@link setMetricsAdapter} / {@link resetMetricsAdapterForTest} 给单测注入 spy，
 *     避免污染生产 logger（与 bridge/auth.ts 的 setAuthPool 同模式）。
 *
 * 强约束：
 *   - 调用 {@link MetricsAdapter.increment} 必须保证 {@link logToolCallsLeak} 等
 *     P0 告警链路始终可达；任何 increment 实现必须 fail-soft（不得抛错冒泡 SSE）。
 *   - 不得在本文件直接读取 finalText / API Key 等敏感字段；调用方负责传入安全 hash 标记。
 *
 * @since 切片 10
 */
import { logger } from './logger.js';

/**
 * Metrics 上报最小接口。
 *
 * - `name`：约定使用 dot-snake_case，例如 `p0.tool_calls_leak` / `bridge.sse.chunk`。
 * - `value`：增量值（默认 1）；必须为非负有限数。
 * - `tags`：低基数标签（如 `{ intent: 'GENERAL_QA' }`）；不得放入 traceId / sessionId 等高基数字段。
 */
export interface MetricsAdapter {
  /**
   * 上报一次 counter increment；失败必须吞错（不得抛出）。
   */
  increment(name: string, value?: number, tags?: Record<string, string>): void;
}

/**
 * 默认 stub：仅 logger.info 落审计 + 进程内 Map 计数（重启清零）。
 *
 * 设计权衡：
 *   - 切片 10 的核心红线是 `metrics.increment('p0.tool_calls_leak')` 永远可达；
 *     真正的可观测面板由切片 21 落地，不阻塞 P0 防泄漏交付。
 *   - 进程内计数仅供单测断言使用（{@link MetricsAdapter} 不导出快照接口，
 *     单测请使用 {@link setMetricsAdapter} 注入 spy 适配器）。
 */
class StubMetricsAdapter implements MetricsAdapter {
  private readonly counters = new Map<string, number>();

  /** 见 {@link MetricsAdapter.increment}；失败仅本地 logger.warn，不向上抛。 */
  increment(name: string, value: number = 1, tags?: Record<string, string>): void {
    if (!Number.isFinite(value) || value < 0) {
      logger.warn({ metric: name, value }, '[metrics] increment skipped: invalid value');
      return;
    }
    const prev = this.counters.get(name) ?? 0;
    this.counters.set(name, prev + value);
    logger.info(
      { metric: name, value, total: prev + value, tags: tags ?? null },
      '[metrics] increment',
    );
  }
}

const DEFAULT_ADAPTER: MetricsAdapter = new StubMetricsAdapter();
let registered: MetricsAdapter = DEFAULT_ADAPTER;

/**
 * 给生产 / 单测注入自定义 metrics 适配器；切片 21 真正落地后会调用此函数注入 OTel 实现。
 *
 * @param adapter 自定义实现；需满足 {@link MetricsAdapter} 的 fail-soft 约束。
 */
export function setMetricsAdapter(adapter: MetricsAdapter): void {
  registered = adapter;
}

/** 测试辅助：重置为默认 stub adapter，避免用例间相互污染。 */
export function resetMetricsAdapterForTest(): void {
  registered = DEFAULT_ADAPTER;
}

/**
 * 全局 metrics 上报代理。所有业务代码统一调用 `metrics.increment(...)`，
 * 不得直接持有 {@link StubMetricsAdapter} 实例引用。
 */
export const metrics: MetricsAdapter = {
  increment(name, value, tags) {
    registered.increment(name, value, tags);
  },
};
