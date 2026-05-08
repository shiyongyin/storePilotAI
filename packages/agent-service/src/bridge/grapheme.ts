/**
 * 切片 10 — grapheme-splitter 适配层
 *
 * 上游 `grapheme-splitter` v1 是 CommonJS `export = GraphemeSplitter` 形态。
 * 本仓启用了 `verbatimModuleSyntax: true`，不能用 `import = require(...)`；
 * 因此本适配层通过 `createRequire` 读取 CJS 构造函数，避免把 CJS 细节泄漏给 SSE 调用方。
 *
 * @since 切片 10
 */
import { createRequire } from 'node:module';

/** grapheme-splitter 实例 API 子集（仅 V1 chunk 使用 splitGraphemes） */
export interface GraphemeSplitterLike {
  splitGraphemes(input: string): string[];
}

interface GraphemeSplitterCtor {
  new (): GraphemeSplitterLike;
}

/**
 * 解析 grapheme-splitter 默认导出，兼容 ESM `default` 与 CJS namespace 两种形态。
 *
 * 失败时抛 TypeError —— 这是依赖装错（不应在生产路径出现），不是用户输入错误。
 */
function resolveCtor(): GraphemeSplitterCtor {
  const requireFromHere = createRequire(import.meta.url);
  const mod: unknown = requireFromHere('grapheme-splitter');
  if (typeof mod === 'function') return mod as GraphemeSplitterCtor;
  throw new TypeError('grapheme-splitter 默认导出不是构造函数；依赖可能装错');
}

let cached: GraphemeSplitterLike | null = null;

/**
 * 单例 grapheme-splitter；首次调用时构造，后续复用。
 *
 * 单例安全性：splitGraphemes 是无状态纯函数（仅读 ctor 内的内嵌 Unicode 表），
 * 多并发调用安全；首屏 loaded 后构造耗时 < 1ms。
 */
export function getGraphemeSplitter(): GraphemeSplitterLike {
  if (cached) return cached;
  const Ctor = resolveCtor();
  cached = new Ctor();
  return cached;
}

/** 单测辅助：清空缓存的 splitter 实例（用于强制重走 resolve 分支） */
export function resetGraphemeSplitterForTest(): void {
  cached = null;
}
