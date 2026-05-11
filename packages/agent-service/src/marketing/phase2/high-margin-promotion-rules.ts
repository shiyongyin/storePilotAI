import { buildProductRecommendCard } from './product-card-builder.js';
import {
  type MarginRiskLevel,
  type ProductInventorySignal,
  type ProductPerformanceSignal,
  type ProductRecommendationCandidate,
  computeMarginRisk,
  isNearExpiry,
  isSellableInventory,
  isSlowMoving,
} from './product-rules.js';

type HighMarginTrend = string;

export interface HighMarginProductSignal extends ProductPerformanceSignal {
  trend: HighMarginTrend;
  refundRate?: number | undefined;
  complaintRate?: number | undefined;
  complaintCount?: number | undefined;
}

export interface HighMarginSegmentSignal {
  segmentCode: string;
  segmentName: string;
  matchReason: string;
  score?: number | undefined;
}

export interface HighMarginCampaignSignal {
  campaignId: string;
  campaignName: string;
  grossMarginRate: number;
  resultSummary: string;
}

export interface HighMarginPromotionItem extends ProductRecommendationCandidate {
  promotionScore: number;
  marginAdvantageText: string;
  targetAudienceText: string;
  staffScript: string;
  riskText: string;
  mechanismRiskText: string;
  campaignReference: string;
}

export function buildHighMarginPromotionRecommendations(args: {
  products: readonly HighMarginProductSignal[];
  inventoryBySku: Record<string, ProductInventorySignal | undefined>;
  segments?: readonly HighMarginSegmentSignal[] | undefined;
  campaigns?: readonly HighMarginCampaignSignal[] | undefined;
  minMarginRate?: number | undefined;
  storeAvgMarginRate?: number | undefined;
  includeDiscountMechanism?: boolean | undefined;
  discountedMarginRateBySku?: Record<string, number | undefined> | undefined;
  limit?: number | undefined;
}): HighMarginPromotionItem[] {
  const storeAvgMarginRate = args.storeAvgMarginRate ?? 0.3;
  const eligibleSegments = chooseFitSegments(args.segments ?? []);
  const campaignReference = buildCampaignReference(args.campaigns ?? []);

  const items = args.products
    .map((product) => {
      const inventory = args.inventoryBySku[product.skuId];
      if (inventory === undefined) return null;
      if (!isSellableInventory(inventory)) return null;
      if (inventory.status === 'PHASE_OUT') return null;
      if (hasUnsafeReturnSignal(product)) return null;

      const nearExpiry = isNearExpiry({
        nearExpiryDays: inventory.nearExpiryDays,
        availableQty: inventory.availableQty,
      });
      const slowMoving = isSlowMoving({
        slowMovingFlag: inventory.slowMovingFlag,
        salesQty30d: product.salesQty,
        categoryAvgSalesQty30d: product.salesQty,
        stockAgeDays: inventory.stockAgeDays,
      });
      if (nearExpiry || inventory.status === 'NEAR_EXPIRY') return null;
      if (slowMoving || inventory.status === 'SLOW_MOVING') return null;
      if (product.grossMarginRate < (args.minMarginRate ?? 0)) return null;

      const discountedMarginRate = args.discountedMarginRateBySku?.[product.skuId] ?? product.grossMarginRate;
      const marginRiskLevel = computeMarginRisk({
        originalMarginRate: product.grossMarginRate,
        discountedMarginRate,
        storeAvgMarginRate,
      });
      return toPromotionItem({
        product,
        inventory,
        marginRiskLevel,
        storeAvgMarginRate,
        discountedMarginRate,
        includeDiscountMechanism: args.includeDiscountMechanism === true,
        fitSegments: eligibleSegments.codes,
        targetAudienceText: eligibleSegments.text,
        campaignReference,
      });
    })
    .filter((item): item is HighMarginPromotionItem => item !== null)
    .sort(comparePromotionItems)
    .slice(0, args.limit ?? 5);

  return items.length > 3 ? items : items;
}

