import { z } from 'zod';

import { DateRange, DateStr, TenantScope } from './_common.js';

export const MARKETING_GROWTH_TOOLS = [
  'query_campaign_history',
  'query_coupon_inventory',
  'query_inventory_status',
  'query_member_consumption_history',
  'query_member_profile',
  'query_member_segments',
  'query_pos_summary_by_time',
  'query_product_performance',
  'query_repurchase_cycle',
] as const;

export type MarketingToolName = (typeof MARKETING_GROWTH_TOOLS)[number];

export const MemberLevel = z.enum(['NEW', 'NORMAL', 'SILVER', 'GOLD', 'VIP']);
export type MemberLevel = z.infer<typeof MemberLevel>;

export const MemberStatus = z.enum(['ACTIVE', 'DORMANT', 'CHURNED']);
export type MemberStatus = z.infer<typeof MemberStatus>;

export const SegmentCode = z.enum([
  'HIGH_VALUE',
  'LOYAL_FREQUENT',
  'DORMANT_NORMAL',
  'DORMANT_HIGH_VALUE',
  'DORMANT_WITH_STORAGE',
  'DORMANT_WITH_COUPON',
  'REPURCHASE_DUE',
  'NEW_FIRST_PURCHASE',
  'NEW_NEED_TWO_VISIT',
  'COUPON_EXPIRING',
  'BIRTHDAY_THIS_MONTH',
  'LOW_RESPONSIVE',
]);
export type SegmentCode = z.infer<typeof SegmentCode>;

