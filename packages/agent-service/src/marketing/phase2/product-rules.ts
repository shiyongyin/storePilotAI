export type InventoryStatus = string;

export type ProductRecommendationMode = 'NORMAL_PROMOTION' | 'CLEARANCE';
export type MarginRiskLevel = 'HIGH' | 'MEDIUM' | 'LOW';

export interface ProductPerformanceSignal {
  skuId: string;
  skuName: string;
  categoryId: string;
  categoryName: string;
  salesQty: number;
  salesAmount: number;
  grossMarginRate: number;
  trend: string;
  inventoryStatus: InventoryStatus;
}

export interface ProductInventorySignal {
  skuId: string;
  skuName: string;
  availableQty: number;
  stockAgeDays: number;
  nearExpiryDays?: number | undefined;
  slowMovingFlag: boolean;
  status: InventoryStatus;
}

export interface ProductRecommendationCandidate {
  skuId: string;
  skuName: string;
  categoryCode: string;
  categoryName: string;
  grossMarginRate: number;
  inventoryStatus: InventoryStatus;
  availableQty: number;
  stockAgeDays: number;
  nearExpiryDays?: number | undefined;
  slowMoving: boolean;
  nearExpiry: boolean;
  fitSegments: readonly string[];
  suggestedMechanism: string;
  recommendationReason: string;
  marginRiskLevel: MarginRiskLevel;
  marginRiskFlag: boolean;
  complianceRiskFlag: boolean;
  brandRiskNote: string;
}

export function isSellableInventory(inventory: Pick<ProductInventorySignal, 'availableQty' | 'status'>): boolean {
  assertValidInventory(inventory);
  return inventory.status !== 'OUT_OF_STOCK' && inventory.availableQty > 0;
}

export function computeMarginRisk(args: {
  originalMarginRate: number;
  discountedMarginRate: number;
  storeAvgMarginRate: number;
}): MarginRiskLevel {
  assertFiniteRate('originalMarginRate', args.originalMarginRate);
  assertFiniteRate('discountedMarginRate', args.discountedMarginRate);
  assertFiniteRate('storeAvgMarginRate', args.storeAvgMarginRate);

  const highThreshold = args.storeAvgMarginRate * 0.5;
  const mediumThreshold = args.storeAvgMarginRate * 0.7;
  if (
    args.discountedMarginRate < 0
    || args.discountedMarginRate < 0.1
    || args.discountedMarginRate < highThreshold
  ) {
    return 'HIGH';
  }
  if (args.discountedMarginRate >= highThreshold && args.discountedMarginRate < mediumThreshold) {
    return 'MEDIUM';
  }
  return 'LOW';
}

export function isSlowMoving(args: {
  slowMovingFlag?: boolean | undefined;
  salesQty30d: number;
  categoryAvgSalesQty30d: number;
  stockAgeDays: number;
}): boolean {
  if (args.slowMovingFlag === true) return true;
  if (args.salesQty30d < 0 || args.categoryAvgSalesQty30d < 0 || args.stockAgeDays < 0) {
    throw new Error('invalid slow-moving signal: negative numeric value');
  }
  return args.salesQty30d < args.categoryAvgSalesQty30d * 0.3 && args.stockAgeDays >= 60;
}

export function isNearExpiry(args: {
  nearExpiryDays?: number | undefined;
  availableQty: number;
}): boolean {
  if (args.availableQty < 0) throw new Error('invalid inventory signal: negative availableQty');
  if (args.nearExpiryDays === undefined) return false;
  if (args.nearExpiryDays < 0) throw new Error('invalid inventory signal: negative nearExpiryDays');
  return args.nearExpiryDays <= 7 && args.availableQty > 0;
}

