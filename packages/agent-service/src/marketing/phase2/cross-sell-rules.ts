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

type RepurchaseConfidence = string;

export interface CrossSellMemberProfile {
  memberId: string;
  nameMasked: string;
  phoneMasked?: string;
  level: string;
  avgOrderValue?: number;
  tags?: readonly string[];
}

export interface CrossSellOrder {
  orderId: string;
  orderDate: string;
  salesAmount: number;
  itemCount: number;
  skuIds: readonly string[];
}

export interface CrossSellConsumptionHistory {
  memberId: string;
  orders: readonly CrossSellOrder[];
  frequentSkuIds: readonly string[];
  totalSalesAmount: number;
  totalOrderCount: number;
}

export interface CrossSellRepurchaseSignal {
  skuId: string;
  avgRepurchaseDays: number;
  daysSinceLastPurchase: number;
  confidence: RepurchaseConfidence;
  sampleSize: number;
}

export interface CrossSellRecommendationItem extends ProductRecommendationCandidate {
  fitScore: number;
  recommendationReason: string;
  staffScript: string;
}

export function buildCrossSellRecommendations(args: {
  memberProfile?: CrossSellMemberProfile | undefined;
  history?: CrossSellConsumptionHistory | undefined;
  basketSkuIds: readonly string[];
  products: readonly ProductPerformanceSignal[];
  inventoryBySku: Record<string, ProductInventorySignal | undefined>;
  repurchaseBySku?: Record<string, CrossSellRepurchaseSignal | undefined> | undefined;
  limit?: number | undefined;
}): CrossSellRecommendationItem[] {
  const basket = new Set(args.basketSkuIds);
  const historySkuIds = new Set(args.history?.frequentSkuIds ?? []);
  const hasMember = args.memberProfile !== undefined;

  return args.products
    .map((product) => {
      if (basket.has(product.skuId)) return null;
      const inventory = args.inventoryBySku[product.skuId];
      if (inventory === undefined) return null;
      if (!isSellableInventory(inventory)) return null;
      if (inventory.status === 'PHASE_OUT') return null;
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

      const repurchase = args.repurchaseBySku?.[product.skuId];
      const repurchaseNear = repurchase === undefined ? false : isRepurchaseNear(repurchase);
      const basketFit = hasBasketCategoryFit(product, args.products, basket);
      const historyFit = hasMember && (historySkuIds.has(product.skuId) || basketFit);
      if (!historyFit && !basketFit) return null;

      const fitScore = computeFitScore({
        historyFit,
        basketFit,
        repurchaseNear,
        grossMarginRate: product.grossMarginRate,
        availableQty: inventory.availableQty,
      });
      const marginRiskLevel = computeMarginRisk({
        originalMarginRate: product.grossMarginRate,
        discountedMarginRate: product.grossMarginRate,
        storeAvgMarginRate: 0.3,
      });
      const candidate = toCrossSellItem({
        product,
        inventory,
        marginRiskLevel,
        fitScore,
        hasMember,
        basketSkuIds: args.basketSkuIds,
        historySkuIds,
        repurchaseNear,
      });
      return candidate;
    })
    .filter((item): item is CrossSellRecommendationItem => item !== null)
    .sort(compareCrossSellItems)
    .slice(0, args.limit ?? 3);
}

export function buildCrossSellMarkdown(args: {
  memberProfile?: CrossSellMemberProfile | undefined;
  history?: CrossSellConsumptionHistory | undefined;
  basketSkuIds: readonly string[];
  products: readonly ProductPerformanceSignal[];
  inventoryBySku: Record<string, ProductInventorySignal | undefined>;
  repurchaseBySku?: Record<string, CrossSellRepurchaseSignal | undefined> | undefined;
  limit?: number | undefined;
}): string {
  const items = buildCrossSellRecommendations(args);
  const card = buildProductRecommendCard({
    title: '到店搭配推荐',
    products: items,
  });
  const lines = [
    '## 到店搭配推荐',
    '',
    args.memberProfile === undefined
      ? '未识别到会员，以下是基于当前购物篮的通用建议；不使用老客历史偏好。'
      : `顾客 ${args.memberProfile.nameMasked}，以下建议基于当前购物篮、历史消费和库存/毛利信号。`,
    '',
    '| 推荐 SKU | 推荐理由 | 库存状态 | 毛利/风险 | 店员话术 |',
    '|---|---|---|---|---|',
  ];

  for (const item of items) {
    lines.push(
      `| ${item.skuId} ${item.skuName} | ${item.recommendationReason} | ${item.inventoryStatus}；库存 ${item.availableQty} 件 | 毛利率 ${item.grossMarginRate}；毛利风险 ${item.marginRiskLevel} | 店员可以说：${item.staffScript} |`,
    );
  }

  lines.push('', `<!-- card_data:start -->${JSON.stringify(card)}<!-- card_data:end -->`);
  return lines.join('\n');
}

