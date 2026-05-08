/**
 * 切片 06 §9.4 — intentRouter 离线评测门禁。
 *
 * 不调用真实 LLM；用本地可复现分类器对 100 条标注样本做准确率回归。
 * 目标：IntentEnum 命中率 >= 90%，并且输出符合 shared-contracts 的 IntentRouterOutput。
 */
import { describe, expect, it } from 'vitest';

import { Intent, IntentRouterOutput, type IntentCode } from '@storepilot/shared-contracts';

import { classifyIntent } from './intent-classifier.js';

interface EvalCase {
  input: string;
  expected: IntentCode;
}

const rawCases: EvalCase[] = [
  ...[
    '今天 S001 卖得怎么样',
    '今日门店销售日报',
    '帮我看一下今天销售额',
    '昨天卖了多少',
    '今天门店业绩如何',
    '出一份今日经营日报',
    '今天销售概况给我',
    '昨日销售表现怎么样',
    '今天 S001 商品卖得好吗',
    '看下今天营收',
  ].map((input) => ({ input, expected: Intent.BUSINESS_DAILY_REPORT })),
  ...[
    '本月销售月报',
    '上个月经营情况',
    '给我月度经营报告',
    '这个月卖得怎么样',
    '看一下本月销售额',
    '月报发我',
    '统计一下上月业绩',
    '本月门店经营总览',
    '月度销售分析',
    '这个月门店表现',
  ].map((input) => ({ input, expected: Intent.BUSINESS_MONTHLY_REPORT })),
  ...[
    '给我一个补货计划',
    '哪些 SKU 需要补货',
    '明天该补多少货',
    '生成补货建议',
    '看下缺货风险并做补货方案',
    '帮我算补货量',
    '补货清单给我',
    '按库存生成补货计划',
    '需要采购哪些商品',
    '补货预测一下',
  ].map((input) => ({ input, expected: Intent.REPLENISHMENT_PLAN })),
  ...[
    '把补货草稿里的牛奶改成 20 箱',
    '调整补货建议，苹果少一点',
    '补货草稿数量改一下',
    '把采购建议里的 SKU123 删掉',
    '补货方案里香蕉加 5 件',
    '修改补货草稿',
    '调整刚才的补货单',
    '把草稿里的可乐数量减半',
    '补货明细需要改',
    '刚才那份补货计划调整一下',
  ].map((input) => ({ input, expected: Intent.ADJUST_REPLENISHMENT_DRAFT })),
  ...[
    '确认创建采购单',
    '确认下单',
    '提交采购单',
    '就按这个生成采购单',
    '确认提交补货采购',
    '采购单可以创建了',
    '同意下单',
    '按草稿创建采购订单',
    '确认生成 PO',
    '提交这份采购订单',
  ].map((input) => ({ input, expected: Intent.CONFIRM_CREATE_PURCHASE_ORDER })),
  ...[
    '取消刚才的补货草稿',
    '不要这份补货单了',
    '撤销补货草稿',
    '取消采购草稿',
    '放弃刚才的补货计划',
    '删掉这个补货草稿',
    '补货草稿作废',
    '不下单了，取消',
    '撤回补货方案',
    '取消这次采购建议',
  ].map((input) => ({ input, expected: Intent.CANCEL_REPLENISHMENT_DRAFT })),
  ...[
    '我希望以后能提醒滞销品',
    '能不能加一个库存预警功能',
    '建议做一个会员复购分析',
    '我想要自动提醒临期商品',
    '帮我记录一个需求：看新品表现',
    '以后能支持跨店对比吗',
    '我希望要个供应商评分功能',
    '能不能新增导出月报',
    '建议加一个夜间销售分析',
    '我想增加缺货自动提醒',
  ].map((input) => ({ input, expected: Intent.COLLECT_REQUIREMENT })),
  ...[
    '你好',
    '你是谁',
    '谢谢你',
    '你能做什么',
    '怎么使用这个助手',
    '早上好',
    '帮我介绍一下功能',
    '你支持哪些问题',
    '先聊一下',
    '晚上好',
  ].map((input) => ({ input, expected: Intent.GENERAL_QA })),
  ...[
    '毛利率是什么意思',
    '解释一下动销率',
    '周转天数怎么算',
    '客单价代表什么',
    '环比和同比有什么区别',
    '库存周转率怎么理解',
    '销售额为什么下降',
    '解释一下 SKU 动销',
    '毛利额怎么计算',
    '什么是滞销品',
  ].map((input) => ({ input, expected: Intent.EXPLAIN_METRIC })),
  ...[
    '今天卖得怎么样，顺便给我补货建议',
    '出月报并看看哪些商品要补货',
    '解释毛利率，再生成今日销售日报',
    '帮我看今天业绩，也把补货计划做了',
    '先取消草稿，再给我新的补货建议',
    '本月月报和采购建议一起给我',
    '今天销售和库存预警都看一下',
    '解释动销率并列出要补货的 SKU',
    '生成日报，同时记录一个导出需求',
    '看上月业绩，也帮我确认下单',
  ].map((input) => ({ input, expected: Intent.MULTI_INTENT })),
  ...[
    '今天天气怎么样',
    '给我讲个笑话',
    '帮我订一张机票',
    '打开店里的音乐',
    '老板电话是多少',
    '帮我写一首诗',
    '股票会涨吗',
    '明天适合旅游吗',
    '帮我查快递',
    '随便说点什么',
  ].map((input) => ({ input, expected: Intent.UNKNOWN })),
];

