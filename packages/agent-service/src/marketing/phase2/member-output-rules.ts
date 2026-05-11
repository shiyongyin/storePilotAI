type DormantSegmentCode =
  | 'DORMANT_HIGH_VALUE'
  | 'DORMANT_WITH_STORAGE'
  | 'DORMANT_WITH_COUPON'
  | 'COUPON_EXPIRING'
  | 'DORMANT_NORMAL'
  | 'LOW_RESPONSIVE';

export interface DormantMemberSegment {
  memberId: string;
  nameMasked: string;
  phoneMasked?: string;
  lastVisitAt?: string;
  segmentCode: string;
  matchReason: string;
}

export interface DormantCouponSignal {
  couponId: string;
  memberId?: string;
  daysToExpire: number;
  status: string;
}

export interface DormantMemberOutput {
  memberId: string;
  nameMasked: string;
  phoneMasked: string;
  lastVisitAt: string;
  reason: string;
  suggestedAction: string;
  suggestedScript: string;
}

export interface DormantMemberGroup {
  reasonCode: Exclude<DormantSegmentCode, 'LOW_RESPONSIVE' | 'COUPON_EXPIRING'>;
  title: string;
  members: DormantMemberOutput[];
}

const GROUP_ORDER: DormantMemberGroup['reasonCode'][] = [
  'DORMANT_HIGH_VALUE',
  'DORMANT_WITH_STORAGE',
  'DORMANT_WITH_COUPON',
  'DORMANT_NORMAL',
];

const GROUP_TITLES: Record<DormantMemberGroup['reasonCode'], string> = {
  DORMANT_HIGH_VALUE: '高价值沉睡',
  DORMANT_WITH_STORAGE: '储值沉睡',
  DORMANT_WITH_COUPON: '有券沉睡',
  DORMANT_NORMAL: '普通沉睡',
};

export function groupDormantMembers(args: {
  segments: readonly DormantMemberSegment[];
  coupons: readonly DormantCouponSignal[];
}): DormantMemberGroup[] {
  const couponMembers = new Set(
    args.coupons
      .filter((coupon) => coupon.status === 'UNUSED' && coupon.memberId !== undefined)
      .map((coupon) => coupon.memberId!),
  );
  const chosenByMember = new Map<string, DormantMemberSegment>();

  const priority = new Map<string, number>([
    ['DORMANT_HIGH_VALUE', 1],
    ['DORMANT_WITH_STORAGE', 2],
    ['COUPON_EXPIRING', 3],
    ['DORMANT_WITH_COUPON', 4],
    ['DORMANT_NORMAL', 5],
  ]);

  for (const segment of args.segments) {
    if (segment.segmentCode === 'LOW_RESPONSIVE') continue;
    const normalizedCode = normalizeDormantReason(segment.segmentCode, couponMembers.has(segment.memberId));
    if (normalizedCode === null) continue;
    const normalizedSegment = { ...segment, segmentCode: normalizedCode };
    const current = chosenByMember.get(segment.memberId);
    if (
      current === undefined ||
      (priority.get(normalizedSegment.segmentCode) ?? 99) <
        (priority.get(current.segmentCode) ?? 99)
    ) {
      chosenByMember.set(segment.memberId, normalizedSegment);
    }
  }

  return GROUP_ORDER.map((reasonCode) => ({
    reasonCode,
    title: GROUP_TITLES[reasonCode],
    members: [...chosenByMember.values()]
      .filter((segment) => segment.segmentCode === reasonCode)
      .map(toDormantMemberOutput),
  })).filter((group) => group.members.length > 0);
}