export function buildHighMarginPromotionMarkdown(args: {
  products: readonly HighMarginProductSignal[];
  inventoryBySku: Record<string, ProductInventorySignal | undefined>;
  segments?: readonly HighMarginSegmentSignal[] | undefined;
  campaigns?: readonly HighMarginCampaignSignal[] | undefined;
  minMarginRate?: number | undefined;
  storeAvgMarginRate?: number | undefined;
  includeDiscountMechanism?: boolean | undefined;
  discountedMarginRateBySku?: Record<string, number | undefined> | undefined;
  limit?: number | undefined;
}): string {
  const items = buildHighMarginPromotionRecommendations(args);
  const card = buildProductRecommendCard({
    title: '本周建议主推商品',
    products: items,
  });
  const lines = [
    '## 本周建议主推商品',
    '',
    '以下建议基于已返回的商品毛利、库存、会员分群和历史活动结果；这里只给主推建议，不替你改价、投放或执行活动。',
    '',
    '| 商品 | 毛利优势 | 库存 | 适合人群 | 建议机制 | 话术 | 风险 |',
    '|---|---:|---|---|---|---|---|',
  ];

  for (const item of items) {
    lines.push(
      `| ${item.skuId} ${item.skuName} | ${item.marginAdvantageText} | ${item.inventoryStatus}；库存 ${item.availableQty} 件 | ${item.targetAudienceText} | ${item.suggestedMechanism} | 话术：${item.staffScript} | ${item.riskText}；${item.mechanismRiskText} |`,
    );
  }

  lines.push('', `<!-- card_data:start -->${JSON.stringify(card)}<!-- card_data:end -->`);
  return lines.join('\n');
}

function toPromotionItem(args: {
  product: HighMarginProductSignal;
  inventory: ProductInventorySignal;
  marginRiskLevel: MarginRiskLevel;
  storeAvgMarginRate: number;
  discountedMarginRate: number;
  includeDiscountMechanism: boolean;
  fitSegments: readonly string[];
  targetAudienceText: string;
  campaignReference: string;
}): HighMarginPromotionItem {
  const marginAdvantage = Math.max(0, args.product.grossMarginRate - args.storeAvgMarginRate);
  const mechanism = args.includeDiscountMechanism
    ? '老客专属搭配护理品，第二件适度折扣；先核算折后毛利'
    : '老客专属搭配护理品或到店试穿体验，不直接改价';
  const mechanismRiskText = args.includeDiscountMechanism
    ? `折后毛利率 ${formatPercent(args.discountedMarginRate)}，毛利风险 ${args.marginRiskLevel}`
    : `当前机制不含明确折扣，毛利风险 ${args.marginRiskLevel}`;
  const riskText = buildRiskText(args.product);
  const recommendationReason = [
    `毛利率 ${formatPercent(args.product.grossMarginRate)}`,
    `高于门店均值 ${formatPercent(marginAdvantage)}`,
    `库存 ${args.inventory.availableQty} 件可售`,
    args.product.trend === 'UP' ? '近期销量趋势向上' : `近期销量趋势 ${args.product.trend}`,
    args.campaignReference,
  ].filter((part) => part.length > 0).join('；');
  const promotionScore = computePromotionScore({
    grossMarginRate: args.product.grossMarginRate,
    availableQty: args.inventory.availableQty,
    inventoryStatus: args.inventory.status,
    trend: args.product.trend,
    refundSafe: riskText.includes('退货投诉信号未返回') || riskText.includes('退货投诉未见高风险'),
    hasSegmentFit: args.fitSegments.length > 0,
  });

  return {
    skuId: args.product.skuId,
    skuName: args.product.skuName,
    categoryCode: args.product.categoryId,
    categoryName: args.product.categoryName,
    grossMarginRate: args.product.grossMarginRate,
    inventoryStatus: args.inventory.status,
    availableQty: args.inventory.availableQty,
    stockAgeDays: args.inventory.stockAgeDays,
    ...(args.inventory.nearExpiryDays === undefined ? {} : { nearExpiryDays: args.inventory.nearExpiryDays }),
    slowMoving: false,
    nearExpiry: false,
    fitSegments: args.fitSegments,
    suggestedMechanism: mechanism,
    recommendationReason,
    marginRiskLevel: args.marginRiskLevel,
    marginRiskFlag: args.marginRiskLevel !== 'LOW',
    complianceRiskFlag: false,
    brandRiskNote: '',
    promotionScore,
    marginAdvantageText: `毛利率 ${formatPercent(args.product.grossMarginRate)}，高于门店均值 ${formatPercent(marginAdvantage)}`,
    targetAudienceText: args.targetAudienceText,
    staffScript: buildStaffScript(args.product.skuName),
    riskText,
    mechanismRiskText,
    campaignReference: args.campaignReference,
  };
}