// 任务卡验收口径是 100 条；这里保留各组原始样本便于扩展，
// 当前门禁从前 10 个 intent 组各去掉 1 条，再保留 UNKNOWN 10 条。
const cases: EvalCase[] = rawCases.filter(
  (_item, index) => ![9, 19, 29, 39, 49, 59, 69, 79, 89, 99].includes(index),
);

describe('切片 06 — intentRouter 100 条离线评测', () => {
  it('评测样本必须正好 100 条，覆盖 11 个 IntentEnum', () => {
    expect(cases).toHaveLength(100);
    expect(new Set(cases.map((it) => it.expected))).toEqual(new Set(Object.values(Intent)));
  });

  it('classifyIntent 命中率必须 >= 90%', async () => {
    let hit = 0;
    const misses: Array<{ input: string; expected: IntentCode; actual: IntentCode }> = [];
    for (const item of cases) {
      const output = IntentRouterOutput.parse(await classifyIntent(item.input));
      if (output.intent === item.expected) hit += 1;
      else misses.push({ input: item.input, expected: item.expected, actual: output.intent });
    }
    expect(hit / cases.length, JSON.stringify(misses, null, 2)).toBeGreaterThanOrEqual(0.9);
  });

  it('非经营天气问题不得因为含"今天"误判成日报', async () => {
    for (const input of ['今天天气怎么样', '今天会下雨吗', '今天适合旅游吗']) {
      const output = IntentRouterOutput.parse(await classifyIntent(input));
      expect(output.intent, input).toBe(Intent.UNKNOWN);
    }
  });

  it('含业务词的今日问题仍识别为日报', async () => {
    for (const input of ['今天 S001 卖得怎么样', '今天销售额多少', '今日门店业绩如何']) {
      const output = IntentRouterOutput.parse(await classifyIntent(input));
      expect(output.intent, input).toBe(Intent.BUSINESS_DAILY_REPORT);
    }
  });

  it('补货建议短语必须优先识别为补货，不被泛化的"建议"误判成需求收集', async () => {
    for (const input of ['算一份 7 天补货建议', '生成补货建议', '给我补货建议']) {
      const output = IntentRouterOutput.parse(await classifyIntent(input));
      expect(output.intent, input).toBe(Intent.REPLENISHMENT_PLAN);
    }
  });

  it('上调 / 下调 / 设置数量等调整语义必须命中补货草稿调整', async () => {
    for (const input of ['把矿泉水上调 20%', '可乐下调 10%', '牛奶设置为 20 箱']) {
      const output = IntentRouterOutput.parse(await classifyIntent(input));
      expect(output.intent, input).toBe(Intent.ADJUST_REPLENISHMENT_DRAFT);
    }
  });
});
