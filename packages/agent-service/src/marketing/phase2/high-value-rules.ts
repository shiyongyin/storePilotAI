type MemberLevel = string;
type ScoreSource = 'TOOL' | 'DERIVED';

export interface HighValueMemberSegment {
  memberId: string;
  nameMasked: string;
  phoneMasked?: string;
  level: MemberLevel;
  lastVisitAt?: string;
  totalSpent: number;
  totalOrders: number;
  avgOrderValue?: number;
  segmentCode: string;
  matchReason: string;
  score?: number;
}

export interface HighValueMemberProfileSignal {
  points?: {
    points: number;
    pointsExpiringIn30d: number;
  };
  storageBalance?: {
    balance: number;
    totalRecharged: number;
    totalConsumed: number;
  };
}

export interface HighValueCampaignSignal {
  campaignId: string;
  campaignName: string;
  touchedMembers: number;
  convertedMembers: number;
  salesAmount: number;
  grossMarginRate: number;
  resultSummary: string;
}

export interface DerivedHighValueScore {
  value: number;
  formula: string;
}

export interface HighValueMaintenanceItem {
  memberId: string;
  nameMasked: string;
  phoneMasked: string;
  lastVisitAt: string;
  level: string;
  score: number;
  scoreSource: ScoreSource;
  reasonCode: 'HIGH_VALUE' | 'LOYAL_FREQUENT';
  valueEvidence: string;
  riskPreference: string;
  suggestedAction: string;
  suggestedScript: string;
}

export function deriveHighValueScore(args: {
  member: {
    totalSpent: number;
    totalOrders: number;
    avgOrderValue?: number;
    level: MemberLevel;
  };
  storageBalance?: number;
  maxValues: {
    totalSpent: number;
    totalOrders: number;
    avgOrderValue: number;
    storageBalance: number;
  };
  segmentCodes: readonly string[];
}): DerivedHighValueScore {
  const totalSpentScore = normalize(args.member.totalSpent, args.maxValues.totalSpent) * 0.35;
  const totalOrdersScore = normalize(args.member.totalOrders, args.maxValues.totalOrders) * 0.25;
  const avgOrderValueScore = normalize(args.member.avgOrderValue ?? 0, args.maxValues.avgOrderValue) * 0.15;
  const segmentScore = segmentBoost(args.member.level, args.segmentCodes) * 0.15;
  const storageScore = normalize(args.storageBalance ?? 0, args.maxValues.storageBalance) * 0.10;
  const value = clamp01(totalSpentScore + totalOrdersScore + avgOrderValueScore + segmentScore + storageScore) * 10;

  return {
    value: round1(value),
    formula: 'normalize(totalSpent)*0.35 + normalize(totalOrders)*0.25 + normalize(avgOrderValue)*0.15 + segmentBoost(HIGH_VALUE/VIP/GOLD)*0.15 + storageBoost(balance)*0.10',
  };
}

export function buildHighValueMaintenanceItems(args: {
  segments: readonly HighValueMemberSegment[];
  profilesByMember?: Record<string, HighValueMemberProfileSignal>;
  campaigns?: readonly HighValueCampaignSignal[];
  limit?: number;
  includeLowResponsive?: boolean;
}): HighValueMaintenanceItem[] {
  const grouped = new Map<string, HighValueMemberSegment[]>();
  for (const segment of args.segments) {
    if (segment.segmentCode === 'LOW_RESPONSIVE' && args.includeLowResponsive !== true) continue;
    if (!isHighValueSegment(segment.segmentCode)) continue;
    const current = grouped.get(segment.memberId) ?? [];
    current.push(segment);
    grouped.set(segment.memberId, current);
  }

  const maxValues = computeMaxValues(args.segments, args.profilesByMember ?? {});
  const items = [...grouped.entries()].map(([memberId, memberSegments]) => {
    const primary = choosePrimarySegment(memberSegments);
    const profile = args.profilesByMember?.[memberId];
    const toolScore = primary.score;
    const memberForScore = {
      totalSpent: primary.totalSpent,
      totalOrders: primary.totalOrders,
      level: primary.level,
      ...(primary.avgOrderValue === undefined ? {} : { avgOrderValue: primary.avgOrderValue }),
    };
    const scoreArgs = {
      member: memberForScore,
      maxValues,
      segmentCodes: memberSegments.map((segment) => segment.segmentCode),
      ...(profile?.storageBalance?.balance === undefined
        ? {}
        : { storageBalance: profile.storageBalance.balance }),
    } satisfies Parameters<typeof deriveHighValueScore>[0];
    const derived = deriveHighValueScore(scoreArgs);
    const itemArgs = {
      primary,
      segments: memberSegments,
      campaigns: args.campaigns ?? [],
      score: toolScore ?? derived.value,
      scoreSource: toolScore === undefined ? 'DERIVED' : 'TOOL',
      ...(profile === undefined ? {} : { profile }),
    } satisfies Parameters<typeof toMaintenanceItem>[0];
    return toMaintenanceItem(itemArgs);
  });

  return items
    .sort((a, b) => b.score - a.score)
    .slice(0, args.limit ?? 10);
}

