import members from './members.json' with { type: 'json' };
import skus from './skus.json' with { type: 'json' };
import inventorySnapshots from './inventory-snapshots.json' with { type: 'json' };
import coupons from './coupons.json' with { type: 'json' };
import posOrders from './pos-orders.json' with { type: 'json' };
import campaignRecords from './campaign-records.json' with { type: 'json' };

import type { ProfileFixtures } from '../../support/fixture-loader.js';

type TenantInput = {
  merchantId: string;
  storeId: string;
};

type LimitInput = {
  limit?: number;
};

type SegmentInput = TenantInput & LimitInput & {
  segmentCodes?: string[];
};

type MemberLookupInput = TenantInput & {
  memberId?: string;
  phoneMasked?: string;
};

type HistoryInput = TenantInput & {
  memberId: string;
  dateRange: { startDate: string; endDate: string };
};

type ProductInput = TenantInput & LimitInput & {
  dateRange: { startDate: string; endDate: string };
  skuIds?: string[];
  categoryId?: string;
};

type InventoryInput = TenantInput & LimitInput & {
  skuIds?: string[];
  status?: string;
};

type CouponInput = TenantInput & LimitInput & {
  status?: string;
  expiringInDays?: number;
  memberId?: string;
};

type RepurchaseInput = TenantInput & {
  memberId?: string;
  skuId?: string;
};

type PosSummaryInput = TenantInput & {
  dateRange: { startDate: string; endDate: string };
  granularity: 'HOUR' | 'DAY';
};

const typedMembers = members;
const typedSkus = skus;
const typedInventorySnapshots = inventorySnapshots;
const typedCoupons = coupons;
const typedPosOrders = posOrders;
const typedCampaignRecords = campaignRecords;

function tenantMatches(row: TenantInput, input: TenantInput): boolean {
  return row.merchantId === input.merchantId && row.storeId === input.storeId;
}

function limitRows<T>(rows: T[], limit = 50): T[] {
  return rows.slice(0, limit);
}

function toMemberSummary(member: (typeof typedMembers)[number]) {
  return {
    merchantId: member.merchantId,
    storeId: member.storeId,
    memberId: member.memberId,
    memberCode: member.memberCode,
    nameMasked: member.nameMasked,
    phoneMasked: member.phoneMasked,
    level: member.level,
    status: member.status,
    joinDate: member.joinDate,
    lastVisitAt: member.lastVisitAt,
    totalSpent: member.totalSpent,
    totalOrders: member.totalOrders,
    avgOrderValue: member.avgOrderValue,
    avgRepurchaseDays: member.avgRepurchaseDays,
    tags: member.tags,
  };
}

