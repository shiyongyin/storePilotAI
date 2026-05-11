type NewCustomerStageCode = 'THANK_YOU' | 'SECOND_VISIT' | 'RECOVERY';
type NewCustomerReasonCode = 'NEW_FIRST_PURCHASE' | 'NEW_NEED_TWO_VISIT';

export interface NewCustomerMemberSegment {
  memberId?: string | null;
  nameMasked: string;
  phoneMasked?: string;
  level: string;
  joinDate?: string;
  lastVisitAt?: string;
  totalSpent: number;
  totalOrders: number;
  segmentCode: string;
  matchReason: string;
  score?: number;
}

export interface NewCustomerOrder {
  orderId: string;
  orderDate: string;
  salesAmount: number;
  itemCount: number;
  skuIds: readonly string[];
}

export interface NewCustomerConsumptionHistory {
  orders: readonly NewCustomerOrder[];
  frequentSkuIds: readonly string[];
  totalSalesAmount: number;
  totalOrderCount: number;
}

export interface NewCustomerProductSignal {
  skuId: string;
  skuName: string;
  categoryId: string;
  categoryName: string;
  salesQty: number;
  salesAmount: number;
  grossMarginRate: number;
  trend: string;
  inventoryStatus: string;
}

export interface NewCustomerStage {
  stageCode: NewCustomerStageCode;
  title: string;
  suggestedAction: string;
}

export interface NewCustomerSecondVisitItem {
  memberId: string;
  nameMasked: string;
  phoneMasked: string;
  firstPurchaseDate: string;
  firstPurchaseProduct: string;
  firstPurchaseCategory: string;
  daysSinceFirstPurchase: number;
  daysWithoutSecondVisitText: string;
  stageCode: NewCustomerStageCode;
  stageTitle: string;
  reasonCode: NewCustomerReasonCode;
  crossSellSuggestion: string;
  suggestedAction: string;
  suggestedScript: string;
}

const REASON_PRIORITY = new Map<string, number>([
  ['NEW_NEED_TWO_VISIT', 1],
  ['NEW_FIRST_PURCHASE', 2],
]);

export function deriveNewCustomerStage(args: {
  daysSinceFirstPurchase: number;
}): NewCustomerStage | null {
  const { daysSinceFirstPurchase } = args;
  if (daysSinceFirstPurchase >= 0 && daysSinceFirstPurchase <= 3) {
    return {
      stageCode: 'THANK_YOU',
      title: '0-3 天感谢',
      suggestedAction: '感谢提醒，确认尺码和穿着体验',
    };
  }
  if (daysSinceFirstPurchase >= 4 && daysSinceFirstPurchase <= 7) {
    return {
      stageCode: 'SECOND_VISIT',
      title: '4-7 天二次到店',
      suggestedAction: '二次到店券建议，搭配首购品类做邀约',
    };
  }
  if (daysSinceFirstPurchase >= 8 && daysSinceFirstPurchase <= 30) {
    return {
      stageCode: 'RECOVERY',
      title: '8-30 天转化挽回',
      suggestedAction: '转化挽回提醒，结合首购商品做搭配建议',
    };
  }
  return null;
}

export function buildNewCustomerSecondVisitItems(args: {
  asOfDate: string;
  segments: readonly NewCustomerMemberSegment[];
  historiesByMember: Record<string, NewCustomerConsumptionHistory | undefined>;
  products: readonly NewCustomerProductSignal[];
}): NewCustomerSecondVisitItem[] {
  const chosenByMember = chooseNewCustomerSegments(args.segments);
  const productBySku = new Map(args.products.map((product) => [product.skuId, product]));

  return [...chosenByMember.values()]
    .map((segment) => {
      const history = args.historiesByMember[segment.memberId];
      if (history === undefined) return null;
      if (history.totalOrderCount !== 1 || history.orders.length !== 1) return null;

      const firstOrder = history.orders[0];
      if (firstOrder === undefined) return null;
      const daysSinceFirstPurchase = daysBetween(firstOrder.orderDate, args.asOfDate);
      const stage = deriveNewCustomerStage({ daysSinceFirstPurchase });
      if (stage === null) return null;

      const firstSkuId = firstOrder.skuIds[0];
      const product = firstSkuId === undefined ? undefined : productBySku.get(firstSkuId);
      const firstPurchaseProduct = product?.skuName ?? '首购商品未返回';
      const firstPurchaseCategory = product?.categoryName ?? '首购品类未返回';
      const crossSellSuggestion = product === undefined
        ? '到店时根据首购品类做搭配，不编具体 SKU'
        : buildCrossSellSuggestion(product);
      const reasonCode = normalizeReasonCode(segment.segmentCode, daysSinceFirstPurchase);
      const suggestedAction = buildSuggestedAction(stage, product);

      return {
        memberId: segment.memberId,
        nameMasked: segment.nameMasked,
        phoneMasked: segment.phoneMasked ?? '手机号未同步',
        firstPurchaseDate: firstOrder.orderDate,
        firstPurchaseProduct,
        firstPurchaseCategory,
        daysSinceFirstPurchase,
        daysWithoutSecondVisitText: `${daysSinceFirstPurchase} 天未二次到店`,
        stageCode: stage.stageCode,
        stageTitle: stage.title,
        reasonCode,
        crossSellSuggestion,
        suggestedAction,
        suggestedScript: buildSuggestedScript({
          nameMasked: segment.nameMasked,
          stage,
          product,
        }),
      };
    })
    .filter((item): item is NewCustomerSecondVisitItem => item !== null)
    .sort(compareNewCustomerItems);
}

