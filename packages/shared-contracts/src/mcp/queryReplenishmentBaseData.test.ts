/**
 * 切片 05 — queryReplenishmentBaseData(补货预测唯一上游)单测
 */
import { describe, expect, it } from 'vitest';

import { queryReplenishmentBaseData } from './queryReplenishmentBaseData.js';

describe('queryReplenishmentBaseData', () => {
  it('input happy + forecastDays default=7', () => {
    const i = queryReplenishmentBaseData.input.parse({ merchantId: 'M', storeId: 'S' });
    expect(i.forecastDays).toBe(7);
  });

  it('forecastDays 1..30 范围拒绝', () => {
    expect(() =>
      queryReplenishmentBaseData.input.parse({ merchantId: 'M', storeId: 'S', forecastDays: 0 }),
    ).toThrow();
    expect(() =>
      queryReplenishmentBaseData.input.parse({ merchantId: 'M', storeId: 'S', forecastDays: 31 }),
    ).toThrow();
  });

  it('output happy(含 contextFactors default)', () => {
    const out = queryReplenishmentBaseData.output.parse({
      merchantId: 'M',
      storeId: 'S',
      forecastDays: 7,
      items: [
        {
          skuId: 'X',
          skuName: 'x',
          unit: '瓶',
          recentSalesByDay: [10, 12, 8],
          onHandQty: 50,
        },
      ],
    });
    expect(out.contextFactors.weatherTrend).toBe('UNKNOWN');
    expect(out.contextFactors.isHolidayUpcoming).toBe(false);
    expect(out.items[0]?.inTransitQty).toBe(0);
    expect(out.items[0]?.leadTimeDays).toBe(2);
    expect(out.items[0]?.packSize).toBe(1);
  });

  it('items.max(2000) 边界', () => {
    const items = Array.from({ length: 2001 }, (_, i) => ({
      skuId: `S${i}`,
      skuName: 'x',
      unit: '瓶',
      recentSalesByDay: [],
      onHandQty: 0,
    }));
    expect(() =>
      queryReplenishmentBaseData.output.parse({ merchantId: 'M', storeId: 'S', forecastDays: 7, items }),
    ).toThrow();
  });

  it('recentSalesByDay 数字必须非负', () => {
    expect(() =>
      queryReplenishmentBaseData.output.parse({
        merchantId: 'M',
        storeId: 'S',
        forecastDays: 7,
        items: [
          {
            skuId: 'X',
            skuName: 'x',
            unit: '瓶',
            recentSalesByDay: [-1],
            onHandQty: 0,
          },
        ],
      }),
    ).toThrow();
  });

  it('weatherTrend 枚举漂移拒绝', () => {
    expect(() =>
      queryReplenishmentBaseData.output.parse({
        merchantId: 'M',
        storeId: 'S',
        forecastDays: 7,
        items: [],
        contextFactors: { weatherTrend: 'SNOWY' as never },
      }),
    ).toThrow();
  });
});
