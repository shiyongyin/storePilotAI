/**
 * 切片 11 — Strategy LRU 缓存 + 30s invalidation 轮询(safety/strategy-cache)
 *
 * 职责:
 *   - 提供单例 LRU(max=256*8, ttl=60s),让多 Skill / 多 step 共享同一份合并结果。
 *   - 提供 startStrategyInvalidationPolling(args): 开启 setInterval 轮询
 *     `strategy_invalidation` 表 `invalidated_at > lastSeen` 的行,按 scope 清 LRU。
 *
 * MUST(违反即拒收):
 *   - LRU + invalidation 双重失效:不能只靠 TTL(MUST §40);TTL 60s 是兜底。
 *   - max = 256 * 8(256 商家 × 8 门店);ttl = 60_000(任务卡 §5)。
 *   - PLATFORM scope → cache.clear(); MERCHANT → 按 prefix 删; STORE → 删单 key。
 *   - 不允许 Skill 直接访问本 cache 实例;必须通过 mergeStrategy(strategy-engine.ts)。
 *
 * 实现要点:
 *   - 本模块**不**在加载时就 setInterval — 测试不希望一启动就跑定时器,
 *     生产由切片 20 / server.ts bootstrap 显式调用 startStrategyInvalidationPolling()。
 *   - lastSeen 初值为 epoch 0(等价 1970-01-01),首次轮询会捞历史所有行,
 *     这是有意行为: 启动期一次性"对账";后续只捞增量。
 */
import { LRUCache } from 'lru-cache';
import type { RowDataPacket } from 'mysql2';

/** 每商家最多 8 门店;LRU 上限 = 256 商家 × 8 门店 */
export const STRATEGY_CACHE_MAX = 256 * 8;
/** TTL 60s — 仅作 invalidation 漏单的兜底,不是主失效路径 */
export const STRATEGY_CACHE_TTL_MS = 60_000;
/** 默认 invalidation 轮询间隔 30s(任务卡 §5) */
export const STRATEGY_INVALIDATION_POLL_MS = 30_000;

/** 缓存的 strategy 条目 */
export interface CachedStrategyEntry {
  /** Zod parse 后的 effective strategy(unknown 以避免循环依赖 shared-contracts) */
  merged: unknown;
  /** 形如 M{m}-S{s}-P{p} 的 version 串(任务卡 §6.6) */
  version: string;
  /** 是否为降级返回(strategy_json 损坏时为 true,切片 12 / 17 据此禁用 HIGH risk Skill) */
  degraded: boolean;
}

/**
 * 全局单例 LRU(整个 agent-service 进程共享一份,符合"商家间互不影响"的 LRU 容量预算)。
 */
export const strategyCache = new LRUCache<string, CachedStrategyEntry>({
  max: STRATEGY_CACHE_MAX,
  ttl: STRATEGY_CACHE_TTL_MS,
});

/** strategy_invalidation 表的 scope 枚举,与 migrations/005 注释对齐 */
export type InvalidationScope = 'PLATFORM' | 'MERCHANT' | 'STORE';

/**
 * 一行 invalidation 信号(由 InvalidationLoader 产出,由轮询消费)。
 *
 * 与 migrations/005 真实列名对齐:
 *   - scope:         PLATFORM | MERCHANT | STORE
 *   - merchantId:    映射 strategy_invalidation.merchant_id(scope=PLATFORM 时为 null)
 *   - storeId:       映射 strategy_invalidation.store_id(scope ∈ {PLATFORM,MERCHANT} 时为 null)
 *   - invalidatedAt: 映射 strategy_invalidation.invalidated_at(用于增量游标)
 */
export interface InvalidationRow {
  scope: InvalidationScope;
  merchantId: string | null;
  storeId: string | null;
  invalidatedAt: Date;
}

/**
 * invalidation 行加载器(测试可注入 mock,生产用 mysql2 实现)。
 */
export interface InvalidationLoader {
  /**
   * 拉取 invalidatedAt > since 的所有行,按 invalidatedAt 升序返回。
   * 返回空数组表示无新增。
   */
  loadSince(since: Date): Promise<InvalidationRow[]>;
}

/**
 * strategy_invalidation 真实 MySQL loader 依赖的最小 Pool 形态。
 *
 * 与其它安全层模块保持 query-only DI，生产可注入 mysql2 Pool，测试可注入真实
 * integration Pool 或 fake pool。
 */
export interface StrategyInvalidationPool {
  query<T extends RowDataPacket[]>(
    sql: string,
    params?: unknown[],
  ): Promise<[T, unknown]>;
}