export function buildDormantMemberMarkdown(args: {
  segments: readonly DormantMemberSegment[];
  coupons: readonly DormantCouponSignal[];
}): string {
  const groups = groupDormantMembers(args);
  const cardData = {
    cardType: 'member_wakeup_list_card',
    members: groups.flatMap((group) =>
      group.members.map((member, index) => ({
        memberId: member.memberId,
        nameMasked: member.nameMasked,
        phoneMasked: member.phoneMasked,
        reasonCode: group.reasonCode,
        priority: index + 1,
        suggestedAction: member.suggestedAction,
        confidence: 'MEDIUM',
      })),
    ),
  };

  if (groups.length === 0) {
    return [
      '## 沉睡会员召回建议',
      '',
      '当前没有命中沉睡会员。可以稍后扩大查询范围，或确认会员数据是否已经同步。',
      '',
      `<!-- card_data:start -->${JSON.stringify(cardData)}<!-- card_data:end -->`,
    ].join('\n');
  }

  const lines = [
    '## 沉睡会员召回建议',
    '',
    '我按沉睡原因分组，优先联系高价值、有余额和券快过期的会员；这里只给名单、动作和话术，不替你直接发券或群发。',
  ];

  for (const group of groups) {
    lines.push('', `## ${group.title}`, '', '| 顾客 | 上次到店 | 原因 | 建议动作 | 可复制话术 |', '|---|---|---|---|---|');
    for (const member of group.members) {
      lines.push(
        `| ${member.nameMasked} ${member.phoneMasked} | ${member.lastVisitAt} | ${member.reason} | ${member.suggestedAction} | ${member.suggestedScript} |`,
      );
    }
  }

  lines.push('', `<!-- card_data:start -->${JSON.stringify(cardData)}<!-- card_data:end -->`);
  return lines.join('\n');
}

function normalizeDormantReason(segmentCode: string, hasConfirmedCoupon: boolean): DormantMemberGroup['reasonCode'] | null {
  if (segmentCode === 'DORMANT_HIGH_VALUE') return 'DORMANT_HIGH_VALUE';
  if (segmentCode === 'DORMANT_WITH_STORAGE') return 'DORMANT_WITH_STORAGE';
  if (segmentCode === 'DORMANT_NORMAL') return 'DORMANT_NORMAL';
  if (segmentCode === 'DORMANT_WITH_COUPON' && hasConfirmedCoupon) return 'DORMANT_WITH_COUPON';
  if (segmentCode === 'COUPON_EXPIRING' && hasConfirmedCoupon) return 'DORMANT_WITH_COUPON';
  return null;
}

function toDormantMemberOutput(segment: DormantMemberSegment): DormantMemberOutput {
  const phoneMasked = segment.phoneMasked ?? '手机号未同步';
  const lastVisitAt = segment.lastVisitAt ?? '未同步';
  if (segment.segmentCode === 'DORMANT_HIGH_VALUE') {
    return {
      memberId: segment.memberId,
      nameMasked: segment.nameMasked,
      phoneMasked,
      lastVisitAt,
      reason: segment.matchReason,
      suggestedAction: '店主私信专属关怀，提醒常购品或新品到店',
      suggestedScript: `${segment.nameMasked}，最近店里到了适合您的新款，我帮您先留意一下，有空来试试。`,
    };
  }
  if (segment.segmentCode === 'DORMANT_WITH_STORAGE') {
    return {
      memberId: segment.memberId,
      nameMasked: segment.nameMasked,
      phoneMasked,
      lastVisitAt,
      reason: segment.matchReason.includes('储值余额') ? segment.matchReason : `储值余额未消费；${segment.matchReason}`,
      suggestedAction: '提醒有余额未消费，并搭配常购品或新品邀约',
      suggestedScript: `${segment.nameMasked}，您账户里还有余额可以用，这两天有适合日常穿的新款，可以顺路来看看。`,
    };
  }
  if (segment.segmentCode === 'DORMANT_WITH_COUPON') {
    return {
      memberId: segment.memberId,
      nameMasked: segment.nameMasked,
      phoneMasked,
      lastVisitAt,
      reason: segment.matchReason.includes('券') ? segment.matchReason : `有未使用券；${segment.matchReason}`,
      suggestedAction: '提醒未用券或即将过期券，并说明可用商品或门槛',
      suggestedScript: `${segment.nameMasked}，您还有一张券快到期了，适合搭配最近常看的鞋款使用。`,
    };
  }
  return {
    memberId: segment.memberId,
    nameMasked: segment.nameMasked,
    phoneMasked,
    lastVisitAt,
    reason: segment.matchReason,
    suggestedAction: '低成本关怀，邀请回店看看新品',
    suggestedScript: `${segment.nameMasked}，好久没见您到店了，最近上了几款日常好穿的新款，有空来看看。`,
  };
}
