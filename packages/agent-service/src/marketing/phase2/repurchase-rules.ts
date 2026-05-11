type RepurchaseConfidence = 'LOW' | 'MEDIUM' | 'HIGH';

export interface RepurchaseMemberSegment {
  memberId: string;
  nameMasked: string;
  phoneMasked?: string;
  lastVisitAt?: string;
  segmentCode: string;
  matchReason: string;
  score?: number;
}

export interface RepurchaseCycleSignal {
  memberId?: string;
  avgRepurchaseDays: number;
  daysSinceLastPurchase: number;
  confidence: RepurchaseConfidence;
  sampleSize: number;
}

export interface RepurchaseTiming {
  daysToNextExpected: number;
  overdueDays: number;
  nearnessRatio: number;
  dueText: string;
}

export interface RepurchaseReminderItem extends RepurchaseTiming {
  memberId: string;
  nameMasked: string;
  phoneMasked: string;
  lastVisitAt: string;
  frequentProducts: readonly string[];
  frequentProductText: string;
  avgRepurchaseDays: number;
  daysSinceLastPurchase: number;
  confidence: RepurchaseConfidence;
  confidenceLabel: string;
  sampleSize: number;
  sampleNote?: string;
  reason: string;
  suggestedAction: string;
  suggestedScript: string;
}

export function deriveRepurchaseTiming(args: {
  avgRepurchaseDays: number;
  daysSinceLastPurchase: number;
}): RepurchaseTiming {
  const daysToNextExpected = args.avgRepurchaseDays - args.daysSinceLastPurchase;
  const overdueDays = daysToNextExpected < 0 ? Math.abs(daysToNextExpected) : 0;
  const nearnessRatio = args.daysSinceLastPurchase / args.avgRepurchaseDays;
  let dueText = '预计今天到复购时间';
  if (daysToNextExpected < 0) {
    dueText = `已超过预计复购时间 ${overdueDays} 天`;
  } else if (daysToNextExpected > 0) {
    dueText = `预计 ${daysToNextExpected} 天后到复购时间`;
  }
  return {
    daysToNextExpected,
    overdueDays,
    nearnessRatio,
    dueText,
  };
}

export function buildRepurchaseReminderItems(args: {
  segments: readonly RepurchaseMemberSegment[];
  cycles: readonly RepurchaseCycleSignal[];
  frequentProductsByMember?: Record<string, readonly string[]>;
}): RepurchaseReminderItem[] {
  const cycleByMember = new Map(
    args.cycles
      .filter((cycle): cycle is RepurchaseCycleSignal & { memberId: string } => Boolean(cycle.memberId))
      .map((cycle) => [cycle.memberId, cycle]),
  );

  return args.segments
    .filter((segment) => segment.segmentCode === 'REPURCHASE_DUE')
    .map((segment) => {
      const cycle = cycleByMember.get(segment.memberId);
      if (cycle === undefined) return null;
      return toReminderItem(segment, cycle, args.frequentProductsByMember?.[segment.memberId] ?? []);
    })
    .filter((item): item is RepurchaseReminderItem => item !== null)
    .sort(compareReminderItems);
}

export function buildRepurchaseReminderMarkdown(args: {
  segments: readonly RepurchaseMemberSegment[];
  cycles: readonly RepurchaseCycleSignal[];
  frequentProductsByMember?: Record<string, readonly string[]>;
}): string {
  const items = buildRepurchaseReminderItems(args);
  const cardData = {
    cardType: 'member_wakeup_list_card',
    title: '复购周期提醒名单',
    members: items.map((item, index) => ({
      memberId: item.memberId,
      nameMasked: item.nameMasked,
      phoneMasked: item.phoneMasked,
      lastVisitAt: item.lastVisitAt,
      frequentSkus: item.frequentProducts,
      suggestedScript: item.suggestedScript,
      reasonCode: 'REPURCHASE_DUE',
      priority: index + 1,
      suggestedAction: item.suggestedAction,
      confidence: item.confidence,
    })),
  };

  if (items.length === 0) {
    return [
      '## 复购周期提醒',
      '',
      '当前没有命中快到复购周期的会员。可以稍后扩大查询范围，或确认会员消费数据是否已经同步。',
      '',
      `<!-- card_data:start -->${JSON.stringify(cardData)}<!-- card_data:end -->`,
    ].join('\n');
  }

  const lines = [
    '## 复购周期提醒',
    '',
    '我按复购周期和样本置信度排了提醒顺序；这里只提供名单、依据和可复制话术，具体触达由你确认后执行。',
    '',
    '| 顾客 | 常购商品 | 平均周期 | 距上次消费 | 到期状态 | 置信度 | 建议话术 |',
    '|---|---|---:|---:|---|---|---|',
  ];

  for (const item of items) {
    const confidenceText = item.sampleNote
      ? `${item.confidenceLabel}，${item.sampleNote}`
      : item.confidenceLabel;
    lines.push(
      `| ${item.nameMasked} ${item.phoneMasked} | ${item.frequentProductText} | ${item.avgRepurchaseDays} 天 | ${item.daysSinceLastPurchase} 天 | ${item.dueText} | ${confidenceText} | ${item.suggestedScript} |`,
    );
  }

  lines.push('', `<!-- card_data:start -->${JSON.stringify(cardData)}<!-- card_data:end -->`);
  return lines.join('\n');
}