export function buildHighValueMaintenanceMarkdown(args: {
  segments: readonly HighValueMemberSegment[];
  profilesByMember?: Record<string, HighValueMemberProfileSignal>;
  campaigns?: readonly HighValueCampaignSignal[];
  limit?: number;
  includeLowResponsive?: boolean;
}): string {
  const items = buildHighValueMaintenanceItems(args);
  const cardData = {
    cardType: 'member_wakeup_list_card',
    title: '重点客户维护清单',
    members: items.map((item, index) => ({
      memberId: item.memberId,
      nameMasked: item.nameMasked,
      phoneMasked: item.phoneMasked,
      lastVisitAt: item.lastVisitAt,
      suggestedScript: item.suggestedScript,
      reasonCode: item.reasonCode,
      priority: index + 1,
      suggestedAction: item.suggestedAction,
      confidence: item.score >= 8 ? 'HIGH' : 'MEDIUM',
    })),
  };

  if (items.length === 0) {
    return [
      '## 重点客户维护清单',
      '',
      '当前没有命中高价值熟客。可以稍后扩大查询范围，或确认会员数据是否已经同步。',
      '',
      `<!-- card_data:start -->${JSON.stringify(cardData)}<!-- card_data:end -->`,
    ].join('\n');
  }

  const lines = [
    '## 重点客户维护清单',
    '',
    '我按高价值和高频熟客信号排序；这里给维护动作和话术，不替你直接触达或执行优惠。',
    '',
    '| 顾客 | 价值依据 | 风险/偏好 | 维护动作 | 推荐话术 |',
    '|---|---|---|---|---|',
  ];

  for (const item of items) {
    lines.push(
      `| ${item.nameMasked} ${item.phoneMasked} | ${item.valueEvidence} | ${item.riskPreference} | ${item.suggestedAction} | ${item.suggestedScript} |`,
    );
  }

  lines.push('', `<!-- card_data:start -->${JSON.stringify(cardData)}<!-- card_data:end -->`);
  return lines.join('\n');
}