interface StrategyInvalidationDbRow extends RowDataPacket {
  scope: InvalidationScope;
  merchantId: string | null;
  storeId: string | null;
  invalidatedAt: Date | string;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * 构造真实 MySQL strategy_invalidation loader。
 *
 * SQL 与 migrations/005 对齐：
 *   - 游标列为 invalidated_at
 *   - scope=MERCHANT/STORE 分别读取 merchant_id / store_id
 *   - 按 invalidated_at + id 稳定排序，避免同毫秒多行乱序
 */
export function createMysqlStrategyInvalidationLoader(
  pool: StrategyInvalidationPool,
): InvalidationLoader {
  return {
    async loadSince(since: Date): Promise<InvalidationRow[]> {
      const [rows] = await pool.query<StrategyInvalidationDbRow[]>(
        `SELECT scope,
                merchant_id AS merchantId,
                store_id AS storeId,
                invalidated_at AS invalidatedAt
           FROM strategy_invalidation
          WHERE invalidated_at > ?
          ORDER BY invalidated_at ASC, id ASC`,
        [since],
      );
      return rows.map((row) => ({
        scope: row.scope,
        merchantId: row.merchantId,
        storeId: row.storeId,
        invalidatedAt: toDate(row.invalidatedAt),
      }));
    },
  };
}

/**
 * 把一行 invalidation 应用到 LRU。
 *
 * 规则(MUST §41):
 *   - PLATFORM → strategyCache.clear()(平台默认变更影响所有商家)
 *   - MERCHANT → 删除所有 `${merchantId}:` 前缀的 key(影响该商家所有门店)
 *   - STORE    → 删除单个 `${merchantId}:${storeId}` key
 *
 * @param row    invalidation 行
 * @param cache  目标 LRU(默认全局 strategyCache,测试可注入临时实例)
 */
export function applyInvalidation(
  row: InvalidationRow,
  cache: LRUCache<string, CachedStrategyEntry> = strategyCache,
): void {
  if (row.scope === 'PLATFORM') {
    cache.clear();
    return;
  }
  if (row.scope === 'MERCHANT' && row.merchantId) {
    const prefix = `${row.merchantId}:`;
    for (const key of cache.keys()) {
      if (typeof key === 'string' && key.startsWith(prefix)) cache.delete(key);
    }
    return;
  }
  if (row.scope === 'STORE' && row.merchantId && row.storeId) {
    cache.delete(`${row.merchantId}:${row.storeId}`);
  }
}

/**
 * 启动 invalidation 轮询。
 *
 * 行为:
 *   - 立即返回 stop 函数(供测试 / 优雅停机调用 clearInterval)。
 *   - 每 intervalMs 触发一次 loader.loadSince(lastSeen);命中行依次 applyInvalidation。
 *   - lastSeen 推进到当批最大 invalidatedAt(不会回退,避免重复处理)。
 *   - loader 失败仅打日志(由 onError 回调),不抛出避免打断 setInterval。
 *
 * @param args.loader     invalidation 加载器
 * @param args.intervalMs 轮询间隔毫秒(默认 30s)
 * @param args.cache      LRU 实例(默认全局 strategyCache)
 * @param args.onError    loader 异常回调(默认 swallow);生产应注入 logger.error
 * @param args.startSince 起始游标(默认 epoch 0,代表"对账历史所有行")
 * @returns 停止函数(调用后停止轮询)
 */
export function startStrategyInvalidationPolling(args: {
  loader: InvalidationLoader;
  intervalMs?: number;
  cache?: LRUCache<string, CachedStrategyEntry>;
  onError?: (err: unknown) => void;
  startSince?: Date;
}): () => void {
  const interval = args.intervalMs ?? STRATEGY_INVALIDATION_POLL_MS;
  const cache = args.cache ?? strategyCache;
  const onError = args.onError ?? (() => undefined);
  let lastSeen = args.startSince ?? new Date(0);
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return; // 防止上一次未完成时叠加调用(setInterval drift 自保)
    running = true;
    try {
      const rows = await args.loader.loadSince(lastSeen);
      for (const row of rows) applyInvalidation(row, cache);
      const tail = rows[rows.length - 1];
      if (tail && tail.invalidatedAt > lastSeen) lastSeen = tail.invalidatedAt;
    } catch (err) {
      onError(err);
    } finally {
      running = false;
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, interval);

  // Node setInterval 默认 keep alive 进程;允许 unref 让测试不被悬挂
  if (typeof handle.unref === 'function') handle.unref();

  return () => clearInterval(handle);
}

/**
 * 测试 / 边界用:手工触发一次 invalidation 拉取(等同于 setInterval 一次 tick)。
 */
export async function pollOnce(args: {
  loader: InvalidationLoader;
  since: Date;
  cache?: LRUCache<string, CachedStrategyEntry>;
}): Promise<{ nextSince: Date; consumed: number }> {
  const cache = args.cache ?? strategyCache;
  const rows = await args.loader.loadSince(args.since);
  for (const row of rows) applyInvalidation(row, cache);
  const tail = rows[rows.length - 1];
  const nextSince = tail && tail.invalidatedAt > args.since ? tail.invalidatedAt : args.since;
  return { nextSince, consumed: rows.length };
}