export function selectProductRecommendationCandidates(args: {
  products: readonly ProductPerformanceSignal[];
  inventoryBySku: Record<string, ProductInventorySignal | undefined>;
  mode: ProductRecommendationMode;
  minMarginRate?: number | undefined;
  storeAvgMarginRate?: number | undefined;
}): ProductRecommendationCandidate[] {
  const candidates = args.products
    .map((product) => {
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
      if (args.mode === 'NORMAL_PROMOTION') {
        if (nearExpiry || inventory.status === 'NEAR_EXPIRY') return null;
        if (slowMoving || inventory.status === 'SLOW_MOVING') return null;
        if (product.grossMarginRate < (args.minMarginRate ?? 0)) return null;
      }
      if (args.mode === 'CLEARANCE' && !nearExpiry && !slowMoving) return null;
      return toProductRecommendationCandidate({
        product,
        inventory,
        mode: args.mode,
        nearExpiry,
        slowMoving,
        storeAvgMarginRate: args.storeAvgMarginRate ?? 0.3,
      });
    })
    .filter((candidate): candidate is ProductRecommendationCandidate => candidate !== null);

  return candidates.sort(compareCandidates);
}

function toProductRecommendationCandidate(args: {
  product: ProductPerformanceSignal;
  inventory: ProductInventorySignal;
  mode: ProductRecommendationMode;
  nearExpiry: boolean;
  slowMoving: boolean;
  storeAvgMarginRate: number;
}): ProductRecommendationCandidate {
  const marginRiskLevel = computeMarginRisk({
    originalMarginRate: args.product.grossMarginRate,
    discountedMarginRate: args.product.grossMarginRate,
    storeAvgMarginRate: args.storeAvgMarginRate,
  });
  const complianceRiskFlag = args.nearExpiry;
  const marginRiskFlag = marginRiskLevel !== 'LOW';
  const brandRiskNote = args.mode === 'CLEARANCE'
    ? '清库存需控制优惠力度，避免伤害毛利和品牌形象'
    : '';
  const suggestedMechanism = args.mode === 'CLEARANCE'
    ? '清库存前先核对毛利、临期合规和品牌影响'
    : '老客搭配推荐或加价购，不直接改价';
  const fitSegments = args.mode === 'CLEARANCE'
    ? ['PRICE_SENSITIVE']
    : ['LOYAL_FREQUENT', 'HIGH_VALUE'];
  const reasonParts = [
    `毛利率 ${args.product.grossMarginRate}`,
    `库存 ${args.inventory.availableQty} 件可售`,
    args.slowMoving ? `库龄 ${args.inventory.stockAgeDays} 天且滞销` : null,
    args.nearExpiry && args.inventory.nearExpiryDays !== undefined
      ? `临期 ${args.inventory.nearExpiryDays} 天`
      : null,
  ].filter((part): part is string => part !== null);

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
    fitSegments,
    suggestedMechanism,
    recommendationReason: reasonParts.join('；'),
    marginRiskLevel,
    marginRiskFlag,
    complianceRiskFlag,
    brandRiskNote,
  };
}

function compareCandidates(a: ProductRecommendationCandidate, b: ProductRecommendationCandidate): number {
  if (a.marginRiskLevel !== b.marginRiskLevel) {
    return marginRiskRank(a.marginRiskLevel) - marginRiskRank(b.marginRiskLevel);
  }
  if (a.grossMarginRate !== b.grossMarginRate) return b.grossMarginRate - a.grossMarginRate;
  return a.skuId.localeCompare(b.skuId);
}

function marginRiskRank(level: MarginRiskLevel): number {
  if (level === 'LOW') return 1;
  if (level === 'MEDIUM') return 2;
  return 3;
}

function assertValidInventory(inventory: Pick<ProductInventorySignal, 'availableQty'>): void {
  if (!Number.isInteger(inventory.availableQty) || inventory.availableQty < 0) {
    throw new Error('invalid inventory signal: availableQty must be a nonnegative integer');
  }
}

function assertFiniteRate(field: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`invalid margin signal: ${field} must be finite`);
  }
}