function buildSegments(input: SegmentInput) {
  const rows = typedMembers
    .filter((member) => tenantMatches(member, input))
    .flatMap((member) => {
      const base = toMemberSummary(member);
      const result = [];
      if (member.memberId === 'MBR_00123') {
        result.push(
          {
            ...base,
            segmentCode: 'HIGH_VALUE',
            segmentName: '高价值熟客',
            matchedAt: '2026-05-10T09:30:00.000+08:00',
            matchReason: '累计消费和复购次数均处于高位',
            score: 9.4,
          },
          {
            ...base,
            segmentCode: 'DORMANT_HIGH_VALUE',
            segmentName: '高价值沉睡',
            matchedAt: '2026-05-10T09:30:00.000+08:00',
            matchReason: '高价值熟客超过个人复购周期 2 倍未到店',
            score: 9.1,
          },
          {
            ...base,
            segmentCode: 'DORMANT_WITH_STORAGE',
            segmentName: '储值沉睡',
            matchedAt: '2026-05-10T09:30:00.000+08:00',
            matchReason: '仍有储值余额 380 元且 45 天以上未到店',
            score: 8.8,
          },
          {
            ...base,
            segmentCode: 'REPURCHASE_DUE',
            segmentName: '复购临近',
            matchedAt: '2026-05-10T09:30:00.000+08:00',
            matchReason: '距上次到店 61 天，超过个人平均复购周期',
            score: 9.2,
          },
        );
      }
      if (member.memberId === 'MBR_00150') {
        result.push({
          ...base,
          segmentCode: 'DORMANT_NORMAL',
          segmentName: '普通沉睡',
          matchedAt: '2026-05-10T09:30:00.000+08:00',
          matchReason: '60 天未到店且无券无储值',
          score: 6.8,
        });
      }
      if (member.memberId === 'MBR_00151') {
        result.push({
          ...base,
          segmentCode: 'DORMANT_WITH_STORAGE',
          segmentName: '储值沉睡',
          matchedAt: '2026-05-10T09:30:00.000+08:00',
          matchReason: '仍有储值余额 220 元且 45 天以上未到店',
          score: 8.5,
        });
      }
      if (member.memberId === 'MBR_00152') {
        result.push({
          ...base,
          segmentCode: 'LOW_RESPONSIVE',
          segmentName: '活动低响应',
          matchedAt: '2026-05-10T09:30:00.000+08:00',
          matchReason: '历史 3 次活动触达 0 次响应',
          score: 2.1,
        });
      }
      if (member.memberId === 'MBR_00135') {
        result.push(
          {
            ...base,
            segmentCode: 'LOYAL_FREQUENT',
            segmentName: '高频忠诚',
            matchedAt: '2026-05-10T09:30:00.000+08:00',
            matchReason: '近 12 月复购次数较高',
            score: 8.3,
          },
          {
            ...base,
            segmentCode: 'DORMANT_WITH_COUPON',
            segmentName: '有券沉睡',
            matchedAt: '2026-05-10T09:30:00.000+08:00',
            matchReason: '持有未使用券且 30 天以上未到店',
            score: 8.2,
          },
          {
            ...base,
            segmentCode: 'COUPON_EXPIRING',
            segmentName: '券即将过期',
            matchedAt: '2026-05-10T09:30:00.000+08:00',
            matchReason: '有券 5 天后过期',
            score: 8.6,
          },
          {
            ...base,
            segmentCode: 'REPURCHASE_DUE',
            segmentName: '复购临近',
            matchedAt: '2026-05-10T09:30:00.000+08:00',
            matchReason: '距上次到店接近个人平均复购周期',
            score: 8.1,
          },
        );
      }
      if (member.memberId === 'MBR_00142') {
        result.push(
          {
            ...base,
            segmentCode: 'NEW_NEED_TWO_VISIT',
            segmentName: '新客待二转',
            matchedAt: '2026-05-10T09:30:00.000+08:00',
            matchReason: '新客首购后超过 7 天未二次到店',
            score: 7.9,
          },
          {
            ...base,
            segmentCode: 'NEW_FIRST_PURCHASE',
            segmentName: '新客首次',
            matchedAt: '2026-05-10T09:30:00.000+08:00',
            matchReason: '入会 30 天内且仅 1 次消费',
            score: 7.4,
          },
          {
            ...base,
            segmentCode: 'REPURCHASE_DUE',
            segmentName: '复购临近',
            matchedAt: '2026-05-10T09:30:00.000+08:00',
            matchReason: '新会员样本少，接近复购窗口',
            score: 6.4,
          },
        );
      }
      if (member.memberId === 'MBR_00151') {
        result.push({
          ...base,
          segmentCode: 'LOYAL_FREQUENT',
          segmentName: '高频忠诚',
          matchedAt: '2026-05-10T09:30:00.000+08:00',
          matchReason: '到店频次较稳定',
          score: 7.7,
        });
      }
      return result;
    });

  const filtered = input.segmentCodes?.length
    ? rows.filter((row) => input.segmentCodes!.includes(row.segmentCode))
    : rows.filter((row) => row.segmentCode !== 'LOW_RESPONSIVE');
  return limitRows(filtered, input.limit);
}

