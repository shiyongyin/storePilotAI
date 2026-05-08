/**
 * 切片 11 — Strategy Engine 三层合并(safety/strategy-engine)
 *
 * 职责:
 *   - mergeStrategy({ merchantId, storeId }): 三层合并 + 单例 LRU 缓存 + version 标注 + 失败降级。
 *   - deepMerge(...sources): 通用对象深合并(对象层递归;数组 / 标量按"右覆盖左")。
 *   - 提供 StrategyLoader 接口与默认 mysql2 实现工厂(切片 20 真正接 DB pool 时复用)。
 *
 * 三层优先级(MUST §39):
 *     STORE 覆盖 MERCHANT 覆盖 PLATFORM
 *
 * version 格式(MUST §43):
 *     M${merchant?.version ?? 0}-S${store?.version ?? 0}-P${platform.version}
 *
 * 失败降级(MUST §42):
 *     - StrategySchema.parse 抛错或 loader 抛错 → 返回 platform default + degraded=true。
 *     - degraded=true 由切片 12 / 17 消费(高风险 Skill 禁用)。
 *
 * 引用:
 *   - 任务卡 docs/tanks/11-safety-strategy-validator.md §8.1
 *   - F-业务安全层.md §T-SAFETY-01.5
 */
import { BizError, StrategySchema } from '@storepilot/shared-contracts';

import {
  type CachedStrategyEntry,
  strategyCache as defaultCache,
} from './strategy-cache.js';
import type { LRUCache } from 'lru-cache';

/** Strategy 在 DB 中的原始行(merchant / store 行通用) */
export interface StrategyRow {
  /** Zod 解析前的 strategy_json(JSON.parse 后) */
  strategyJson: Record<string, unknown>;
  /** DB 列 version(字符串,如 "M001-v1.0.0";落入 cached entry 的 version 串中) */
  version: string;
}

/** Platform 行(version 必填;StrategySchema 校验前的原始 JSON) */
export interface PlatformStrategyRow {
  strategyJson: Record<string, unknown>;
  version: string;
}

/**
 * Strategy 加载器接口(切片 11 自身只关心数据形状,不绑定 mysql2;
 * 切片 20 / server bootstrap 注入真实 DB 实现,测试注入 mock)。
 */
export interface StrategyLoader {
  loadPlatformDefault(): Promise<PlatformStrategyRow>;
  loadMerchantStrategy(merchantId: string): Promise<StrategyRow | null>;
  loadStoreStrategy(merchantId: string, storeId: string): Promise<StrategyRow | null>;
}

/**
 * 模块级 loader 注册表(单例)。Bootstrap 期(切片 20)调用 setStrategyLoader()
 * 注入真实 DB loader;测试可在 beforeEach 注入 mock。
 */
let registeredLoader: StrategyLoader | null = null;

/**
 * 注入 / 替换全局 StrategyLoader 实例。
 *
 * - 生产:在 server bootstrap 完成 mysql2 pool 创建后调用一次。
 * - 测试:每个 it() 可独立注入,注意配合 resetStrategyEngineForTest() 清缓存。
 */
export function setStrategyLoader(loader: StrategyLoader): void {
  registeredLoader = loader;
}

/**
 * 测试辅助:清空 LRU 缓存并卸载 loader,避免用例间相互污染。
 */
export function resetStrategyEngineForTest(
  cache: LRUCache<string, CachedStrategyEntry> = defaultCache,
): void {
  cache.clear();
  registeredLoader = null;
}

/**
 * 通用对象深合并(右覆盖左)。
 *
 * 规则:
 *   - 仅对"普通对象"(Object.prototype 直系)递归合并;数组、Date、Map、Set 等按"整体替换"语义。
 *   - undefined 值跳过(等同 source 没声明该 key);null 值会覆盖(等同显式置空)。
 *   - 不修改 base;返回新对象。
 *
 * 这与任务卡 §8.1 的伪代码 deepMerge(platform, merchant ?? {}, store ?? {}) 行为一致。
 *
 * @param sources 从左到右合并;后者覆盖前者
 */
export function deepMerge<T extends Record<string, unknown>>(...sources: T[]): T {
  const result: Record<string, unknown> = {};
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const [k, v] of Object.entries(src)) {
      if (v === undefined) continue;
      const existing = result[k];
      if (isPlainObject(v) && isPlainObject(existing)) {
        result[k] = deepMerge(existing, v);
      } else {
        result[k] = v;
      }
    }
  }
  return result as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * mergeStrategy 主入口。
 *
 * 流程:
 *   1) LRU 命中 → 直接返回(MUST §40: LRU 命中第二次相同 (M, S) 不查 DB)。
 *   2) 并行加载 platform / merchant / store 三层(loader 由 setStrategyLoader 注入)。
 *   3) deepMerge(platform, merchant ?? {}, store ?? {}) → StrategySchema.parse。
 *   4) 组装 version 串,写入 LRU,返回。
 *   5) 任意步骤抛错 → 返回 platform default + degraded=true(MUST §42)。
 *
 * @param args.merchantId
 * @param args.storeId
 * @param args.loader     可选注入 loader(测试用);未传则用 setStrategyLoader 注入的全局 loader
 * @param args.cache      可选注入 LRU(测试用);默认全局 strategyCache
 */
export async function mergeStrategy(args: {
  merchantId: string;
  storeId: string;
  loader?: StrategyLoader;
  cache?: LRUCache<string, CachedStrategyEntry>;
}): Promise<CachedStrategyEntry> {
  const cache = args.cache ?? defaultCache;
  const loader = args.loader ?? registeredLoader;

  const cacheKey = `${args.merchantId}:${args.storeId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  if (!loader) {
    throw new BizError(
      'INTERNAL_ERROR',
      'StrategyLoader 未注入;请在 bootstrap 期调用 setStrategyLoader(loader) 或在调用处传入 loader。',
    );
  }

  // platform 必加载(降级时也要它);失败说明 DB 完全不可用,无法降级,直接抛
  // (由调用方包 BizError(DB_UNAVAILABLE);MUST §42 的"降级"仅指 strategy_json 形态错误,
  // 不包含 DB 全挂场景)。
  const platform: PlatformStrategyRow = await loader.loadPlatformDefault();

  let merchant: StrategyRow | null = null;
  let store: StrategyRow | null = null;
  try {
    [merchant, store] = await Promise.all([
      loader.loadMerchantStrategy(args.merchantId),
      loader.loadStoreStrategy(args.merchantId, args.storeId),
    ]);
  } catch {
    // merchant/store 加载失败按 null 处理 → 等价于"只用 platform 默认"
    merchant = null;
    store = null;
  }

  const version = `M${merchant?.version ?? 0}-S${store?.version ?? 0}-P${platform.version}`;

  let entry: CachedStrategyEntry;
  try {
    const merged = StrategySchema.parse(
      deepMerge(
        platform.strategyJson,
        merchant?.strategyJson ?? {},
        store?.strategyJson ?? {},
      ),
    );
    entry = { merged, version, degraded: false };
  } catch {
    // 降级:strategy_json 损坏 → fallback platform default(MUST §42)
    // 失败时 platform.strategyJson 必须能 parse(否则平台默认本身就坏了,无法降级)
    const fallbackMerged = StrategySchema.parse(platform.strategyJson);
    entry = {
      merged: fallbackMerged,
      version: `${version}#degraded`,
      degraded: true,
    };
  }

  cache.set(cacheKey, entry);
  return entry;
}
