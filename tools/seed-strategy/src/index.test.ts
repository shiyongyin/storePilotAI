/**
 * 切片 21 — seed-strategy CLI 单测（loadSeedRows 解析 + StrategySchema 校验）
 *
 * 不连接真实 DB；用 fixture 文件验证：
 *   - 单条对象 / 数组形态都能正常解析；
 *   - 缺 `merchantId` / `version` → 抛错；
 *   - `strategyJson` 不符合 StrategySchema → 抛错；
 *   - 入参 status 非 enabled/disabled → 抛错。
 *
 * 使用 Vitest，保持 monorepo 测试 runner 统一。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadSeedRows } from './index.js';

function withTmpFile<T>(content: string, run: (filePath: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), 'seed-strategy-'));
  const file = path.join(dir, 'strategy.json');
  writeFileSync(file, content, 'utf-8');
  try {
    return run(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const HAPPY_STRATEGY = {
  enabledSkills: ['business_daily_report'],
  replenishmentPolicy: {
    forecastDays: 7,
    safetyStockDays: 2,
    requireConfirmBeforePurchaseOrder: true,
    allowAutoPurchaseOrder: false,
    forecastMethod: 'weighted_moving_average',
  },
  reportPolicy: { maxSummaryChars: 8000, maxCards: 12 },
  safetyPolicy: {
    requireUserConfirmForWrite: true,
    maxAdjustmentsPerDraft: 10,
    majorAdjustmentRatio: 0.5,
    draftAutoExpireMinutes: 30,
  },
};

describe('loadSeedRows', () => {
  it('单条对象 → 解析成 1 行；StrategySchema 校验通过', () => {
    const json = JSON.stringify({
      merchantId: 'M042',
      version: 'merchant-M042-v1.0.0',
      strategyJson: HAPPY_STRATEGY,
    });
    withTmpFile(json, (file) => {
      const rows = loadSeedRows(file);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.merchantId).toBe('M042');
      expect(rows[0]!.storeId).toBeNull();
      expect(rows[0]!.status).toBe('enabled');
    });
  });

  it('数组形态 → 解析多行；含 storeId 的行被识别为门店级策略', () => {
    const json = JSON.stringify([
      {
        merchantId: 'M042',
        version: 'merchant-M042-v1.0.0',
        strategyJson: HAPPY_STRATEGY,
      },
      {
        merchantId: 'M042',
        storeId: 'S042-01',
        version: 'store-M042-S042-01-v1.0.0',
        status: 'enabled',
        strategyJson: HAPPY_STRATEGY,
      },
    ]);
    withTmpFile(json, (file) => {
      const rows = loadSeedRows(file);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.storeId).toBeNull();
      expect(rows[1]!.storeId).toBe('S042-01');
    });
  });

  it('缺 merchantId → 抛错', () => {
    const json = JSON.stringify({
      version: 'v1',
      strategyJson: HAPPY_STRATEGY,
    });
    withTmpFile(json, (file) => {
      expect(() => loadSeedRows(file)).toThrow(/merchantId/);
    });
  });

  it('strategyJson 不符合 StrategySchema → 抛错', () => {
    const bad = {
      ...HAPPY_STRATEGY,
      replenishmentPolicy: {
        ...HAPPY_STRATEGY.replenishmentPolicy,
        allowAutoPurchaseOrder: true, // V1 红线：必须 false
      },
    };
    const json = JSON.stringify({
      merchantId: 'M042',
      version: 'v1',
      strategyJson: bad,
    });
    withTmpFile(json, (file) => {
      expect(() => loadSeedRows(file)).toThrow(/StrategySchema/);
    });
  });

  it('status 非法 → 抛错', () => {
    const json = JSON.stringify({
      merchantId: 'M042',
      version: 'v1',
      status: 'DEPRECATED',
      strategyJson: HAPPY_STRATEGY,
    });
    withTmpFile(json, (file) => {
      expect(() => loadSeedRows(file)).toThrow(/status/);
    });
  });
});
