type ActivationType = 'COUPON_EXPIRING' | 'STORAGE_BALANCE' | 'POINTS_EXPIRING' | 'UNUSED_COUPON';
type ActivationConfidence = 'HIGH' | 'MEDIUM';

export interface ActivationMemberSegment {
  memberId: string;
  nameMasked: string;
  phoneMasked?: string;
  level: string;
  lastVisitAt?: string;
  totalSpent: number;
  totalOrders: number;
  avgOrderValue?: number;
  segmentCode: string;
  matchReason: string;
  score?: number;
}

export interface ActivationProfileSignal {
  points: {
    points: number;
    pointsExpiringIn30d: number;
  };
  storageBalance: {
    balance: number;
    totalRecharged: number;
    totalConsumed: number;
  };
  couponSummary: {
    unusedCount: number;
    expiringIn7dCount: number;
  };
}

export interface ActivationCouponSignal {
  couponId: string;
  memberId?: string;
  memberNameMasked?: string;
  couponType: string;
  amount?: number;
  discount?: number;
  threshold?: number;
  validFrom: string;
  validTo: string;
  daysToExpire: number;
  status: string;
}

export interface ActivationOpportunity {
  amount: number | null;
  source: string;
}

interface EstimateActivationOpportunityArgs {
  activationType: ActivationType;
  storageBalance?: number | undefined;
  couponThreshold?: number | undefined;
  couponAmount?: number | undefined;
  avgOrderValue?: number | undefined;
  pointsExpiringIn30d?: number | undefined;
}

export interface ActivationItem {
  memberId: string;
  nameMasked: string;
  phoneMasked: string;
  activationType: ActivationType;
  groupTitle: string;
  basis: string;
  suggestedAction: string;
  suggestedScript: string;
  estimatedOpportunityText: string;
  estimatedOpportunitySource: string;
  confidence: ActivationConfidence;
}

export function estimateActivationOpportunity(args: EstimateActivationOpportunityArgs): ActivationOpportunity {
  if (args.activationType === 'STORAGE_BALANCE') {
    if (args.storageBalance === undefined || args.avgOrderValue === undefined) {
      return { amount: null, source: '储值余额或历史客单价未返回；不估金额' };
    }
    const amount = roundCurrency(Math.min(args.storageBalance, args.avgOrderValue));
    return {
      amount,
      source: `预估消费机会 = min(储值余额 ${args.storageBalance} 元, 历史客单价 ${args.avgOrderValue} 元)`,
    };
  }

  if (args.activationType === 'COUPON_EXPIRING' || args.activationType === 'UNUSED_COUPON') {
    if (args.couponThreshold !== undefined) {
      return {
        amount: args.couponThreshold,
        source: `预估消费机会 = 券门槛 ${args.couponThreshold} 元`,
      };
    }
    if (args.avgOrderValue !== undefined) {
      return {
        amount: roundCurrency(args.avgOrderValue),
        source: `预估消费机会 = 历史客单价 ${args.avgOrderValue} 元`,
      };
    }
    return { amount: null, source: '券门槛和历史客单价未返回；不估金额' };
  }

  return {
    amount: null,
    source: `积分即将过期 ${args.pointsExpiringIn30d ?? 0} 分；不估金额`,
  };
}

export function buildActivationItems(args: {
  segments: readonly ActivationMemberSegment[];
  profilesByMember: Record<string, ActivationProfileSignal | undefined>;
  coupons: readonly ActivationCouponSignal[];
}): ActivationItem[] {
  const segmentByMember = new Map(args.segments.map((segment) => [segment.memberId, segment]));
  const items: ActivationItem[] = [];

  for (const coupon of sortedCoupons(args.coupons)) {
    if (coupon.status !== 'UNUSED' || coupon.memberId === undefined) continue;
    const segment = segmentByMember.get(coupon.memberId);
    if (segment === undefined) continue;
    const activationType: ActivationType = coupon.daysToExpire <= 7 ? 'COUPON_EXPIRING' : 'UNUSED_COUPON';
    if (activationType !== 'COUPON_EXPIRING') continue;
    items.push(toCouponItem(segment, coupon, activationType));
  }

  for (const segment of args.segments) {
    const profile = args.profilesByMember[segment.memberId];
    if (profile === undefined) continue;

    if (profile.storageBalance.balance > 0 && isStorageActivationSegment(segment.segmentCode)) {
      items.push(toStorageItem(segment, profile));
    }

    if (profile.points.pointsExpiringIn30d > 0) {
      items.push(toPointsItem(segment, profile));
    }
  }

  return items.sort(compareActivationItems);
}

export function buildActivationMarkdown(args: {
  segments: readonly ActivationMemberSegment[];
  profilesByMember: Record<string, ActivationProfileSignal | undefined>;
  coupons: readonly ActivationCouponSignal[];
}): string {
  const items = buildActivationItems(args);
  const cardData = {
    cardType: 'member_wakeup_list_card',
    title: '储值/积分/券激活清单',
    members: items.map((item, index) => ({
      memberId: item.memberId,
      nameMasked: item.nameMasked,
      phoneMasked: item.phoneMasked,
      suggestedScript: item.suggestedScript,
      reasonCode: item.activationType,
      priority: index + 1,
      suggestedAction: item.suggestedAction,
      confidence: item.confidence,
    })),
  };

  const lines = [
    '## 储值/积分/券激活清单',
    '',
    '我按券、储值、积分三类分开整理；这里只提供提醒建议和话术，不替你执行扣积分、发券或群发。',
  ];

  for (const groupTitle of ['券快过期', '储值未消费', '积分即将过期']) {
    const groupItems = items.filter((item) => item.groupTitle === groupTitle);
    lines.push('', `## ${groupTitle}`);
    if (groupItems.length === 0) {
      lines.push('', '当前没有命中会员。');
      continue;
    }
    lines.push(
      '',
      '| 顾客 | 激活类型 | 依据 | 建议动作 | 建议话术 | 预估消费机会来源 |',
      '|---|---|---|---|---|---|',
    );
    for (const item of groupItems) {
      lines.push(
        `| ${item.nameMasked} ${item.phoneMasked} | ${item.groupTitle} | ${item.basis} | ${item.suggestedAction} | ${item.suggestedScript} | ${item.estimatedOpportunityText}；${item.estimatedOpportunitySource} |`,
      );
    }
  }

  lines.push('', `<!-- card_data:start -->${JSON.stringify(cardData)}<!-- card_data:end -->`);
  return lines.join('\n');
}

