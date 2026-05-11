import { describe, expect, it } from 'vitest';

import { queryInventoryStatusHandler } from './query-inventory-status.js';

const context = {
  tenant: {
    merchantId: 'M001',
    storeId: 'S001',
  },
};

describe('query_inventory_status handler', () => {
  it('returns SKU078 as the deterministic near-expiry and slow-moving inventory signal', () => {
    const result = queryInventoryStatusHandler(
      {
        skuIds: ['SKU078'],
        limit: 10,
      },
      context,
    ) as {
      snapshots: Array<{
        skuId: string;
        availableQty: number;
        stockAgeDays: number;
        nearExpiryDays?: number;
        slowMovingFlag: boolean;
        status: string;
      }>;
    };

    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]).toMatchObject({
      skuId: 'SKU078',
      availableQty: 41,
      stockAgeDays: 90,
      nearExpiryDays: 5,
      slowMovingFlag: true,
      status: 'NEAR_EXPIRY',
    });
  });

  it('filters by inventory status and keeps out-of-contract quantity fields hidden', () => {
    const result = queryInventoryStatusHandler(
      {
        status: 'IN_STOCK',
        limit: 10,
      },
      context,
    ) as { snapshots: Array<{ skuId: string; status: string }> };

    expect(result.snapshots.map((snapshot) => snapshot.skuId)).toContain('SKU001');
    expect(result.snapshots.every((snapshot) => snapshot.status === 'IN_STOCK')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/quantityOnHand|availableQuantity|reservedQuantity/);
  });
});