function toMaintenanceItem(args: {
  primary: HighValueMemberSegment;
  segments: readonly HighValueMemberSegment[];
  profile?: HighValueMemberProfileSignal;
  campaigns: readonly HighValueCampaignSignal[];
  score: number;
  scoreSource: ScoreSource;
}): HighValueMaintenanceItem {
  const storageBalance = args.profile?.storageBalance?.balance ?? 0;
  const valueEvidence = [
    `消费金额 ${args.primary.totalSpent} 元`,
    `到店/下单 ${args.primary.totalOrders} 次`,
    `客单价 ${args.primary.avgOrderValue ?? 0} 元`,
    args.scoreSource === 'TOOL' ? `工具排序分 ${args.score}` : `派生排序分 ${args.score}`,
    '毛利贡献：会员级毛利未返回',
    '活动响应：会员级明细未返回',
  ].join('；');

  const riskPreferenceParts = [];
  if (args.segments.some((segment) => segment.segmentCode === 'DORMANT_HIGH_VALUE')) {
    riskPreferenceParts.push('高价值但近期沉睡');
  }
  if (storageBalance > 0) {
    riskPreferenceParts.push(`储值余额 ${storageBalance} 元`);
  }
  if (args.primary.segmentCode === 'LOYAL_FREQUENT') {
    riskPreferenceParts.push('高频复购，适合常购款提醒');
  }
  if (args.campaigns.length > 0) {
    riskPreferenceParts.push('可参考历史老客活动表现');
  }

  const suggestedAction = chooseSuggestedAction(args.primary, storageBalance);

  return {
    memberId: args.primary.memberId,
    nameMasked: args.primary.nameMasked,
    phoneMasked: args.primary.phoneMasked ?? '手机号未同步',
    lastVisitAt: args.primary.lastVisitAt ?? '未同步',
    level: String(args.primary.level),
    score: args.score,
    scoreSource: args.scoreSource,
    reasonCode: args.primary.segmentCode === 'LOYAL_FREQUENT' ? 'LOYAL_FREQUENT' : 'HIGH_VALUE',
    valueEvidence,
    riskPreference: riskPreferenceParts.length > 0 ? riskPreferenceParts.join('；') : args.primary.matchReason,
    suggestedAction,
    suggestedScript: buildHighValueScript(args.primary.nameMasked, suggestedAction),
  };
}

function chooseSuggestedAction(segment: HighValueMemberSegment, storageBalance: number): string {
  if (storageBalance > 0) return '店主私信关怀，提醒余额并邀约新品预览';
  if (segment.segmentCode === 'LOYAL_FREQUENT') return '常购款到货提醒，搭配新品试穿邀约';
  return '一对一专属关怀，新品预览或生日关怀优先';
}

function buildHighValueScript(nameMasked: string, action: string): string {
  if (action.includes('余额')) {
    return `${nameMasked}，最近店里到了几款适合您日常穿的新款，我帮您先留意一下。您账户里还有余额，本周有空可以顺路来试试。`;
  }
  if (action.includes('常购款')) {
    return `${nameMasked}，您常看的款式最近有新配色到店，我帮您先留意尺码。本周方便的话可以来试试。`;
  }
  return `${nameMasked}，最近有几款适合您的新款到了，我想先邀请您来看看。您有空时我帮您提前留意合适尺码。`;
}

function choosePrimarySegment(segments: readonly HighValueMemberSegment[]): HighValueMemberSegment {
  return [...segments].sort((a, b) => {
    const scoreDelta = (b.score ?? 0) - (a.score ?? 0);
    if (scoreDelta !== 0) return scoreDelta;
    return segmentPriority(a.segmentCode) - segmentPriority(b.segmentCode);
  })[0]!;
}

function computeMaxValues(
  segments: readonly HighValueMemberSegment[],
  profilesByMember: Record<string, HighValueMemberProfileSignal>,
) {
  return {
    totalSpent: Math.max(1, ...segments.map((segment) => segment.totalSpent)),
    totalOrders: Math.max(1, ...segments.map((segment) => segment.totalOrders)),
    avgOrderValue: Math.max(1, ...segments.map((segment) => segment.avgOrderValue ?? 0)),
    storageBalance: Math.max(1, ...Object.values(profilesByMember).map((profile) => profile.storageBalance?.balance ?? 0)),
  };
}

function isHighValueSegment(segmentCode: string): boolean {
  return segmentCode === 'HIGH_VALUE' || segmentCode === 'LOYAL_FREQUENT' || segmentCode === 'DORMANT_HIGH_VALUE';
}

function segmentPriority(segmentCode: string): number {
  if (segmentCode === 'HIGH_VALUE') return 1;
  if (segmentCode === 'LOYAL_FREQUENT') return 2;
  if (segmentCode === 'DORMANT_HIGH_VALUE') return 3;
  return 99;
}

function segmentBoost(level: MemberLevel, segmentCodes: readonly string[]): number {
  if (segmentCodes.includes('HIGH_VALUE') || level === 'VIP') return 1;
  if (segmentCodes.includes('LOYAL_FREQUENT') || level === 'GOLD') return 0.75;
  if (level === 'SILVER') return 0.5;
  return 0.25;
}

function normalize(value: number, max: number): number {
  if (max <= 0) return 0;
  return clamp01(value / max);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