function toCrossSellItem(args: {
  product: ProductPerformanceSignal;
  inventory: ProductInventorySignal;
  marginRiskLevel: MarginRiskLevel;
  fitScore: number;
  hasMember: boolean;
  basketSkuIds: readonly string[];
  historySkuIds: Set<string>;
  repurchaseNear: boolean;
}): CrossSellRecommendationItem {
  const recommendationReason = buildRecommendationReason(args);
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
    fitSegments: args.hasMember ? ['CURRENT_BASKET', 'MEMBER_HISTORY'] : ['CURRENT_BASKET'],
    suggestedMechanism: '到店搭配加购建议，不自动加购、不下单',
    recommendationReason,
    marginRiskLevel: args.marginRiskLevel,
    marginRiskFlag: args.marginRiskLevel !== 'LOW',
    complianceRiskFlag: false,
    brandRiskNote: '',
    fitScore: args.fitScore,
    staffScript: buildStaffScript(args.product.skuName),
  };
}

function buildRecommendationReason(args: {
  product: ProductPerformanceSignal;
  inventory: ProductInventorySignal;
  hasMember: boolean;
  basketSkuIds: readonly string[];
  historySkuIds: Set<string>;
  repurchaseNear: boolean;
}): string {
  const basis = args.hasMember
    ? [
        `历史常购 ${[...args.historySkuIds].join('、') || '未返回'}`,
        `当前购物篮 ${args.basketSkuIds.join('、')}`,
      ]
    : [
        '未识别到会员',
        `基于当前购物篮 ${args.basketSkuIds.join('、')}`,
      ];
  if (args.repurchaseNear) basis.push('复购窗口接近');
  basis.push(`库存 ${args.inventory.availableQty} 件可售`);
  basis.push(`毛利率 ${args.product.grossMarginRate}`);
  return basis.join('；');
}

function buildStaffScript(skuName: string): string {
  return `这款${skuName}和您现在看的商品搭配比较实用，今天库存充足。您可以顺手看一下，合适再决定。`;
}

function hasBasketCategoryFit(
  product: ProductPerformanceSignal,
  products: readonly ProductPerformanceSignal[],
  basket: Set<string>,
): boolean {
  if (basket.size === 0) return true;
  const basketCategories = new Set(
    products
      .filter((item) => basket.has(item.skuId))
      .map((item) => item.categoryId),
  );
  if (basketCategories.size === 0) return true;
  return !basketCategories.has(product.categoryId) || product.categoryId === 'CAT_KIDS';
}

function isRepurchaseNear(signal: CrossSellRepurchaseSignal): boolean {
  if (signal.sampleSize < 3 || signal.confidence === 'LOW') return false;
  return signal.daysSinceLastPurchase >= signal.avgRepurchaseDays * 0.9;
}

function computeFitScore(args: {
  historyFit: boolean;
  basketFit: boolean;
  repurchaseNear: boolean;
  grossMarginRate: number;
  availableQty: number;
}): number {
  return (
    (args.historyFit ? 40 : 0)
    + (args.basketFit ? 30 : 0)
    + (args.repurchaseNear ? 20 : 0)
    + args.grossMarginRate * 10
    + Math.min(args.availableQty, 50) / 10
  );
}

function compareCrossSellItems(a: CrossSellRecommendationItem, b: CrossSellRecommendationItem): number {
  if (a.fitScore !== b.fitScore) return b.fitScore - a.fitScore;
  if (a.marginRiskLevel !== b.marginRiskLevel) {
    return marginRiskRank(a.marginRiskLevel) - marginRiskRank(b.marginRiskLevel);
  }
  return a.skuId.localeCompare(b.skuId);
}

function marginRiskRank(level: MarginRiskLevel): number {
  if (level === 'LOW') return 1;
  if (level === 'MEDIUM') return 2;
  return 3;
}
