/**
 * 切片 06 — intentRouter 离线评测分类器。
 *
 * 生产主路径仍由 Mastra Agent 承接；本地分类器用于离线 eval、兜底和回归测试，
 * 避免把 100 条意图准确率门禁绑定到外部 LLM 可用性。
 */
import { Intent, type IntentCode, type IntentRouterOutput } from '@storepilot/shared-contracts';

import { withTrace } from '../../observability/trace.js';

type SignalName =
  | 'daily'
  | 'monthly'
  | 'replenishment'
  | 'adjust'
  | 'confirm'
  | 'cancel'
  | 'requirement'
  | 'general'
  | 'explain';

const SIGNAL_TO_INTENT: Record<Exclude<SignalName, 'general'>, IntentCode> = {
  daily: Intent.BUSINESS_DAILY_REPORT,
  monthly: Intent.BUSINESS_MONTHLY_REPORT,
  replenishment: Intent.REPLENISHMENT_PLAN,
  adjust: Intent.ADJUST_REPLENISHMENT_DRAFT,
  confirm: Intent.CONFIRM_CREATE_PURCHASE_ORDER,
  cancel: Intent.CANCEL_REPLENISHMENT_DRAFT,
  requirement: Intent.COLLECT_REQUIREMENT,
  explain: Intent.EXPLAIN_METRIC,
};

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((it) => it.test(text));
}

function detectSignals(input: string): Record<SignalName, boolean> {
  const text = input.trim().toLowerCase();
  const businessMetric = hasAny(text, [
    /经营|销售|生意|营收|业绩|订单|客流|客单价|营业|商品|库存|sku/,
    /卖得|卖了|卖多少|卖/,
  ]);
  const dailyPeriod = hasAny(text, [/今天|今日|昨日|昨天/]);
  const monthlyPeriod = hasAny(text, [/本月|上月|这个月|上个月/]);
  const monthly =
    hasAny(text, [/月报/]) ||
    (hasAny(text, [/月度/]) && businessMetric) ||
    (monthlyPeriod && businessMetric);
  return {
    daily:
      !monthly &&
      (hasAny(text, [/日报|营收|今日经营|销售概况|门店业绩/]) ||
        (dailyPeriod && businessMetric)),
    monthly,
    replenishment: hasAny(text, [/补货|缺货|补多少|采购哪些|补货量|补货清单|补货预测|补货方案|补货建议/]),
    adjust: hasAny(text, [
      /调整|修改|改成|改一下|删掉|加\s*\d|减半|少一点|补货明细需要改|刚才.*调整/,
      /上调\s*\d+%?|下调\s*\d+%?|设置为\s*\d+|改为\s*\d+/,
    ]),
    confirm: hasAny(text, [/确认.*(采购|下单|提交|生成|创建)|提交.*采购|同意下单|可以创建了|生成\s*po|创建采购订单/]),
    cancel: hasAny(text, [/取消|撤销|放弃|作废|撤回|不要这份|不下单/]),
    requirement: hasAny(text, [/我希望|能不能|建议|我想要|记录一个需求|以后能|新增|增加|加一个|支持跨店/]),
    general: hasAny(text, [/你好|你是谁|谢谢|你能做什么|怎么使用|早上好|晚上好|介绍一下功能|支持哪些问题|先聊一下/]),
    explain: hasAny(text, [/是什么意思|解释|怎么算|代表什么|区别|怎么理解|为什么|什么是|毛利率|动销率|周转|客单价|同比|环比|滞销|毛利额/]),
  };
}

function isExplicitMultiIntent(input: string): boolean {
  return /顺便|同时|也|一起|并|再|先.*再|和.*(都|一起)/.test(input);
}

function chooseIntent(input: string, signals: Record<SignalName, boolean>): IntentCode {
  const businessSignals: Array<Exclude<SignalName, 'general'>> = [
    'daily',
    'monthly',
    'replenishment',
    'adjust',
    'confirm',
    'cancel',
    'requirement',
    'explain',
  ];
  const active = businessSignals.filter((name) => signals[name]);
  if (active.length >= 2 && isExplicitMultiIntent(input)) return Intent.MULTI_INTENT;
  const priority: Array<Exclude<SignalName, 'general'>> = [
    'cancel',
    'confirm',
    'adjust',
    'replenishment',
    'requirement',
    'explain',
    'monthly',
    'daily',
  ];
  const first = priority.find((name) => signals[name]);
  if (first) return SIGNAL_TO_INTENT[first];
  if (signals.general) return Intent.GENERAL_QA;
  return Intent.UNKNOWN;
}

export async function classifyIntent(message: string): Promise<IntentRouterOutput> {
  return await withTrace('intent.detect', async (span) => {
    const signals = detectSignals(message);
    const intent = chooseIntent(message, signals);
    span.setAttribute('intent.code', intent);
    return await Promise.resolve({
      intent,
      confidence: intent === Intent.UNKNOWN ? 0.3 : 0.95,
      reason: intent === Intent.UNKNOWN ? '未命中 V1 支持的门店经营意图' : '本地规则命中意图关键词',
    });
  });
}
