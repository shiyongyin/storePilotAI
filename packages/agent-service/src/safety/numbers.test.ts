/**
 * 切片 11 §9 第 8/9/10/13/14 步 — 数字规范化与提取单测
 *
 * 覆盖:
 *   - canonical: 整数 / 小数 / 浮点尾差 / 极小数
 *   - normalizeNumber: 5 类形态(普通 / 千分位 / 百分比 / 万亿)+ 空格 + 正负号
 *   - extractNumbersFrom: deep-walk + 派生 *100 / /100 / round(尾差容忍)
 *   - isAllowlistedConst: 8 个常量边界(任意第 9 个必须 false)
 */
import { describe, expect, it } from 'vitest';

import {
  canonical,
  extractNumbersFrom,
  isAllowlistedConst,
  normalizeNumber,
} from './numbers.js';

describe('safety/numbers — canonical', () => {
  it('整数直接 String', () => {
    expect(canonical(0)).toBe('0');
    expect(canonical(1)).toBe('1');
    expect(canonical(100)).toBe('100');
    expect(canonical(150_000_000)).toBe('150000000');
    expect(canonical(-12)).toBe('-12');
  });

  it('小数去尾随零', () => {
    expect(canonical(12.5)).toBe('12.5');
    expect(canonical(0.125)).toBe('0.125');
    expect(canonical(1.23)).toBe('1.23');
  });

  it('浮点尾差容忍(0.1 + 0.2 → 0.3)', () => {
    expect(canonical(0.1 + 0.2)).toBe('0.3');
  });

  it('极小数四舍为 0(<5e-9)', () => {
    expect(canonical(1e-10)).toBe('0');
  });

  it('NaN / Infinity 透传不参与等值', () => {
    expect(canonical(Number.NaN)).toBe('NaN');
    expect(canonical(Number.POSITIVE_INFINITY)).toBe('Infinity');
  });
});

describe('safety/numbers — normalizeNumber 5 类形态', () => {
  describe('普通整数 / 小数', () => {
    it.each([
      ['12345', '12345'],
      ['0', '0'],
      ['12.5', '12.5'],
      ['+12', '12'],
      ['-12', '12'],
    ])('普通 %s → %s', (raw, expected) => {
      expect(normalizeNumber(raw)).toBe(expected);
    });
  });

  describe('千分位', () => {
    it.each([
      ['1,234,567', '1234567'],
      ['1,234.56', '1234.56'],
      ['12,345', '12345'],
      ['-1,000', '1000'],
    ])('千分位 %s → %s', (raw, expected) => {
      expect(normalizeNumber(raw)).toBe(expected);
    });
  });

  describe('百分比', () => {
    it.each([
      ['12.5%', '0.125'],
      ['100%', '1'],
      ['0%', '0'],
      ['50%', '0.5'],
      ['0.5%', '0.005'],
    ])('百分比 %s → %s', (raw, expected) => {
      expect(normalizeNumber(raw)).toBe(expected);
    });
  });

  describe('万 / 亿(允许空格)', () => {
    it.each([
      ['3万', '30000'],
      ['3 万', '30000'],
      ['1.5亿', '150000000'],
      ['1.5 亿', '150000000'],
      ['10万', '100000'],
      ['100亿', '10000000000'],
    ])('万亿 %s → %s', (raw, expected) => {
      expect(normalizeNumber(raw)).toBe(expected);
    });
  });
});

describe('safety/numbers — extractNumbersFrom (deep-walk + 派生)', () => {
  it('扁平对象数字字段全提', () => {
    const set = extractNumbersFrom([{ a: 1, b: 2.5, c: 100 }]);
    expect(set.has('1')).toBe(true);
    expect(set.has('2.5')).toBe(true);
    expect(set.has('100')).toBe(true);
  });

  it('数组 / 嵌套对象递归', () => {
    const set = extractNumbersFrom([{ items: [{ qty: 12 }, { qty: 34 }], meta: { total: 46 } }]);
    expect(set.has('12')).toBe(true);
    expect(set.has('34')).toBe(true);
    expect(set.has('46')).toBe(true);
  });

  it('严格数字串识别("123" / "12.5"),非数字串忽略', () => {
    const set = extractNumbersFrom([{ s1: '123', s2: '12.5', s3: 'abc', s4: '12,345' }]);
    expect(set.has('123')).toBe(true);
    expect(set.has('12.5')).toBe(true);
    expect(set.has('abc')).toBe(false);
    // 千分位字符串不识别(那是 markdown 形态,不是工具返回形态)
    expect(set.has('12,345')).toBe(false);
  });

  it('派生 *100 / /100 / round 容忍尾差(元↔分)', () => {
    const set = extractNumbersFrom([{ amountCents: 1250 }]);
    expect(set.has('1250')).toBe(true); // 原值
    expect(set.has('12.5')).toBe(true); // /100 元
    expect(set.has('125000')).toBe(true); // *100
  });

  it('派生 round 容忍小数四舍', () => {
    const set = extractNumbersFrom([{ rate: 12.5 }]);
    expect(set.has('12.5')).toBe(true);
    expect(set.has('13')).toBe(true); // round(12.5) = 13
  });

  it('NaN / Infinity / null / undefined 不入集合', () => {
    const set = extractNumbersFrom([
      { a: Number.NaN, b: Number.POSITIVE_INFINITY, c: null, d: undefined },
    ]);
    expect(set.has('NaN')).toBe(false);
    expect(set.has('Infinity')).toBe(false);
  });
});

describe('safety/numbers — isAllowlistedConst (8 个常量,固定不增)', () => {
  it.each(['0', '1', '7', '14', '30', '60', '90', '100'])('白名单 %s → true', (n) => {
    expect(isAllowlistedConst(n)).toBe(true);
  });

  it('白名单刚好 8 个,任意第 9 个候选必须 false', () => {
    const candidates = ['2', '3', '5', '10', '15', '24', '50', '99', '101', '365', '1000'];
    for (const n of candidates) {
      expect(isAllowlistedConst(n)).toBe(false);
    }
  });
});
