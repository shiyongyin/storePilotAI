/**
 * 切片 11 — strategy_invalidation 真实 MySQL integration。
 *
 * 覆盖真实表行到 LRU 清理的链路：
 *   strategy_invalidation INSERT → mysql loader.loadSince(lastSeen) → pollOnce() → applyInvalidation()
 *
 * MySQL 不可达时整组 skip；本地 Docker Compose 默认 root/rootpw 可直接运行。
 */
import { LRUCache } from 'lru-cache';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { afterAll, describe, expect, it } from 'vitest';

import {
  type CachedStrategyEntry,
  createMysqlStrategyInvalidationLoader,
  pollOnce,
} from './strategy-cache.js';

const BASE_URL = process.env['MYSQL_TEST_URL'] ?? 'mysql://root:rootpw@127.0.0.1:3306';
const TEST_SCHEMA = `storepilot_test_slice11_invalidation_${Date.now()}`;

function urlWithSchema(schema: string | null): string {
  return schema ? `${BASE_URL}/${schema}` : BASE_URL;
}

async function setupRealMysql(): Promise<Pool | null> {
  let probe: mysql.Connection | null = null;
  try {
    probe = await mysql.createConnection({ uri: urlWithSchema(null) });
    await probe.query('SELECT 1');
    await probe.query(
      `CREATE DATABASE IF NOT EXISTS \`${TEST_SCHEMA}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } catch {
    if (probe) await probe.end().catch(() => undefined);
    return null;
  } finally {
    if (probe) await probe.end().catch(() => undefined);
  }

  const pool = mysql.createPool({
    uri: urlWithSchema(TEST_SCHEMA),
    connectionLimit: 3,
    queueLimit: 20,
    waitForConnections: true,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS strategy_invalidation (
      id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
      scope          VARCHAR(16)  NOT NULL COMMENT 'PLATFORM|MERCHANT|STORE',
      merchant_id    VARCHAR(64)  NULL  COMMENT 'scope=MERCHANT/STORE 必填',
      store_id       VARCHAR(64)  NULL  COMMENT 'scope=STORE 必填',
      reason         VARCHAR(256) NOT NULL,
      invalidated_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      consumed_at    DATETIME(3)  NULL  COMMENT '切片 11 LRU 消费后写入(防重复处理)',
      KEY idx_invalidation_scope_time (scope, invalidated_at),
      KEY idx_invalidation_consumer (consumed_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT='策略缓存失效信号(切片 11 LRU 重新加载触发)'
  `);

  return pool;
}

const pool = await setupRealMysql();

afterAll(async () => {
  if (pool) await pool.end().catch(() => undefined);
  let cleanup: mysql.Connection | null = null;
  try {
    cleanup = await mysql.createConnection({ uri: urlWithSchema(null) });
    await cleanup.query(`DROP DATABASE IF EXISTS \`${TEST_SCHEMA}\``);
  } catch {
    // best-effort cleanup
  } finally {
    if (cleanup) await cleanup.end().catch(() => undefined);
  }
}, 15_000);

describe.skipIf(!pool)('safety/strategy-invalidation — 真实 MySQL integration', () => {
  it('插入 STORE invalidation 行 → pollOnce 读取真实表并清理对应 LRU key', async () => {
    const cache = new LRUCache<string, CachedStrategyEntry>({ max: 8, ttl: 60_000 });
    cache.set('M001:S001', { merged: {}, version: 'v1', degraded: false });
    cache.set('M001:S002', { merged: {}, version: 'v1', degraded: false });

    await pool!.execute(
      `INSERT INTO strategy_invalidation (scope, merchant_id, store_id, reason, invalidated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(3))`,
      ['STORE', 'M001', 'S001', 'integration-test'],
    );

    const loader = createMysqlStrategyInvalidationLoader(pool!);
    const result = await pollOnce({ loader, since: new Date(0), cache });

    expect(result.consumed).toBe(1);
    expect(cache.has('M001:S001')).toBe(false);
    expect(cache.has('M001:S002')).toBe(true);

    const [rows] = await pool!.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM strategy_invalidation`,
    );
    expect(Number(rows[0]?.['cnt'])).toBe(1);
  });
});
