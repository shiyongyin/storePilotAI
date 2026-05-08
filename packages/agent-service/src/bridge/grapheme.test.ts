/**
 * 切片 18 §8.6 — bridge/grapheme 单测（补充覆盖率门禁 ≥ 95%）
 *
 * 覆盖：
 *   - getGraphemeSplitter 单例（多次调用返回同一实例）
 *   - resetGraphemeSplitterForTest 后重新构造（cache 失效）
 *   - splitGraphemes 切分 emoji / 多字节字符（不切到半个 emoji）
 *   - resolveCtor 失败分支（依赖装错 → TypeError）
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getGraphemeSplitter, resetGraphemeSplitterForTest } from './grapheme.js';

describe('bridge/grapheme — 单例 + 切分语义', () => {
  afterEach(() => {
    resetGraphemeSplitterForTest();
    vi.restoreAllMocks();
  });

  it('多次 getGraphemeSplitter() 返回同一实例（单例守门）', () => {
    const a = getGraphemeSplitter();
    const b = getGraphemeSplitter();
    expect(a).toBe(b);
  });

  it('reset 后重新构造（cache 失效）', () => {
    const a = getGraphemeSplitter();
    resetGraphemeSplitterForTest();
    const b = getGraphemeSplitter();
    expect(a).not.toBe(b);
  });

  it('splitGraphemes 不把 emoji / 中文切到字节中间', () => {
    const s = getGraphemeSplitter();
    expect(s.splitGraphemes('门店')).toEqual(['门', '店']);
    expect(s.splitGraphemes('🎉🚀')).toEqual(['🎉', '🚀']);
    expect(s.splitGraphemes('M001')).toEqual(['M', '0', '0', '1']);
  });

  it('依赖装错 → TypeError（resolveCtor 失败分支）', async () => {
    // 强制重新走 resolveCtor 路径
    resetGraphemeSplitterForTest();
    // 用 vi.doMock 让 createRequire 返回非函数模拟"依赖装错"
    vi.doMock('node:module', () => ({
      createRequire: () => () => ({} as unknown), // 返回非函数
    }));
    // 通过动态 import 让 mock 生效（顶层 import 已绑定 createRequire 单例不可重置）
    const importPath = './grapheme.js?bust=' + String(Date.now());
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const mod = (await import(importPath)) as { getGraphemeSplitter: () => unknown };
    expect(() => mod.getGraphemeSplitter()).toThrow(TypeError);
  });
});
