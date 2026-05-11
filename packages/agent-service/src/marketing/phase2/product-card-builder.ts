import type { MarginRiskLevel, ProductRecommendationCandidate } from './product-rules.js';

export interface ProductRecommendCardProduct {
  skuId: string;
  skuName: string;
  categoryCode: string;
  marginRate: number;
  inventoryStatus: string;
  fitSegments: string[];
  suggestedMechanism: string;
  marginRiskFlag: boolean;
  marginRiskLevel: MarginRiskLevel;
  complianceRiskFlag: boolean;
  brandRiskNote: string;
}

export interface ProductRecommendCard {
  cardType: 'product_recommend_card';
  title: string;
  products: ProductRecommendCardProduct[];
}

export function buildProductRecommendCard(args: {
  title: string;
  products: readonly ProductRecommendationCandidate[];
}): ProductRecommendCard {
  if (args.products.length === 0) {
    throw new Error('product_recommend_card requires at least one product');
  }
  return {
    cardType: 'product_recommend_card',
    title: args.title,
    products: args.products.map(toCardProduct),
  };
}

export function buildProductRecommendMarkdown(args: {
  title: string;
  products: readonly ProductRecommendationCandidate[];
}): string {
  const card = buildProductRecommendCard(args);
  const lines = [
    `## ${args.title}`,
    '',
    '商品建议只基于已返回的毛利、库存和风险信号；这里只给推荐机制，不替你改价、清仓或改库存。',
    '',
    '| 商品 | 库存状态 | 毛利率 | 适合人群 | 推荐机制 | 风险说明 |',
    '|---|---|---|---|---|---|',
  ];

  for (const product of args.products) {
    const riskText = [
      `毛利风险 ${product.marginRiskLevel}`,
      product.complianceRiskFlag ? '需做临期/合规检查' : '暂无临期合规标记',
      product.brandRiskNote || '暂无品牌风险提示',
    ].join('；');
    lines.push(
      `| ${product.skuName} | ${product.inventoryStatus}；库存 ${product.availableQty} 件 | 毛利率 ${product.grossMarginRate} | ${product.fitSegments.join('、')} | ${product.suggestedMechanism} | ${riskText} |`,
    );
  }

  lines.push('', `<!-- card_data:start -->${JSON.stringify(card)}<!-- card_data:end -->`);
  return lines.join('\n');
}

function toCardProduct(product: ProductRecommendationCandidate): ProductRecommendCardProduct {
  if (product.availableQty < 0) {
    throw new Error('invalid inventory signal: availableQty must be nonnegative');
  }
  return {
    skuId: product.skuId,
    skuName: product.skuName,
    categoryCode: product.categoryCode,
    marginRate: product.grossMarginRate,
    inventoryStatus: product.inventoryStatus,
    fitSegments: [...product.fitSegments],
    suggestedMechanism: product.suggestedMechanism,
    marginRiskFlag: product.marginRiskFlag,
    marginRiskLevel: product.marginRiskLevel,
    complianceRiskFlag: product.complianceRiskFlag,
    brandRiskNote: product.brandRiskNote,
  };
}
