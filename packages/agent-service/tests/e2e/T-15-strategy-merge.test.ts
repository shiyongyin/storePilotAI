/**
 * 切片 19 — T-15 Strategy 三层合并（PLATFORM ⊂ MERCHANT ⊂ STORE 右覆盖）
 *
 * 严格按 docs/tanks/19-test-e2e-20-cases.md §8.1 §T-15 + 切片 11 落地：
 *   - PLATFORM 层（migration 007 seed 行）
 *   - MERCHANT 层（agent_merchant_strategy）覆盖 PLATFORM
 *   - STORE 层（agent_store_strategy）覆盖 MERCHANT 层
 *   - 真 MysqlStrategyLoader（任务卡 §7 MUST NOT §3 — 不 mock DB）
 *
 * @since 切片 19
 */
import type { Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { logCommand } from './_helpers/chat-client.js';
import { ensureBaseEnv } from './_helpers/env.js';
import {
  asAuthPool,
  cleanTenantData,
  closeMysqlPool,
  getMysqlPool,
  isMysqlReady,
} from './_helpers/mysql.js';

ensureBaseEnv();

const MERCHANT_ID = 'M_E2E_T15';
const STORE_ID = 'S_E2E_T15';

let pool: Pool;

beforeAll(async () => {
  if (!isMysqlReady()) return;
  pool = getMysqlPool();
  await cleanTenantData(pool, MERCHANT_ID);

  // 写入 MERCHANT 行：把 reportPolicy.maxSummaryChars 改成 999（覆盖 platform）
  await pool.execute(
    `INSERT INTO agent_merchant_strategy (merchant_id, version, strategy_json, status)
     VALUES (?, 'v-e2e-t15-m', CAST(? AS JSON), 'enabled')`,
    [
      MERCHANT_ID,
      JSON.stringify({ reportPolicy: { maxSummaryChars: 999, maxCards: 4 } }),
    ],
  );
  // 写入 STORE 行：进一步把 reportPolicy.maxCards 改成 7（覆盖 merchant）
  await pool.execute(
    `INSERT INTO agent_store_strategy (merchant_id, store_id, version, strategy_json, status)
     VALUES (?, ?, 'v-e2e-t15-s', CAST(? AS JSON), 'enabled')`,
    [
      MERCHANT_ID,
      STORE_ID,
      JSON.stringify({ reportPolicy: { maxCards: 7 } }),
    ],
  );
}, 30_000);

afterAll(async () => {
  if (isMysqlReady()) {
    await cleanTenantData(pool, MERCHANT_ID).catch(() => undefined);
    await closeMysqlPool();
  }
  vi.unstubAllEnvs();
});

describe.skipIf(!isMysqlReady())('T-15 Strategy 三层合并（任务卡 §8.1 §T-15）', () => {
  it('STORE 覆盖 MERCHANT 覆盖 PLATFORM', async () => {
    logCommand(
      'T-15',
      'mergeStrategy({merchantId,storeId}) 三层 deepMerge',
      'merged.reportPolicy.maxSummaryChars=999 (merchant), maxCards=7 (store)',
    );
    const strategyEngine = await import('../../src/safety/strategy-engine.js');
    const loaderMod = await import('../../src/safety/mysql-strategy-loader.js');
    strategyEngine.setStrategyLoader(loaderMod.createMysqlStrategyLoader(asAuthPool(pool)));
    strategyEngine.resetStrategyEngineForTest(); // 清缓存

    // 重新 set loader 因为 reset 把 loader 也清了
    strategyEngine.setStrategyLoader(loaderMod.createMysqlStrategyLoader(asAuthPool(pool)));

    const result = await strategyEngine.mergeStrategy({
      merchantId: MERCHANT_ID,
      storeId: STORE_ID,
    });

    expect(result.degraded).toBe(false);
    expect(result.merged.reportPolicy.maxSummaryChars).toBe(999);
    expect(result.merged.reportPolicy.maxCards).toBe(7);
    expect(result.version).toMatch(/M.*-S.*-P/);
  });
});