function toCouponItem(
  segment: ActivationMemberSegment,
  coupon: ActivationCouponSignal,
  activationType: Extract<ActivationType, 'COUPON_EXPIRING' | 'UNUSED_COUPON'>,
): ActivationItem {
  const opportunity = estimateActivationOpportunity({
    activationType,
    couponThreshold: coupon.threshold,
    couponAmount: coupon.amount,
    avgOrderValue: segment.avgOrderValue,
  });
  const basisParts = [
    `券 ${coupon.couponId} ${coupon.daysToExpire} 天后到期`,
    coupon.threshold === undefined ? null : `门槛 ${coupon.threshold} 元`,
    coupon.amount === undefined ? null : `面额 ${coupon.amount} 元`,
  ].filter((part): part is string => part !== null);

  return {
    memberId: segment.memberId,
    nameMasked: segment.nameMasked,
    phoneMasked: segment.phoneMasked ?? '手机号未同步',
    activationType,
    groupTitle: '券快过期',
    basis: basisParts.join('；'),
    suggestedAction: '提醒券即将到期，并结合常购或适合品类邀约到店',
    suggestedScript: `${segment.nameMasked}，您有一张券快到期了，适合这几天到店搭配常看的款式使用。`,
    estimatedOpportunityText: formatOpportunityText(opportunity),
    estimatedOpportunitySource: opportunity.source,
    confidence: 'HIGH',
  };
}

function toStorageItem(
  segment: ActivationMemberSegment,
  profile: ActivationProfileSignal,
): ActivationItem {
  const opportunity = estimateActivationOpportunity({
    activationType: 'STORAGE_BALANCE',
    storageBalance: profile.storageBalance.balance,
    avgOrderValue: segment.avgOrderValue,
  });
  return {
    memberId: segment.memberId,
    nameMasked: segment.nameMasked,
    phoneMasked: segment.phoneMasked ?? '手机号未同步',
    activationType: 'STORAGE_BALANCE',
    groupTitle: '储值未消费',
    basis: `储值余额 ${profile.storageBalance.balance} 元；45 天以上未到店`,
    suggestedAction: '提醒余额可用，搭配常购款或新品邀约',
    suggestedScript: `${segment.nameMasked}，您账户里还有余额可以用。最近店里到了几款适合日常穿的新款，本周有空可以来看看。`,
    estimatedOpportunityText: formatOpportunityText(opportunity),
    estimatedOpportunitySource: opportunity.source,
    confidence: 'HIGH',
  };
}

function toPointsItem(
  segment: ActivationMemberSegment,
  profile: ActivationProfileSignal,
): ActivationItem {
  const opportunity = estimateActivationOpportunity({
    activationType: 'POINTS_EXPIRING',
    pointsExpiringIn30d: profile.points.pointsExpiringIn30d,
    avgOrderValue: segment.avgOrderValue,
  });
  return {
    memberId: segment.memberId,
    nameMasked: segment.nameMasked,
    phoneMasked: segment.phoneMasked ?? '手机号未同步',
    activationType: 'POINTS_EXPIRING',
    groupTitle: '积分即将过期',
    basis: `30 天内将过期积分 ${profile.points.pointsExpiringIn30d} 分`,
    suggestedAction: '提醒积分即将过期，引导到店查看可兑换权益',
    suggestedScript: `${segment.nameMasked}，您有一部分积分快到期了。到店时可以一起看看适合兑换或搭配的权益。`,
    estimatedOpportunityText: formatOpportunityText(opportunity),
    estimatedOpportunitySource: opportunity.source,
    confidence: 'MEDIUM',
  };
}

function compareActivationItems(a: ActivationItem, b: ActivationItem): number {
  const typeDelta = activationRank(a.activationType) - activationRank(b.activationType);
  if (typeDelta !== 0) return typeDelta;
  return a.memberId.localeCompare(b.memberId);
}

function activationRank(type: ActivationType): number {
  if (type === 'COUPON_EXPIRING') return 1;
  if (type === 'STORAGE_BALANCE') return 2;
  if (type === 'POINTS_EXPIRING') return 3;
  return 4;
}

function isStorageActivationSegment(segmentCode: string): boolean {
  return segmentCode === 'DORMANT_WITH_STORAGE' || segmentCode === 'DORMANT_HIGH_VALUE';
}

function sortedCoupons(coupons: readonly ActivationCouponSignal[]): ActivationCouponSignal[] {
  return [...coupons].sort((a, b) => {
    if (a.daysToExpire !== b.daysToExpire) return a.daysToExpire - b.daysToExpire;
    return a.couponId.localeCompare(b.couponId);
  });
}

function formatOpportunityText(opportunity: ActivationOpportunity): string {
  return opportunity.amount === null ? '不估金额' : `预估 ${opportunity.amount} 元`;
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}
