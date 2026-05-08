/**
 * 切片 11 §9 第 6/7/11/12/13 步 — OutputValidator 单测
 *
 * 覆盖:
 *   - 50 条数字一致性样本(happy + 5 类形态 + 派生白名单 + 边界)
 *   - 注入伪造数字 → BizError(NUMBER_INCONSISTENT)
 *   - schema 失败优先级高于数字校验
 *   - 日期 / 时间 strip
 *   - 派生 *100 / /100 / round 容忍尾差
 *
 * 注:本切片只交付 helper;Skill 内重试逻辑在切片 12 / 14。
 */
import { BizError } from '@storepilot/shared-contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { extractNumbersFrom } from './numbers.js';
import { checkNumberConsistency, validateOutput } from './output-validator.js';

/** 50 条数字一致性样本(每条都必须 happy 通过) */
const HAPPY_SAMPLES: { name: string; md: string; allowed: Set<string> }[] = [
  // —— 普通整数 (10) ——
  { name: '单个整数', md: '销售额 12345 元', allowed: extractNumbersFrom([{ x: 12345 }]) },
  { name: '多个整数', md: '今日订单 42 单,客单价 88 元', allowed: extractNumbersFrom([{ a: 42, b: 88 }]) },
  { name: '常量 0', md: '今日缺货 0 个', allowed: new Set<string>() },
  { name: '常量 1', md: '只有 1 单', allowed: new Set<string>() },
  { name: '常量 7', md: '近 7 日数据', allowed: new Set<string>() },
  { name: '常量 14', md: '近 14 日预测', allowed: new Set<string>() },
  { name: '常量 30', md: '过期窗口 30 分钟', allowed: new Set<string>() },
  { name: '常量 60', md: '保质期 60 天', allowed: new Set<string>() },
  { name: '常量 90', md: '近 90 日复购', allowed: new Set<string>() },
  { name: '常量 100', md: '满 100 减 10', allowed: extractNumbersFrom([{ x: 10 }]) },

  // —— 普通小数 (5) ——
  { name: '小数', md: '客单价 88.5 元', allowed: extractNumbersFrom([{ a: 88.5 }]) },
  { name: '小数(高精度)', md: '汇率 7.2345 元/美元', allowed: extractNumbersFrom([{ a: 7.2345 }]) },
  { name: '小数(整数派生)', md: '采购量 12.5 单位', allowed: extractNumbersFrom([{ a: 12.5 }]) },
  { name: '0 小数(0.5)', md: '增长 0.5 倍', allowed: extractNumbersFrom([{ a: 0.5 }]) },
  { name: '负浮点尾差', md: '差异 0.3 元', allowed: extractNumbersFrom([{ a: 0.1 + 0.2 }]) },

  // —— 千分位 (10) ——
  { name: '千分位 7 位', md: '今年累计 1,234,567 元', allowed: extractNumbersFrom([{ a: 1234567 }]) },
  { name: '千分位 4 位', md: '当月销售 5,678 元', allowed: extractNumbersFrom([{ a: 5678 }]) },
  { name: '千分位带小数', md: '总额 1,234.56 元', allowed: extractNumbersFrom([{ a: 1234.56 }]) },
  { name: '千分位 8 位', md: '年度 12,345,678 元', allowed: extractNumbersFrom([{ a: 12345678 }]) },
  { name: '千分位与普通混合', md: '本月 5,000 元 / 上月 4500 元', allowed: extractNumbersFrom([{ a: 5000, b: 4500 }]) },
  { name: '千分位短(1,000)', md: '基础销量 1,000 个', allowed: extractNumbersFrom([{ a: 1000 }]) },
  { name: '千分位负号(-1,000)', md: '同比 -1,000 元', allowed: extractNumbersFrom([{ a: 1000 }]) },
  { name: '千分位 6 位', md: '总单数 100,000 单', allowed: extractNumbersFrom([{ a: 100000 }]) },
  { name: '千分位长(9 位)', md: '累计 999,999,999 元', allowed: extractNumbersFrom([{ a: 999999999 }]) },
  { name: '千分位带分数(.50)', md: '日均 1,234.50 元', allowed: extractNumbersFrom([{ a: 1234.5 }]) },

  // —— 百分比 (10) ——
  { name: '百分比 12.5%', md: '环比 12.5%', allowed: new Set(['0.125']) },
  { name: '百分比 100%', md: '完成率 100%', allowed: new Set<string>() },
  { name: '百分比 0%', md: '退货率 0%', allowed: new Set<string>() },
  { name: '百分比 1%', md: '损耗率 1%', allowed: new Set(['0.01']) },
  { name: '百分比 50%', md: '占比 50%', allowed: new Set(['0.5']) },
  { name: '百分比 25.5%', md: '占比 25.5%', allowed: new Set(['0.255']) },
  { name: '百分比从 number 派生', md: '环比 12.5%', allowed: extractNumbersFrom([{ rate: 0.125 }]) },
  { name: '百分比常量(1)', md: '占比 1%', allowed: extractNumbersFrom([{ x: 0.01 }]) },
  { name: '百分比与普通混合', md: '本月 100 单,环比 50%', allowed: extractNumbersFrom([{ x: 100, r: 0.5 }]) },
  { name: '百分比 0.5%', md: '损耗率 0.5%', allowed: extractNumbersFrom([{ x: 0.005 }]) },

  // —— 万亿 (10) ——
  { name: '万(无空格)', md: '本月销售 3万 元', allowed: extractNumbersFrom([{ x: 30000 }]) },
  { name: '万(有空格)', md: '本月销售 3 万 元', allowed: extractNumbersFrom([{ x: 30000 }]) },
  { name: '亿(无空格)', md: '集团年度 1.5亿', allowed: extractNumbersFrom([{ x: 150_000_000 }]) },
  { name: '亿(有空格)', md: '集团年度 1.5 亿', allowed: extractNumbersFrom([{ x: 150_000_000 }]) },
  { name: '万小数', md: '门店年度 50.5 万', allowed: extractNumbersFrom([{ x: 505_000 }]) },
  { name: '亿大数', md: '行业规模 100 亿', allowed: extractNumbersFrom([{ x: 10_000_000_000 }]) },
  { name: '亿派生(payload 是元)', md: '集团年度 1.5 亿', allowed: extractNumbersFrom([{ x: 150_000_000 }]) },
  { name: '万与普通混合', md: '本月 5 万,昨日 100 单', allowed: extractNumbersFrom([{ a: 50000, b: 100 }]) },
  { name: '万小整数(10 万)', md: '门店年度 10 万', allowed: extractNumbersFrom([{ x: 100000 }]) },
  { name: '亿派生 round', md: '行业规模 1 亿', allowed: extractNumbersFrom([{ x: 100_000_000 }]) },

  // —— 派生白名单 (5) ——
  {
    name: '## 数据来源 简单加法',
    md: ['# 报告', '本月销售 1500 元', '环比 -100 元', '## 数据来源', '1500 = 1000 + 500'].join('\n'),
    allowed: extractNumbersFrom([{ a: 1000, b: 500, c: 100 }]),
  },
  {
    name: '## 数据来源 百分比派生',
    md: [
      '# 月报',
      '环比增长 12.5%',
      '## 数据来源',
      '12.5% = (1250 - 1100) / 1100',
    ].join('\n'),
    allowed: extractNumbersFrom([{ a: 1250, b: 1100 }]),
  },
  {
    name: '## 数据来源 多行表达式',
    md: [
      '# 月报',
      '总销售额 5000 元 / 增长 200 元',
      '## 数据来源',
      '5000 = 4000 + 1000',
      '200 = 5000 - 4800',
    ].join('\n'),
    allowed: extractNumbersFrom([{ a: 4000, b: 1000, c: 4800 }]),
  },
  {
    name: '## 数据来源 含常量',
    md: ['# 月报', '总销售额 200 元', '## 数据来源', '200 = 100 + 100'].join('\n'),
    allowed: new Set<string>(),
  },
  {
    name: '## 数据来源 千分位派生',
    md: [
      '# 报告',
      '总额 1,234,567 元',
      '## 数据来源',
      '1,234,567 = 1,000,000 + 234,567',
    ].join('\n'),
    allowed: extractNumbersFrom([{ a: 1000000, b: 234567 }]),
  },
];

