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

type ClearanceActionType = 'PROMOTION_WITH_CHECK' | 'MARGIN_PROTECT' | 'REMOVE_ONLY';

export interface SlowMovingProductSignal extends ProductPerformanceSignal {
  stockValueAtCost?: number | undefined;
  stockValueAtPrice?: number | undefined;
}

export interface SlowMovingCampaignSignal {
  campaignId: string;
  campaignName: string;
  grossMarginRate: number;
  resultSummary: string;
}

export interface SlowMovingRecommendationItem extends ProductRecommendationCandidate {
  actionType: ClearanceActionType;
  clearanceReason: string;
  salesSignalText: string;
  inventoryValueText: string;
  marginRiskText: string;
  complianceRiskText: string;
  campaignReference: string;
}

export function buildSlowMovingRecommendations(args: {
  products: readonly SlowMovingProductSignal[];
  inventoryBySku: Record<string, ProductInventorySignal | undefined>;
  campaigns?: readonly SlowMovingCampaignSignal[] | undefined;
  discountedMarginRateBySku?: Record<string, number | undefined> | undefined;
  storeAvgMarginRate?: number | undefined;
  limit?: number | undefined;
}): SlowMovingRecommendationItem[] {
  const storeAvgMarginRate = args.storeAvgMarginRate ?? 0.3;
  const campaignReference = buildCampaignReference(args.campaigns ?? []);

  return args.products
    .map((product) => {
      const inventory = args.inventoryBySku[product.skuId];
      if (inventory === undefined) return null;
      const expiredOrUnavailable = isExpiredOrUnavailable(inventory);
      if (!expiredOrUnavailable && !isSellableInventory(inventory)) return null;
      if (inventory.status === 'PHASE_OUT' && !expiredOrUnavailable) return null;

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
      if (!expiredOrUnavailable && !nearExpiry && !slowMoving && inventory.status !== 'SLOW_MOVING') return null;

      const discountedMarginRate = args.discountedMarginRateBySku?.[product.skuId] ?? product.grossMarginRate;
      const marginRiskLevel = expiredOrUnavailable
        ? 'LOW'
        : computeMarginRisk({
            originalMarginRate: product.grossMarginRate,
            discountedMarginRate,
            storeAvgMarginRate,
          });
      return toSlowMovingItem({
        product,
        inventory,
        slowMoving,
        nearExpiry,
        expiredOrUnavailable,
        discountedMarginRate,
        marginRiskLevel,
        campaignReference,
      });
    })
    .filter((item): item is SlowMovingRecommendationItem => item !== null)
    .sort(compareClearanceItems)
    .slice(0, args.limit ?? 10);
}

export function buildSlowMovingMarkdown(args: {
  products: readonly SlowMovingProductSignal[];
  inventoryBySku: Record<string, ProductInventorySignal | undefined>;
  campaigns?: readonly SlowMovingCampaignSignal[] | undefined;
  discountedMarginRateBySku?: Record<string, number | undefined> | undefined;
  storeAvgMarginRate?: number | undefined;
  limit?: number | undefined;
}): string {
  const items = buildSlowMovingRecommendations(args);
  const card = buildProductRecommendCard({
    title: '滞销/临期库存处理建议',
    products: items,
  });
  const lines = [
    '## 滞销/临期库存处理建议',
    '',
    '以下只基于已返回的库存、库龄、临期和毛利信号给处理建议；不替你执行价格、库存或活动动作。',
    '',
    '| 商品 | 库存/库龄 | 近 30 天销量/原因 | 库存金额 | 建议机制 | 毛利风险 | 合规风险 | 品牌风险 |',
    '|---|---|---|---|---|---|---|---|',
  ];

  for (const item of items) {
    lines.push(
      `| ${item.skuId} ${item.skuName} | ${item.clearanceReason} | ${item.salesSignalText} | ${item.inventoryValueText} | ${item.suggestedMechanism} | ${item.marginRiskText} | ${item.complianceRiskText} | ${item.brandRiskNote} |`,
    );
  }

  lines.push('', `<!-- card_data:start -->${JSON.stringify(card)}<!-- card_data:end -->`);
  return lines.join('\n');
}

function toSlowMovingItem(args: {
  product: SlowMovingProductSignal;
  inventory: ProductInventorySignal;
  slowMoving: boolean;
  nearExpiry: boolean;
  expiredOrUnavailable: boolean;
  discountedMarginRate: number;
  marginRiskLevel: MarginRiskLevel;
  campaignReference: string;
}): SlowMovingRecommendationItem {
  const actionType = chooseActionType(args.expiredOrUnavailable, args.marginRiskLevel);
  const suggestedMechanism = chooseMechanism(actionType, args.nearExpiry, args.slowMoving);
  const complianceRiskFlag = args.nearExpiry || args.expiredOrUnavailable;
  const marginRiskFlag = !args.expiredOrUnavailable && args.marginRiskLevel !== 'LOW';
  const brandRiskNote = '过度清仓伤品牌形象';

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
    slowMoving: args.slowMoving,
    nearExpiry: args.nearExpiry,
    fitSegments: ['PRICE_SENSITIVE', 'GENERAL_MEMBERS'],
    suggestedMechanism,
    recommendationReason: buildRecommendationReason(args),
    marginRiskLevel: args.marginRiskLevel,
    marginRiskFlag,
    complianceRiskFlag,
    brandRiskNote,
    actionType,
    clearanceReason: buildClearanceReason(args.inventory),
    salesSignalText: buildSalesSignalText(args.product, args.slowMoving),
    inventoryValueText: buildInventoryValueText(args.product),
    marginRiskText: buildMarginRiskText(args.marginRiskLevel, args.discountedMarginRate, args.expiredOrUnavailable),
    complianceRiskText: buildComplianceRiskText(args.inventory, args.expiredOrUnavailable),
    campaignReference: args.campaignReference,
  };
}