export const CouponStatus = z.enum(['UNUSED', 'USED', 'EXPIRED']);
export const CouponType = z.enum(['CASH', 'DISCOUNT', 'GIFT', 'EXCHANGE']);
export const InventoryStatus = z.enum(['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'SLOW_MOVING', 'NEAR_EXPIRY', 'PHASE_OUT']);
export const CampaignStatus = z.enum(['PLANNED', 'RUNNING', 'FINISHED', 'CANCELLED']);

export const MemberSummary = TenantScope.extend({
  memberId: z.string().min(1),
  memberCode: z.string().min(1).optional(),
  nameMasked: z.string().min(1),
  phoneMasked: z.string().min(1).optional(),
  level: MemberLevel,
  status: MemberStatus,
  joinDate: DateStr,
  lastVisitAt: DateStr.optional(),
  totalSpent: z.number().nonnegative(),
  totalOrders: z.number().int().nonnegative(),
  avgOrderValue: z.number().nonnegative().optional(),
  avgRepurchaseDays: z.number().int().positive().optional(),
  tags: z.array(z.string()).default([]),
});
export type MemberSummary = z.infer<typeof MemberSummary>;

export const MemberSegment = MemberSummary.extend({
  segmentCode: SegmentCode,
  segmentName: z.string().min(1),
  matchedAt: z.string().min(1),
  matchReason: z.string().min(1),
  score: z.number().nonnegative().optional(),
});
export type MemberSegment = z.infer<typeof MemberSegment>;

export const MemberConsumptionOrder = z.object({
  orderId: z.string().min(1),
  orderDate: DateStr,
  salesAmount: z.number().nonnegative(),
  itemCount: z.number().int().nonnegative(),
  skuIds: z.array(z.string().min(1)).default([]),
});
export type MemberConsumptionOrder = z.infer<typeof MemberConsumptionOrder>;

export const SkuPerformance = TenantScope.extend({
  skuId: z.string().min(1),
  skuName: z.string().min(1),
  categoryId: z.string().min(1),
  categoryName: z.string().min(1),
  salesQty: z.number().int().nonnegative(),
  salesAmount: z.number().nonnegative(),
  grossMarginRate: z.number().min(-1).max(1),
  trend: z.enum(['UP', 'FLAT', 'DOWN']),
  inventoryStatus: InventoryStatus,
});
export type SkuPerformance = z.infer<typeof SkuPerformance>;

export const InventorySnapshot = TenantScope.extend({
  skuId: z.string().min(1),
  skuName: z.string().min(1),
  availableQty: z.number().int().nonnegative(),
  stockAgeDays: z.number().int().nonnegative(),
  nearExpiryDays: z.number().int().nonnegative().optional(),
  slowMovingFlag: z.boolean(),
  status: InventoryStatus,
});
export type InventorySnapshot = z.infer<typeof InventorySnapshot>;

export const CouponInventoryItem = TenantScope.extend({
  couponId: z.string().min(1),
  memberId: z.string().min(1).optional(),
  memberNameMasked: z.string().min(1).optional(),
  couponType: CouponType,
  amount: z.number().nonnegative().optional(),
  discount: z.number().min(0).max(1).optional(),
  threshold: z.number().nonnegative().optional(),
  validFrom: DateStr,
  validTo: DateStr,
  daysToExpire: z.number().int(),
  status: CouponStatus,
});
export type CouponInventoryItem = z.infer<typeof CouponInventoryItem>;

export const CampaignHistoryItem = TenantScope.extend({
  campaignId: z.string().min(1),
  campaignName: z.string().min(1),
  status: CampaignStatus,
  dateRange: DateRange,
  touchedMembers: z.number().int().nonnegative(),
  convertedMembers: z.number().int().nonnegative(),
  salesAmount: z.number().nonnegative(),
  grossMarginRate: z.number().min(-1).max(1),
  resultSummary: z.string().min(1),
});
export type CampaignHistoryItem = z.infer<typeof CampaignHistoryItem>;

export const PosTimeBucket = z.object({
  bucket: z.string().min(1),
  salesAmount: z.number().nonnegative(),
  orderCount: z.number().int().nonnegative(),
  memberOrderCount: z.number().int().nonnegative(),
  walkInOrderCount: z.number().int().nonnegative(),
});
export type PosTimeBucket = z.infer<typeof PosTimeBucket>;

export const query_member_profile = {
  input: TenantScope.extend({
    memberId: z.string().min(1).optional(),
    phoneMasked: z.string().min(1).optional(),
  }).refine((input) => Boolean(input.memberId ?? input.phoneMasked), {
    message: 'memberId or phoneMasked is required',
  }),
  output: TenantScope.extend({
    member: MemberSummary,
    points: z.object({
      points: z.number().int().nonnegative(),
      pointsExpiringIn30d: z.number().int().nonnegative(),
    }),
    storageBalance: z.object({
      balance: z.number().nonnegative(),
      totalRecharged: z.number().nonnegative(),
      totalConsumed: z.number().nonnegative(),
    }),
    couponSummary: z.object({
      unusedCount: z.number().int().nonnegative(),
      expiringIn7dCount: z.number().int().nonnegative(),
    }),
  }),
} as const;

export const query_member_consumption_history = {
  input: TenantScope.extend({
    memberId: z.string().min(1),
    dateRange: DateRange,
  }),
  output: TenantScope.extend({
    memberId: z.string().min(1),
    orders: z.array(MemberConsumptionOrder).max(500),
    frequentSkuIds: z.array(z.string().min(1)).max(20),
    totalSalesAmount: z.number().nonnegative(),
    totalOrderCount: z.number().int().nonnegative(),
  }),
} as const;

export const query_member_segments = {
  input: TenantScope.extend({
    segmentCodes: z.array(SegmentCode).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: TenantScope.extend({
    generatedAt: z.string().min(1),
    segments: z.array(MemberSegment).max(200),
  }),
} as const;

export const query_repurchase_cycle = {
  input: TenantScope.extend({
    memberId: z.string().min(1).optional(),
    skuId: z.string().min(1).optional(),
  }).refine((input) => Boolean(input.memberId ?? input.skuId), {
    message: 'memberId or skuId is required',
  }),
  output: TenantScope.extend({
    memberId: z.string().min(1).optional(),
    skuId: z.string().min(1).optional(),
    avgRepurchaseDays: z.number().int().positive(),
    daysSinceLastPurchase: z.number().int().nonnegative(),
    confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    sampleSize: z.number().int().nonnegative(),
  }),
} as const;

export const query_product_performance = {
  input: TenantScope.extend({
    dateRange: DateRange,
    categoryId: z.string().min(1).optional(),
    skuIds: z.array(z.string().min(1)).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: TenantScope.extend({
    dateRange: DateRange,
    products: z.array(SkuPerformance).max(200),
  }),
} as const;

export const query_inventory_status = {
  input: TenantScope.extend({
    skuIds: z.array(z.string().min(1)).optional(),
    status: InventoryStatus.optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: TenantScope.extend({
    snapshots: z.array(InventorySnapshot).max(200),
  }),
} as const;

export const query_pos_summary_by_time = {
  input: TenantScope.extend({
    dateRange: DateRange,
    granularity: z.enum(['HOUR', 'DAY']),
  }),
  output: TenantScope.extend({
    dateRange: DateRange,
    granularity: z.enum(['HOUR', 'DAY']),
    buckets: z.array(PosTimeBucket).max(366),
  }),
} as const;

export const query_campaign_history = {
  input: TenantScope.extend({
    dateRange: DateRange,
    limit: z.number().int().min(1).max(100).default(20),
  }),
  output: TenantScope.extend({
    campaigns: z.array(CampaignHistoryItem).max(100),
  }),
} as const;

export const query_coupon_inventory = {
  input: TenantScope.extend({
    status: CouponStatus.optional(),
    expiringInDays: z.number().int().min(0).max(365).optional(),
    memberId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: TenantScope.extend({
    coupons: z.array(CouponInventoryItem).max(200),
    summary: z.object({
      totalUnused: z.number().int().nonnegative(),
      expiringIn7d: z.number().int().nonnegative(),
    }),
  }),
} as const;

export const MarketingToolContracts = {
  query_campaign_history,
  query_coupon_inventory,
  query_inventory_status,
  query_member_consumption_history,
  query_member_profile,
  query_member_segments,
  query_pos_summary_by_time,
  query_product_performance,
  query_repurchase_cycle,
} as const;