describe('safety/output-validator — 50 条数字一致性样本(happy)', () => {
  it.each(HAPPY_SAMPLES)('[$name]', ({ md, allowed }) => {
    expect(() => checkNumberConsistency(md, new Set(allowed))).not.toThrow();
  });

  it('happy 样本数 = 50', () => {
    expect(HAPPY_SAMPLES).toHaveLength(50);
  });
});

describe('safety/output-validator — 异常路径', () => {
  it('注入伪造数字(99999) → NUMBER_INCONSISTENT', () => {
    const allowed = extractNumbersFrom([{ x: 12345 }]);
    expect(() => checkNumberConsistency('本月销售 99999 元', allowed)).toThrow(BizError);
    try {
      checkNumberConsistency('本月销售 99999 元', allowed);
    } catch (e) {
      expect((e as BizError).code).toBe('NUMBER_INCONSISTENT');
      expect((e as BizError).message).toContain('99999');
    }
  });

  it('注入未授权千分位(1,234,567) → NUMBER_INCONSISTENT', () => {
    const allowed = extractNumbersFrom([{ x: 99 }]);
    expect(() => checkNumberConsistency('累计 1,234,567 元', allowed)).toThrow(/NUMBER_INCONSISTENT|1,234,567/);
  });

  it('百分比未派生 → NUMBER_INCONSISTENT', () => {
    const allowed = extractNumbersFrom([{ x: 0.5 }]);
    expect(() => checkNumberConsistency('环比 12.5%', allowed)).toThrow(BizError);
  });
});