export const marketingShoeStoreFixtures: ProfileFixtures = {
  query_member_profile(input: unknown) {
    const typed = input as MemberLookupInput;
    const member = typedMembers.find(
      (row) =>
        tenantMatches(row, typed) &&
        (row.memberId === typed.memberId || row.phoneMasked === typed.phoneMasked),
    );
    if (!member) throw new Error('MEMBER_NOT_FOUND');
    const memberCoupons = typedCoupons.filter((coupon) => coupon.memberId === member.memberId);
    return {
      merchantId: typed.merchantId,
      storeId: typed.storeId,
      member: toMemberSummary(member),
      points: {
        points: member.points,
        pointsExpiringIn30d: member.pointsExpiringIn30d,
      },
      storageBalance: {
        balance: member.storageBalance,
        totalRecharged: member.totalRecharged,
        totalConsumed: member.totalConsumed,
      },
      couponSummary: {
        unusedCount: memberCoupons.filter((coupon) => coupon.status === 'UNUSED').length,
        expiringIn7dCount: memberCoupons.filter((coupon) => coupon.status === 'UNUSED' && coupon.daysToExpire <= 7)
          .length,
      },
    };
  },

  query_member_consumption_history(input: unknown) {
    const typed = input as HistoryInput;
    const orders = typedPosOrders.filter((order) => tenantMatches(order, typed) && order.memberId === typed.memberId);
    const contractOrders = orders.map((order) => ({
      orderId: order.orderId,
      orderDate: order.orderDate,
      salesAmount: order.salesAmount,
      itemCount: order.itemCount,
      skuIds: order.skuIds,
    }));
    return {
      merchantId: typed.merchantId,
      storeId: typed.storeId,
      memberId: typed.memberId,
      orders: contractOrders,
      frequentSkuIds: [...new Set(orders.flatMap((order) => order.skuIds))],
      totalSalesAmount: orders.reduce((sum, order) => sum + order.salesAmount, 0),
      totalOrderCount: orders.length,
    };
  },

  query_member_segments(input: unknown) {
    const typed = input as SegmentInput;
    return {
      merchantId: typed.merchantId,
      storeId: typed.storeId,
      generatedAt: '2026-05-10T09:30:00.000+08:00',
      segments: buildSegments(typed),
    };
  },

  query_repurchase_cycle(input: unknown) {
    const typed = input as RepurchaseInput;
    const member = typed.memberId
      ? typedMembers.find((row) => tenantMatches(row, typed) && row.memberId === typed.memberId)
      : undefined;
    const overrides: Record<string, {
      daysSinceLastPurchase: number;
      confidence: 'LOW' | 'MEDIUM' | 'HIGH';
      sampleSize: number;
    }> = {
      MBR_00123: { daysSinceLastPurchase: 61, confidence: 'HIGH', sampleSize: 12 },
      MBR_00135: { daysSinceLastPurchase: 29, confidence: 'MEDIUM', sampleSize: 5 },
      MBR_00142: { daysSinceLastPurchase: 28, confidence: 'LOW', sampleSize: 1 },
    };
    const override = typed.memberId ? overrides[typed.memberId] : undefined;
    return {
      merchantId: typed.merchantId,
      storeId: typed.storeId,
      ...(typed.memberId === undefined ? {} : { memberId: typed.memberId }),
      ...(typed.skuId === undefined ? {} : { skuId: typed.skuId }),
      avgRepurchaseDays: member?.avgRepurchaseDays ?? 28,
      daysSinceLastPurchase: override?.daysSinceLastPurchase ?? 25,
      confidence: override?.confidence ?? 'MEDIUM',
      sampleSize: override?.sampleSize ?? 12,
    };
  },

  query_product_performance(input: unknown) {
    const typed = input as ProductInput;
    const rows = typedSkus
      .filter((row) => tenantMatches(row, typed))
      .filter((row) => !typed.categoryId || row.categoryId === typed.categoryId)
      .filter((row) => !typed.skuIds?.length || typed.skuIds.includes(row.skuId));
    return {
      merchantId: typed.merchantId,
      storeId: typed.storeId,
      dateRange: typed.dateRange,
      products: limitRows(rows, typed.limit),
    };
  },

  query_inventory_status(input: unknown) {
    const typed = input as InventoryInput;
    const rows = typedInventorySnapshots
      .filter((row) => tenantMatches(row, typed))
      .filter((row) => !typed.status || row.status === typed.status)
      .filter((row) => !typed.skuIds?.length || typed.skuIds.includes(row.skuId));
    return {
      merchantId: typed.merchantId,
      storeId: typed.storeId,
      snapshots: limitRows(rows, typed.limit),
    };
  },

  query_pos_summary_by_time(input: unknown) {
    const typed = input as PosSummaryInput;
    return {
      merchantId: typed.merchantId,
      storeId: typed.storeId,
      dateRange: typed.dateRange,
      granularity: typed.granularity,
      buckets: [
        { bucket: '10:00-14:00', salesAmount: 9600, orderCount: 32, memberOrderCount: 24, walkInOrderCount: 8 },
        { bucket: '14:00-17:00', salesAmount: 3840, orderCount: 13, memberOrderCount: 8, walkInOrderCount: 5 },
        { bucket: '17:00-21:00', salesAmount: 10120, orderCount: 35, memberOrderCount: 26, walkInOrderCount: 9 },
      ],
    };
  },

  query_campaign_history(input: unknown) {
    const typed = input as TenantInput & LimitInput;
    return {
      merchantId: typed.merchantId,
      storeId: typed.storeId,
      campaigns: limitRows(
        typedCampaignRecords.filter((campaign) => tenantMatches(campaign, typed)),
        typed.limit,
      ),
    };
  },

  query_coupon_inventory(input: unknown) {
    const typed = input as CouponInput;
    const rows = typedCoupons
      .filter((coupon) => tenantMatches(coupon, typed))
      .filter((coupon) => !typed.memberId || coupon.memberId === typed.memberId)
      .filter((coupon) => !typed.status || coupon.status === typed.status)
      .filter((coupon) => typed.expiringInDays === undefined || coupon.daysToExpire <= typed.expiringInDays);
    const coupons = limitRows(rows, typed.limit);
    return {
      merchantId: typed.merchantId,
      storeId: typed.storeId,
      coupons,
      summary: {
        totalUnused: rows.filter((coupon) => coupon.status === 'UNUSED').length,
        expiringIn7d: rows.filter((coupon) => coupon.status === 'UNUSED' && coupon.daysToExpire <= 7).length,
      },
    };
  },
};
