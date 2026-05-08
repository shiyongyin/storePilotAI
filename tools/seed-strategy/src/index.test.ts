/**
 * 切片 21 — seed-strategy CLI 单测（loadSeedRows 解析 + StrategySchema 校验）
 *
 * 不连接真实 DB；用 fixture 文件验证：
 *   - 单条对象 / 数组形态都能正常解析；
 *   - 缺 `merchantId` / `version` → 抛错；
 *   - `strategyJson` 不符合 StrategySchema → 抛错；
 *   - 入参 status 非 enabled/disabled → 抛错。
 *
 * 用 node:test 而非 vitest，保持 tools 包一致风格（同 `tools/migrate-runner`）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

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

void test('loadSeedRows: 单条对象 → 解析成 1 行；StrategySchema 校验通过', () => {
  const json = JSON.stringify({
    merchantId: 'M042',
    version: 'merchant-M042-v1.0.0',
    strategyJson: HAPPY_STRATEGY,
  });
  withTmpFile(json, (file) => {
    const rows = loadSeedRows(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.merchantId, 'M042');
    assert.equal(rows[0]!.storeId, null);
    assert.equal(rows[0]!.status, 'enabled');
  });
});

void test('loadSeedRows: 数组形态 → 解析多行；含 storeId 的行被识别为门店级策略', () => {
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
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.storeId, null);
    assert.equal(rows[1]!.storeId, 'S042-01');
  });
});

void test('loadSeedRows: 缺 merchantId → 抛错', () => {
  const json = JSON.stringify({
    version: 'v1',
    strategyJson: HAPPY_STRATEGY,
  });
  withTmpFile(json, (file) => {
    assert.throws(() => loadSeedRows(file), /merchantId/);
  });
});

void test('loadSeedRows: strategyJson 不符合 StrategySchema → 抛错', () => {
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
    assert.throws(() => loadSeedRows(file), /StrategySchema/);
  });
});

void test('loadSeedRows: status 非法 → 抛错', () => {
  const json = JSON.stringify({
    merchantId: 'M042',
    version: 'v1',
    status: 'DEPRECATED',
    strategyJson: HAPPY_STRATEGY,
  });
  withTmpFile(json, (file) => {
    assert.throws(() => loadSeedRows(file), /status/);
  });
});
