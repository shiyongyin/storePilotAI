/**
 * 切片 18 §8.6 — safety/mysql-strategy-loader 单测（补充覆盖率门禁 ≥ 90%）
 *
 * 用 FakePool 隔离 mysql2，覆盖 createMysqlStrategyLoader 的 3 个查询路径：
 *   - loadPlatformDefault：__PLATFORM_DEFAULT__ 命中 / 缺失（抛 BizError(INTERNAL_ERROR)）
 *   - loadMerchantStrategy：merchantId 命中 / null
 *   - loadStoreStrategy：(merchantId, storeId) 命中 / null
 *   - parseStrategyJson：object / string / 非法 string / 空 → {}
 */
import { describe, expect, it } from 'vitest';

import type { MysqlStoragePool } from '../mastra/storage/sql.js';

import { createMysqlStrategyLoader } from './mysql-strategy-loader.js';

interface PoolCall {
  sql: string;
  params: readonly unknown[];
}

class FakePool implements Pick<MysqlStoragePool, 'query'> {
  public readonly calls: PoolCall[] = [];
  public rows: Array<{ strategy_json: unknown; version: string }> = [];

  query<T extends Record<string, unknown>>(
    sql: string,
    params: readonly unknown[],
  ): Promise<[T[], unknown]> {
    this.calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return Promise.resolve([this.rows as unknown as T[], undefined]);
  }
}

describe('mysql-strategy-loader — 3 个 loader 函数', () => {
  it('loadPlatformDefault 命中 → 返回 strategyJson + version；object 列直接透传', async () => {
    const pool = new FakePool();
    pool.rows = [{ strategy_json: { foo: 'bar' }, version: 'v1' }];
    const loader = createMysqlStrategyLoader(pool as unknown as MysqlStoragePool);

    const out = await loader.loadPlatformDefault();
    expect(out.strategyJson).toEqual({ foo: 'bar' });
    expect(out.version).toBe('v1');
    expect(pool.calls[0]?.sql).toMatch(/agent_merchant_strategy/);
    expect(pool.calls[0]?.params).toEqual(['__PLATFORM_DEFAULT__']);
  });

  it('loadPlatformDefault 缺行 → 抛 BizError(INTERNAL_ERROR) 含 migration 提示', async () => {
    const pool = new FakePool();
    pool.rows = [];
    const loader = createMysqlStrategyLoader(pool as unknown as MysqlStoragePool);

    await expect(loader.loadPlatformDefault()).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      message: expect.stringContaining('__PLATFORM_DEFAULT__'),
    });
  });

  it('loadMerchantStrategy 命中 → 返回 row；JSON 列为字符串时被 parse', async () => {
    const pool = new FakePool();
    pool.rows = [{ strategy_json: '{"a":1}', version: 'v2' }];
    const loader = createMysqlStrategyLoader(pool as unknown as MysqlStoragePool);

    const out = await loader.loadMerchantStrategy('M001');
    expect(out).toEqual({ strategyJson: { a: 1 }, version: 'v2' });
    expect(pool.calls[0]?.params).toEqual(['M001']);
  });

  it('loadMerchantStrategy 缺行 → null', async () => {
    const pool = new FakePool();
    pool.rows = [];
    const loader = createMysqlStrategyLoader(pool as unknown as MysqlStoragePool);
    expect(await loader.loadMerchantStrategy('M404')).toBeNull();
  });

  it('loadStoreStrategy 命中 → 返回 row + 双参数', async () => {
    const pool = new FakePool();
    pool.rows = [{ strategy_json: { x: 'y' }, version: 'v3' }];
    const loader = createMysqlStrategyLoader(pool as unknown as MysqlStoragePool);

    const out = await loader.loadStoreStrategy('M001', 'S001');
    expect(out).toEqual({ strategyJson: { x: 'y' }, version: 'v3' });
    expect(pool.calls[0]?.params).toEqual(['M001', 'S001']);
  });

  it('loadStoreStrategy 缺行 → null', async () => {
    const pool = new FakePool();
    pool.rows = [];
    const loader = createMysqlStrategyLoader(pool as unknown as MysqlStoragePool);
    expect(await loader.loadStoreStrategy('M001', 'S404')).toBeNull();
  });

  it('parseStrategyJson 非法字符串 → {}', async () => {
    const pool = new FakePool();
    pool.rows = [{ strategy_json: 'not-json', version: 'v9' }];
    const loader = createMysqlStrategyLoader(pool as unknown as MysqlStoragePool);

    const out = await loader.loadMerchantStrategy('M999');
    expect(out?.strategyJson).toEqual({});
  });

  it('parseStrategyJson 字符串里是非 object（如 "true"）→ {}', async () => {
    const pool = new FakePool();
    pool.rows = [{ strategy_json: 'true', version: 'vX' }];
    const loader = createMysqlStrategyLoader(pool as unknown as MysqlStoragePool);

    const out = await loader.loadStoreStrategy('M001', 'S001');
    expect(out?.strategyJson).toEqual({});
  });

  it('parseStrategyJson null / 数字 → {}', async () => {
    const pool = new FakePool();
    pool.rows = [{ strategy_json: null, version: 'vN' }];
    const loader = createMysqlStrategyLoader(pool as unknown as MysqlStoragePool);
    expect((await loader.loadMerchantStrategy('Mn'))?.strategyJson).toEqual({});

    pool.rows = [{ strategy_json: 42, version: 'v42' }];
    expect((await loader.loadMerchantStrategy('M42'))?.strategyJson).toEqual({});
  });
});