function toReminderItem(
  segment: RepurchaseMemberSegment,
  cycle: RepurchaseCycleSignal,
  frequentProducts: readonly string[],
): RepurchaseReminderItem {
  const timing = deriveRepurchaseTiming({
    avgRepurchaseDays: cycle.avgRepurchaseDays,
    daysSinceLastPurchase: cycle.daysSinceLastPurchase,
  });
  const frequentProductText = frequentProducts.length > 0
    ? frequentProducts.join('、')
    : '近几次常买商品数据不足';
  const sampleIsSmall = cycle.confidence === 'LOW' || cycle.sampleSize < 3;

  const sampleFields = sampleIsSmall ? { sampleNote: '样本较小，仅做提醒参考' } : {};

  return {
    memberId: segment.memberId,
    nameMasked: segment.nameMasked,
    phoneMasked: segment.phoneMasked ?? '手机号未同步',
    lastVisitAt: segment.lastVisitAt ?? '未同步',
    frequentProducts,
    frequentProductText,
    avgRepurchaseDays: cycle.avgRepurchaseDays,
    daysSinceLastPurchase: cycle.daysSinceLastPurchase,
    confidence: cycle.confidence,
    confidenceLabel: sampleIsSmall ? `${cycle.confidence}（样本较小）` : cycle.confidence,
    sampleSize: cycle.sampleSize,
    reason: segment.matchReason,
    suggestedAction: sampleIsSmall ? '先做轻提醒，不做强结论' : '本周私信提醒常购品',
    suggestedScript: buildSuggestedScript(segment.nameMasked, frequentProductText, sampleIsSmall),
    ...sampleFields,
    ...timing,
  };
}

function buildSuggestedScript(
  nameMasked: string,
  frequentProductText: string,
  sampleIsSmall: boolean,
): string {
  if (frequentProductText === '近几次常买商品数据不足') {
    return `${nameMasked}，您最近的购买记录快到复购提醒窗口了。样本还不多，我先帮您留意适合的款式，本周有空可以来店里看看。`;
  }
  const prefix = sampleIsSmall ? '我先轻提醒一下，' : '';
  return `${nameMasked}，${prefix}您上次买的${frequentProductText}差不多到补货时间了。最近店里有适合您的新款，本周有空可以来店里看看。`;
}

function compareReminderItems(a: RepurchaseReminderItem, b: RepurchaseReminderItem): number {
  const scoreDelta = reminderBucket(a) - reminderBucket(b);
  if (scoreDelta !== 0) return scoreDelta;
  if (a.daysToNextExpected !== b.daysToNextExpected) {
    return a.daysToNextExpected - b.daysToNextExpected;
  }
  return confidenceWeight(b.confidence) - confidenceWeight(a.confidence);
}

function reminderBucket(item: RepurchaseReminderItem): number {
  if (item.confidence === 'HIGH' && item.daysToNextExpected <= 0) return 0;
  if (item.confidence !== 'LOW' && item.nearnessRatio >= 0.9) return 1;
  if (item.nearnessRatio >= 0.9) return 2;
  return 3;
}

function confidenceWeight(confidence: RepurchaseConfidence): number {
  if (confidence === 'HIGH') return 3;
  if (confidence === 'MEDIUM') return 2;
  return 1;
}