export function buildNewCustomerSecondVisitMarkdown(args: {
  asOfDate: string;
  segments: readonly NewCustomerMemberSegment[];
  historiesByMember: Record<string, NewCustomerConsumptionHistory | undefined>;
  products: readonly NewCustomerProductSignal[];
}): string {
  const items = buildNewCustomerSecondVisitItems(args);
  const cardData = {
    cardType: 'member_wakeup_list_card',
    title: '新客二次到店转化名单',
    members: items.map((item, index) => ({
      memberId: item.memberId,
      nameMasked: item.nameMasked,
      phoneMasked: item.phoneMasked,
      lastVisitAt: item.firstPurchaseDate,
      frequentSkus: item.firstPurchaseProduct === '首购商品未返回' ? [] : [item.firstPurchaseProduct],
      suggestedScript: item.suggestedScript,
      reasonCode: item.reasonCode,
      priority: index + 1,
      suggestedAction: item.suggestedAction,
      confidence: item.stageCode === 'RECOVERY' ? 'HIGH' : 'MEDIUM',
    })),
  };

  const lines = [
    '## 新客二次到店转化',
    '',
    '我按首购后的时间窗整理新客名单；这里只给建议动作、搭配方向和话术，不替你直接发送提醒或发券。',
  ];

  for (const stageTitle of ['0-3 天感谢', '4-7 天二次到店', '8-30 天转化挽回']) {
    const stageItems = items.filter((item) => item.stageTitle === stageTitle);
    lines.push('', `## ${stageTitle}`);
    if (stageItems.length === 0) {
      lines.push('', '当前没有命中新客。');
      continue;
    }
    lines.push('', '| 顾客 | 首购日期 | 首购商品 | 距今 | 阶段 | 建议动作 | 推荐话术 |', '|---|---|---|---:|---|---|---|');
    for (const item of stageItems) {
      lines.push(
        `| ${item.nameMasked} ${item.phoneMasked} | ${item.firstPurchaseDate} | ${item.firstPurchaseProduct}（${item.firstPurchaseCategory}） | ${item.daysSinceFirstPurchase} 天 | ${item.daysWithoutSecondVisitText} | ${item.suggestedAction}；${item.crossSellSuggestion} | ${item.suggestedScript} |`,
      );
    }
  }

  lines.push('', `<!-- card_data:start -->${JSON.stringify(cardData)}<!-- card_data:end -->`);
  return lines.join('\n');
}

function chooseNewCustomerSegments(
  segments: readonly NewCustomerMemberSegment[],
): Map<string, NewCustomerMemberSegment & { memberId: string }> {
  const chosenByMember = new Map<string, NewCustomerMemberSegment & { memberId: string }>();
  for (const segment of segments) {
    if (segment.memberId === undefined || segment.memberId === null) continue;
    if (!REASON_PRIORITY.has(segment.segmentCode)) continue;
    if (segment.totalOrders !== 1) continue;

    const normalized = { ...segment, memberId: segment.memberId };
    const current = chosenByMember.get(segment.memberId);
    if (
      current === undefined ||
      (REASON_PRIORITY.get(normalized.segmentCode) ?? 99) <
        (REASON_PRIORITY.get(current.segmentCode) ?? 99)
    ) {
      chosenByMember.set(segment.memberId, normalized);
    }
  }
  return chosenByMember;
}

function normalizeReasonCode(segmentCode: string, daysSinceFirstPurchase: number): NewCustomerReasonCode {
  if (segmentCode === 'NEW_NEED_TWO_VISIT' || daysSinceFirstPurchase > 7) {
    return 'NEW_NEED_TWO_VISIT';
  }
  return 'NEW_FIRST_PURCHASE';
}

function buildCrossSellSuggestion(product: NewCustomerProductSignal): string {
  return `围绕${product.categoryName}做同类试穿和搭配建议，首购品可参考 ${product.skuName}`;
}

function buildSuggestedAction(
  stage: NewCustomerStage,
  product: NewCustomerProductSignal | undefined,
): string {
  if (stage.stageCode === 'THANK_YOU') return stage.suggestedAction;
  if (product === undefined) return stage.suggestedAction;
  if (stage.stageCode === 'SECOND_VISIT') {
    return `${stage.suggestedAction}，围绕${product.categoryName}做二次到店`;
  }
  return `${stage.suggestedAction}，优先围绕${product.categoryName}做回访`;
}

function buildSuggestedScript(args: {
  nameMasked: string;
  stage: NewCustomerStage;
  product: NewCustomerProductSignal | undefined;
}): string {
  const productText = args.product?.skuName ?? '上次选的商品';
  if (args.stage.stageCode === 'THANK_YOU') {
    return `${args.nameMasked}，上次选的${productText}穿着还合适吗？有需要调尺码或护理建议，我可以帮您留意。`;
  }
  if (args.stage.stageCode === 'SECOND_VISIT') {
    return `${args.nameMasked}，上次选的${productText}可以搭配到店再试一下。最近有适合的新款，您方便时可以来看看。`;
  }
  return `${args.nameMasked}，上次选的${productText}已经过了一段时间。我帮您按同类款留意一下，本周有空可以来店里看看。`;
}

function compareNewCustomerItems(
  a: NewCustomerSecondVisitItem,
  b: NewCustomerSecondVisitItem,
): number {
  const stageDelta = stageRank(a.stageCode) - stageRank(b.stageCode);
  if (stageDelta !== 0) return stageDelta;
  return b.daysSinceFirstPurchase - a.daysSinceFirstPurchase;
}

function stageRank(stageCode: NewCustomerStageCode): number {
  if (stageCode === 'THANK_YOU') return 1;
  if (stageCode === 'SECOND_VISIT') return 2;
  return 3;
}

function daysBetween(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  return Math.floor((end - start) / 86_400_000);
}
