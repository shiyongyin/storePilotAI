import { describe, expect, it } from 'vitest';

import { queryProductPerformanceHandler } from './query-product-performance.js';

const context = {
  tenant: {
    merchantId: 'M001',
    storeId: 'S001',
  },
};

describe('query_product_performance handler', () => {
  it('returns SKU001 as the deterministic high-margin signal for product promotion', () => {
    const result = queryProductPerformanceHandler(
      {
        dateRange: { startDate: '2026-05-01', endDate: '2026-05-11' },
        skuIds: ['SKU001'],
        limit: 10,
      },
      context,
    ) as {
      products: Array<{
        skuId: string;
        skuName: string;
        categoryId: string;
        grossMarginRate: number;
        inventoryStatus: string;
      }>;
    };

    expect(result.products).toHaveLength(1);
    expect(result.products[0]).toMatchObject({
      skuId: 'SKU001',
      skuName: '轻跑鞋 SKU001',
      categoryId: 'CAT_RUNNING',
      grossMarginRate: 0.46,
      inventoryStatus: 'IN_STOCK',
    });
  });

  it('keeps product performance tenant-scoped and does not expose cost or internal fields', () => {
    const result = queryProductPerformanceHandler(
      {
        dateRange: { startDate: '2026-05-01', endDate: '2026-05-11' },
        categoryId: 'CAT_CASUAL',
        limit: 10,
      },
      context,
    ) as { products: Array<{ skuId: string; categoryId: string }> };

    expect(result.products.map((product) => product.skuId)).toContain('SKU078');
    expect(result.products.every((product) => product.categoryId === 'CAT_CASUAL')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/cost|supplier|merchantSecret|storeSecret/);
  });
});
