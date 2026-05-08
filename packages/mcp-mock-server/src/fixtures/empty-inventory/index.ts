/**
 * 切片 05 — empty-inventory profile
 * 库存全零,验证切片 14 零库存边界 + 切片 12 inventory_overview 卡片降级。
 */
import type { ProfileFixtures } from '../../support/fixture-loader.js';
import { happyPathFixtures } from '../happy-path/index.js';

export const emptyInventoryFixtures: ProfileFixtures = {
  queryInventoryOverview: (input: unknown) => {
    const { merchantId, storeId } = input as { merchantId: string; storeId: string };
    return {
      merchantId,
      storeId,
      totalSkus: 5,
      lowStockSkus: 0,
      outOfStockSkus: 5,
      totalOnHandValue: 0,
      asOf: new Date().toISOString(),
    };
  },
  queryReplenishmentBaseData: (input: unknown) => {
    const fn = happyPathFixtures.queryReplenishmentBaseData;
    if (!fn) throw new Error('[mcp-mock] happy-path queryReplenishmentBaseData missing');
    const base = fn(input) as {
      items: Array<{ onHandQty: number; inTransitQty: number; [k: string]: unknown }>;
      [k: string]: unknown;
    };
    return {
      ...base,
      items: base.items.map((it) => ({ ...it, onHandQty: 0, inTransitQty: 0 })),
    };
  },
};