function chooseActionType(expiredOrUnavailable: boolean, marginRiskLevel: MarginRiskLevel): ClearanceActionType {
  if (expiredOrUnavailable) return 'REMOVE_ONLY';
  if (marginRiskLevel === 'HIGH') return 'MARGIN_PROTECT';
  return 'PROMOTION_WITH_CHECK';
}

function chooseMechanism(actionType: ClearanceActionType, nearExpiry: boolean, slowMoving: boolean): string {
  if (actionType === 'REMOVE_ONLY') return '已不可售，只建议下架/报损/联系 ERP 流程';
  if (actionType === 'MARGIN_PROTECT') {
    return '不建议大折扣；优先陈列调整、搭配赠品或内部消化，并先核算毛利';
  }
  if (nearExpiry) return '确认可售期后，小范围提醒价格敏感顾客；避免默认推给高价值客户';
  if (slowMoving) return '搭配销售、陈列调整或老客加价购，控制优惠力度';
  return '先核对库存与毛利，再做小范围测试';
}

function buildClearanceReason(inventory: ProductInventorySignal): string {
  const nearExpiryText = inventory.nearExpiryDays === undefined
    ? '临期天数未返回'
    : `${inventory.nearExpiryDays} 天临期`;
  return `库龄 ${inventory.stockAgeDays} 天 / ${nearExpiryText} / 剩余 ${inventory.availableQty} 件`;
}

function buildSalesSignalText(product: SlowMovingProductSignal, slowMoving: boolean): string {
  const reason = slowMoving ? '低于同类动销阈值或工具已标记滞销' : '临期优先处理';
  return `近 30 天销量 ${product.salesQty} 件；${reason}`;
}

function buildInventoryValueText(product: SlowMovingProductSignal): string {
  if (product.stockValueAtCost !== undefined) return `库存成本金额 ${product.stockValueAtCost} 元`;
  if (product.stockValueAtPrice !== undefined) return `库存售价金额 ${product.stockValueAtPrice} 元`;
  return '库存金额未返回，不编造金额';
}

function buildMarginRiskText(
  marginRiskLevel: MarginRiskLevel,
  discountedMarginRate: number,
  expiredOrUnavailable: boolean,
): string {
  if (expiredOrUnavailable) return '不销售，不计算促销毛利风险';
  return `折后毛利率 ${formatPercent(discountedMarginRate)}，毛利风险 ${marginRiskLevel}`;
}

function buildComplianceRiskText(inventory: ProductInventorySignal, expiredOrUnavailable: boolean): string {
  if (expiredOrUnavailable) return '已不可售，不得建议销售；需下架/报损/走 ERP 流程';
  if (inventory.nearExpiryDays !== undefined && inventory.nearExpiryDays <= 7) {
    return '合规风险：确认仍在可售期、符合门店/监管规则后再执行';
  }
  return '合规风险：未见临期信号，仍需按门店规则复核';
}

function buildRecommendationReason(args: {
  product: SlowMovingProductSignal;
  inventory: ProductInventorySignal;
  slowMoving: boolean;
  nearExpiry: boolean;
  expiredOrUnavailable: boolean;
  campaignReference: string;
}): string {
  const parts = [
    buildClearanceReason(args.inventory),
    buildSalesSignalText(args.product, args.slowMoving),
    args.nearExpiry ? '临期商品必须先做合规检查' : '',
    args.expiredOrUnavailable ? '不可售，仅建议下架/报损' : '',
    args.campaignReference,
  ].filter((part) => part.length > 0);
  return parts.join('；');
}

function buildCampaignReference(campaigns: readonly SlowMovingCampaignSignal[]): string {
  const latest = campaigns[0];
  if (latest === undefined) return '历史清库存活动参考未返回';
  return `参考历史活动 ${latest.campaignName}：${latest.resultSummary}`;
}

function isExpiredOrUnavailable(inventory: ProductInventorySignal): boolean {
  return (inventory.nearExpiryDays !== undefined && inventory.nearExpiryDays <= 0)
    || inventory.availableQty <= 0
    || inventory.status === 'OUT_OF_STOCK'
    || inventory.status === 'PHASE_OUT';
}

function compareClearanceItems(a: SlowMovingRecommendationItem, b: SlowMovingRecommendationItem): number {
  if (a.actionType !== b.actionType) return actionRank(a.actionType) - actionRank(b.actionType);
  const aNearExpiry = a.nearExpiryDays ?? Number.POSITIVE_INFINITY;
  const bNearExpiry = b.nearExpiryDays ?? Number.POSITIVE_INFINITY;
  if (aNearExpiry !== bNearExpiry) return aNearExpiry - bNearExpiry;
  if (a.stockAgeDays !== b.stockAgeDays) return b.stockAgeDays - a.stockAgeDays;
  return a.skuId.localeCompare(b.skuId);
}

function actionRank(actionType: ClearanceActionType): number {
  if (actionType === 'REMOVE_ONLY') return 0;
  if (actionType === 'MARGIN_PROTECT') return 1;
  return 2;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