function chooseFitSegments(segments: readonly HighMarginSegmentSignal[]): { codes: readonly string[]; text: string } {
  const allowed = segments
    .filter((segment) => segment.segmentCode !== 'LOW_RESPONSIVE')
    .filter((segment) => ['HIGH_VALUE', 'LOYAL_FREQUENT', 'REPURCHASE_DUE'].includes(segment.segmentCode))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const selected = allowed.slice(0, 2);
  if (selected.length === 0) {
    return {
      codes: ['HIGH_VALUE', 'LOYAL_FREQUENT'],
      text: '会员分群未返回；建议先面向高价值熟客 / 高频老客小范围验证',
    };
  }
  return {
    codes: selected.map((segment) => segment.segmentCode),
    text: selected.map((segment) => segment.segmentName).join(' / '),
  };
}

function buildCampaignReference(campaigns: readonly HighMarginCampaignSignal[]): string {
  const best = campaigns
    .filter((campaign) => campaign.grossMarginRate >= 0.35)
    .sort((a, b) => b.grossMarginRate - a.grossMarginRate)[0];
  if (best === undefined) return '历史活动参考未返回';
  return `参考历史活动 ${best.campaignName}：${best.resultSummary}`;
}

function hasUnsafeReturnSignal(product: HighMarginProductSignal): boolean {
  const refundRate = product.refundRate;
  if (refundRate !== undefined && refundRate >= 0.12) return true;
  const complaintRate = product.complaintRate;
  if (complaintRate !== undefined && complaintRate >= 0.08) return true;
  const complaintCount = product.complaintCount;
  return complaintCount !== undefined && complaintCount >= 5;
}

function buildRiskText(product: HighMarginProductSignal): string {
  if (product.refundRate === undefined && product.complaintRate === undefined && product.complaintCount === undefined) {
    return '退货投诉信号未返回，不把低投诉作为事实承诺';
  }
  const parts = [];
  if (product.refundRate !== undefined) parts.push(`退货率 ${formatPercent(product.refundRate)}`);
  if (product.complaintRate !== undefined) parts.push(`投诉率 ${formatPercent(product.complaintRate)}`);
  if (product.complaintCount !== undefined) parts.push(`投诉 ${product.complaintCount} 单`);
  parts.push('退货投诉未见高风险');
  return parts.join('；');
}

function computePromotionScore(args: {
  grossMarginRate: number;
  availableQty: number;
  inventoryStatus: string;
  trend: HighMarginTrend;
  refundSafe: boolean;
  hasSegmentFit: boolean;
}): number {
  const marginRateRank = Math.min(args.grossMarginRate / 0.5, 1);
  const inventoryHealth = args.inventoryStatus === 'LOW_STOCK'
    ? Math.min(args.availableQty / 60, 0.35)
    : Math.min(args.availableQty / 60, 1);
  const salesGrowthRank = args.trend === 'UP' ? 1 : args.trend === 'FLAT' ? 0.65 : 0.2;
  const refundSafety = args.refundSafe ? 1 : 0;
  const segmentFit = args.hasSegmentFit ? 1 : 0.4;
  return round2(
    marginRateRank * 0.35
    + inventoryHealth * 0.25
    + salesGrowthRank * 0.20
    + refundSafety * 0.10
    + segmentFit * 0.10,
  );
}

function comparePromotionItems(a: HighMarginPromotionItem, b: HighMarginPromotionItem): number {
  if (a.promotionScore !== b.promotionScore) return b.promotionScore - a.promotionScore;
  if (a.grossMarginRate !== b.grossMarginRate) return b.grossMarginRate - a.grossMarginRate;
  return a.skuId.localeCompare(b.skuId);
}

function buildStaffScript(skuName: string): string {
  return `${skuName}这款毛利空间和库存都比较健康，适合先邀约老客试穿。您可以到店看实物，合适再决定。`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
