import { describe, expect, it } from 'vitest';

import { marketingShoeStoreFixtures } from '../fixtures/marketing-shoe-store/index.js';
import { queryMemberConsumptionHistoryHandler } from './query-member-consumption-history.js';

const context = {
  tenant: {
    merchantId: 'M001',
    storeId: 'S001',
  },
};

describe('query_member_consumption_history handler', () => {
  it('raw fixture output does not include tenant-only extra fields in nested orders', () => {
    const result = marketingShoeStoreFixtures.query_member_consumption_history?.({
      merchantId: 'M001',
      storeId: 'S001',
      memberId: 'MBR_00123',
      dateRange: { startDate: '2025-08-15', endDate: '2026-05-10' },
    }) as {
      orders: Array<Record<string, unknown>>;
    };

    expect(result.orders[0]).toEqual({
      orderId: 'ORD_20260310_00123',
      orderDate: '2026-03-10',
      salesAmount: 399,
      itemCount: 1,
      skuIds: ['SKU001'],
    });
  });

  it('returns order rows that match the shared contract without tenant-only extra fields', () => {
    const result = queryMemberConsumptionHistoryHandler(
      {
        memberId: 'MBR_00123',
        dateRange: { startDate: '2025-08-15', endDate: '2026-05-10' },
      },
      context,
    ) as {
      memberId: string;
      orders: Array<Record<string, unknown>>;
      frequentSkuIds: string[];
      totalSalesAmount: number;
      totalOrderCount: number;
    };

    expect(result.memberId).toBe('MBR_00123');
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]).toEqual({
      orderId: 'ORD_20260310_00123',
      orderDate: '2026-03-10',
      salesAmount: 399,
      itemCount: 1,
      skuIds: ['SKU001'],
    });
    expect(result.orders[0]).not.toHaveProperty('merchantId');
    expect(result.orders[0]).not.toHaveProperty('storeId');
    expect(result.orders[0]).not.toHaveProperty('memberId');
    expect(result.frequentSkuIds).toEqual(['SKU001']);
    expect(result.totalSalesAmount).toBe(399);
    expect(result.totalOrderCount).toBe(1);
  });
});