describe('safety/output-validator — validateOutput (Zod 优先 + 数字校验)', () => {
  const SkillOutputSchema = z.object({
    summaryMarkdown: z.string(),
    cards: z.array(z.string()).default([]),
  });

  it('happy:schema + 数字双过 → 返回 parsed', () => {
    const out = validateOutput({
      schema: SkillOutputSchema,
      output: { summaryMarkdown: '今日销售 12345 元', cards: ['c1'] },
      allowedNumbers: extractNumbersFrom([{ x: 12345 }]),
    });
    expect(out.summaryMarkdown).toContain('12345');
    expect(out.cards).toEqual(['c1']);
  });

  it('schema 失败优先级高于数字校验(MUST §44)', () => {
    expect(() =>
      validateOutput({
        schema: SkillOutputSchema,
        output: { cards: [] }, // 缺 summaryMarkdown
        allowedNumbers: new Set(),
      }),
    ).toThrow(z.ZodError);
  });

  it('schema 通过但数字非法 → NUMBER_INCONSISTENT', () => {
    expect(() =>
      validateOutput({
        schema: SkillOutputSchema,
        output: { summaryMarkdown: '伪造销售 88888 元', cards: [] },
        allowedNumbers: new Set(),
      }),
    ).toThrow(BizError);
  });

  it('关闭数字一致性时:schema 通过但数字非法 → 返回 parsed', () => {
    const out = validateOutput({
      schema: SkillOutputSchema,
      output: { summaryMarkdown: '验证阶段允许 88888 元', cards: [] },
      allowedNumbers: new Set(),
      enforceNumberConsistency: false,
    });
    expect(out.summaryMarkdown).toContain('88888');
  });

  it('关闭数字一致性时:schema 失败仍优先抛 ZodError', () => {
    expect(() =>
      validateOutput({
        schema: SkillOutputSchema,
        output: { cards: [] },
        allowedNumbers: new Set(),
        enforceNumberConsistency: false,
      }),
    ).toThrow(z.ZodError);
  });

  it('summaryMarkdown 缺失时跳过数字检查(无 markdown 即无可校验数字)', () => {
    const NoMdSchema = z.object({ items: z.array(z.string()) });
    expect(() =>
      validateOutput({
        schema: NoMdSchema,
        output: { items: ['a'] },
        allowedNumbers: new Set(),
      }),
    ).not.toThrow();
  });

  it('summaryMarkdown 为空字符串时跳过数字检查', () => {
    expect(() =>
      validateOutput({
        schema: SkillOutputSchema,
        output: { summaryMarkdown: '', cards: [] },
        allowedNumbers: new Set(),
      }),
    ).not.toThrow();
  });
});

describe('safety/output-validator — 日期 / 时间 strip(MUST §49)', () => {
  it('日期 2026-05-07 不被当数字', () => {
    expect(() =>
      checkNumberConsistency('截止 2026-05-07,销售 12345 元', extractNumbersFrom([{ x: 12345 }])),
    ).not.toThrow();
  });

  it('多个日期串联不报错', () => {
    expect(() =>
      checkNumberConsistency(
        '从 2026-01-01 到 2026-05-07,共 10 天',
        new Set<string>(), // 10 不在常量,但... 实际"10"非常量必须 allowed
      ),
    ).toThrow(BizError);
  });

  it('时间 09:30 / 14:25 不被当数字', () => {
    expect(() =>
      checkNumberConsistency('开门时间 09:30,关门 21:00', new Set<string>()),
    ).not.toThrow();
  });
});

describe('safety/output-validator — *100 / /100 尾差容忍(MUST §50)', () => {
  it('元 / 分 单位换算(payload 1250 分 → md 12.5 元)', () => {
    const allowed = extractNumbersFrom([{ priceCents: 1250 }]);
    expect(() => checkNumberConsistency('客单价 12.5 元', allowed)).not.toThrow();
  });

  it('反向(payload 12.5 元 → md 1250 分)', () => {
    const allowed = extractNumbersFrom([{ priceYuan: 12.5 }]);
    expect(() => checkNumberConsistency('客单价 1250 分', allowed)).not.toThrow();
  });
});

describe('safety/output-validator — 派生白名单(MUST §46)', () => {
  it('rhs 全合法 → lhs 加入白名单(单行)', () => {
    const md = ['# 报告', '环比 12.5%', '## 数据来源', '12.5% = (1250 - 1100) / 1100'].join('\n');
    const allowed = extractNumbersFrom([{ a: 1250, b: 1100 }]);
    expect(() => checkNumberConsistency(md, allowed)).not.toThrow();
  });

  it('rhs 含未授权数字 → lhs 不加入白名单 → NUMBER_INCONSISTENT', () => {
    const md = ['# 报告', '环比 12.5%', '## 数据来源', '12.5% = (1250 - 9999) / 1100'].join('\n');
    const allowed = extractNumbersFrom([{ a: 1250, b: 1100 }]);
    expect(() => checkNumberConsistency(md, allowed)).toThrow(BizError);
  });

  it('rhs 含 allowlist 常量(100)→ 派生有效', () => {
    const md = ['# 报告', '占比 0.5', '## 数据来源', '0.5 = 50 / 100'].join('\n');
    const allowed = extractNumbersFrom([{ x: 50 }]);
    expect(() => checkNumberConsistency(md, allowed)).not.toThrow();
  });
});
