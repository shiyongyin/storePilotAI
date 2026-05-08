/**
 * 切片 20 §10 — active-streams 单测（注册 / 解除 / 等待 / 强制 abort）
 *
 * 覆盖场景：
 *   1. register / unregister 计数（幂等）
 *   2. waitForActiveStreams 在所有流结束时立即返回 0
 *   3. waitForActiveStreams 在 timeoutMs 内未结束时返回剩余数（被强制中断的兜底依据）
 *   4. abortAllInflight 把所有 controller signal 切到 aborted=true，并清空注册表
 *   5. abortAllInflight 内单个 controller.abort 抛错时不阻断其它 controller
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetActiveStreamsForTest,
  _resetActiveStreamsPollIntervalForTest,
  _setActiveStreamsPollIntervalForTest,
  abortAllInflight,
  activeStreamCount,
  registerActiveStream,
  unregisterActiveStream,
  waitForActiveStreams,
} from './active-streams.js';

describe('safety/active-streams.ts — SSE 优雅停机辅助', () => {
  beforeEach(() => {
    _resetActiveStreamsForTest();
    _setActiveStreamsPollIntervalForTest(10);
  });

  afterEach(() => {
    _resetActiveStreamsForTest();
    _resetActiveStreamsPollIntervalForTest();
  });

  it('register / unregister 维护正确计数（幂等）', () => {
    const a = new AbortController();
    const b = new AbortController();

    expect(activeStreamCount()).toBe(0);
    registerActiveStream(a);
    registerActiveStream(b);
    registerActiveStream(a); // 幂等
    expect(activeStreamCount()).toBe(2);

    unregisterActiveStream(a);
    expect(activeStreamCount()).toBe(1);
    unregisterActiveStream(a); // 幂等：再 unregister 不抛
    expect(activeStreamCount()).toBe(1);

    unregisterActiveStream(b);
    expect(activeStreamCount()).toBe(0);
  });

  it('测试辅助拒绝非正整数 poll 间隔', () => {
    expect(() => _setActiveStreamsPollIntervalForTest(0)).toThrow(RangeError);
    expect(() => _setActiveStreamsPollIntervalForTest(1.5)).toThrow(RangeError);
  });

  it('waitForActiveStreams 在所有流结束时立即返回 0', async () => {
    const a = new AbortController();
    registerActiveStream(a);
    setTimeout(() => unregisterActiveStream(a), 30);

    const remaining = await waitForActiveStreams({ timeoutMs: 500 });
    expect(remaining).toBe(0);
  });

  it('waitForActiveStreams deadline 内未结束 → 返回剩余数', async () => {
    const a = new AbortController();
    const b = new AbortController();
    registerActiveStream(a);
    registerActiveStream(b);

    const remaining = await waitForActiveStreams({ timeoutMs: 50 });
    expect(remaining).toBe(2);
  });

  it('abortAllInflight 切所有 controller 为 aborted 并清空注册表', () => {
    const a = new AbortController();
    const b = new AbortController();
    registerActiveStream(a);
    registerActiveStream(b);

    expect(a.signal.aborted).toBe(false);
    expect(b.signal.aborted).toBe(false);

    abortAllInflight();

    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(activeStreamCount()).toBe(0);
  });

  it('abortAllInflight 单个 controller.abort 抛错不影响其它', () => {
    const a = new AbortController();
    const b = new AbortController();
    // 模拟 controller.abort 抛错（如已被外部 abort 后 signal 监听器抛错）
    // 注意：标准 AbortController.abort 不抛；这里通过覆写方法模拟边界
    Object.defineProperty(a, 'abort', {
      value: () => {
        throw new Error('listener boom');
      },
    });

    registerActiveStream(a);
    registerActiveStream(b);

    expect(() => abortAllInflight()).not.toThrow();
    expect(b.signal.aborted).toBe(true);
    expect(activeStreamCount()).toBe(0);
  });

  it('完整 SIGTERM 流程：等 deadline → 强制 abort → 清空', async () => {
    const a = new AbortController();
    registerActiveStream(a);

    // 25s deadline 模拟（这里用 50ms 探测 + 自动结束）
    const remaining = await waitForActiveStreams({ timeoutMs: 50 });
    expect(remaining).toBe(1);

    abortAllInflight();
    expect(a.signal.aborted).toBe(true);
    expect(activeStreamCount()).toBe(0);
  });
});
