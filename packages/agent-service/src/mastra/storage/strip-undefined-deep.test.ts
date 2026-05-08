/**
 * 切片 07 — stripUndefinedDeep 单测（任务卡 §7 MUST DO §3 / §10 测试场景 6）。
 *
 * 验证矩阵：
 *   - undefined 字段 / 数组元素 → 跳过（不留 null）
 *   - null 保留（与 undefined 区分；业务可能依赖 null 语义）
 *   - 嵌套对象 + 嵌套数组 + 同时混合
 *   - 非可枚举属性 / 非 plain object（Date / Map / Buffer）→ 原样返回
 *   - 与 JSON.stringify 串联：等价于"对象树先剥再序列化"
 */
import { describe, expect, it } from 'vitest';

import { stripUndefinedDeep } from './strip-undefined-deep.js';

describe('切片 07 — stripUndefinedDeep', () => {
  it('剥离对象中的 undefined 字段（保留 null）', () => {
    const out = stripUndefinedDeep({ a: undefined, b: 1, c: null });
    expect(out).toEqual({ b: 1, c: null });
  });

  it('递归剥离嵌套对象中的 undefined 字段', () => {
    const out = stripUndefinedDeep({
      x: { y: undefined, z: 'keep', deep: { w: undefined, k: true } },
    });
    expect(out).toEqual({ x: { z: 'keep', deep: { k: true } } });
  });

  it('数组中的 undefined 元素被跳过（不留 null 占位）', () => {
    const out = stripUndefinedDeep([1, undefined, 2, undefined, 3]);
    expect(out).toEqual([1, 2, 3]);
  });

  it('数组元素中的对象也递归剥离', () => {
    const out = stripUndefinedDeep([{ a: undefined, b: 1 }, { c: undefined }]);
    expect(out).toEqual([{ b: 1 }, {}]);
  });

  it('Date 实例原样返回（不当作 plain object 递归）', () => {
    const d = new Date('2026-05-07T01:00:00.000Z');
    const out = stripUndefinedDeep({ at: d, x: undefined });
    expect((out as { at: Date }).at).toBe(d);
  });

  it('原始类型 / null / undefined 顶层兜底', () => {
    expect(stripUndefinedDeep(1)).toBe(1);
    expect(stripUndefinedDeep('hi')).toBe('hi');
    expect(stripUndefinedDeep(null)).toBeNull();
    expect(stripUndefinedDeep(undefined)).toBeUndefined();
    expect(stripUndefinedDeep(true)).toBe(true);
  });

  it('JSON.stringify 串联：剥离后序列化无字段丢失', () => {
    const input = {
      a: undefined,
      b: 1,
      nested: { x: undefined, y: { z: undefined, w: 'keep' } },
      list: [{ k: undefined, v: 2 }],
    };
    const json = JSON.stringify(stripUndefinedDeep(input));
    expect(JSON.parse(json)).toEqual({
      b: 1,
      nested: { y: { w: 'keep' } },
      list: [{ v: 2 }],
    });
  });

  it('Mastra workflow snapshot 典型形态：嵌套 undefined 不污染落库 JSON', () => {
    const snapshot = {
      runId: 'run_x',
      phase: 'collecting',
      steps: [
        { id: 's1', status: 'OK', error: undefined },
        { id: 's2', status: 'PENDING', error: undefined, payload: { extra: undefined, n: 7 } },
      ],
    };
    const stripped = stripUndefinedDeep(snapshot);
    const json = JSON.stringify(stripped);
    expect(json).not.toContain('"error"');
    expect(json).not.toContain('"extra"');
    expect(JSON.parse(json)).toEqual({
      runId: 'run_x',
      phase: 'collecting',
      steps: [
        { id: 's1', status: 'OK' },
        { id: 's2', status: 'PENDING', payload: { n: 7 } },
      ],
    });
  });
});
