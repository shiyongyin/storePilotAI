/**
 * 切片 07 — sql.ts Pool 单例 / DI 助手单测（任务卡 §7 MUST DO §6 池复用）。
 *
 * 不依赖真实 MySQL —— 验证：
 *   1. 单例：多次 getOrCreateMysqlStoragePool 同 env → 同实例
 *   2. setMysqlStoragePoolForTest / resetMysqlStoragePoolForTest 替换语义
 *   3. closeMysqlStoragePool 幂等（未创建过 NOOP）
 *   4. closeMysqlStoragePool 调用 pool.end() 后清空单例引用
 *
 * 真实 mysql2 Pool 创建路径在 mysql-adapter.test.ts 中通过 wrap 注入覆盖；
 * 本文件用 fake pool 验证 sql.ts 的纯逻辑分支，避免在每次单测启动时真连 MySQL。
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../../observability/logger.js';

import {
  closeMysqlStoragePool,
  getOrCreateMysqlStoragePool,
  resetMysqlStoragePoolForTest,
  setMysqlStoragePoolForTest,
  type MysqlStoragePool,
} from './sql.js';

/**
 * 真实 mysql 连接 base URL；不含 schema 部分（在 probeMysql 中临时建库）。
 * 默认对齐 docker-compose.dev 的 root/rootpw；可由 MYSQL_TEST_URL 覆盖。
 */
const BASE_URL = process.env.MYSQL_TEST_URL ?? 'mysql://root:rootpw@127.0.0.1:3306';
const TEST_SCHEMA = `storepilot_test_slice07_sql_${Date.now()}`;

/**
 * sql.ts 自身的"创建真实 mysql2 Pool + wrap"路径覆盖：
 *   - getOrCreateMysqlStoragePool 第一次调用走 mysql.createPool + wrapMysql2Pool；
 *   - query / execute 调用 wrap 内部的转发逻辑（覆盖 line 87-110）；
 *   - closeMysqlStoragePool 触发 pool.end() 真正释放底层连接。
 *
 * 与 mysql-adapter.test.ts 的真连测试解耦：本组只验证 sql.ts 自身实现，
 * 用独立的临时 schema 跑 SELECT 1 / TEMPORARY TABLE。MySQL 不可达 → 整体 skip。
 *
 * @returns 拼好 schema 的 URL；连不上则 null。
 */
async function probeMysqlAndCreateSchema(): Promise<string | null> {
  try {
    const mysql = await import('mysql2/promise');
    const c = await mysql.default.createConnection({ uri: BASE_URL });
    try {
      await c.query('SELECT 1');
      await c.query(
        `CREATE DATABASE IF NOT EXISTS \`${TEST_SCHEMA}\`
         CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
    } finally {
      await c.end();
    }
    return `${BASE_URL}/${TEST_SCHEMA}`;
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e), baseUrl: BASE_URL },
      '[test/slice07-sql] MySQL 不可达，sql.ts 真连接覆盖测试将 skip',
    );
    return null;
  }
}

const TEST_URL = await probeMysqlAndCreateSchema();
const sqlMysqlAvailable = TEST_URL !== null;

afterEach(() => {
  resetMysqlStoragePoolForTest();
});

describe('切片 07 — sql.ts Pool 单例', () => {
  it('setMysqlStoragePoolForTest 注入后，getOrCreateMysqlStoragePool 返回同实例', () => {
    const fake: MysqlStoragePool = {
      query: () => Promise.resolve([[], undefined]),
      execute: () => Promise.resolve([{ affectedRows: 0 }, undefined]),
      end: () => Promise.resolve(),
    };
    setMysqlStoragePoolForTest(fake);
    const got = getOrCreateMysqlStoragePool({ DATABASE_URL: 'mysql://x:x@127.0.0.1:3306/db' });
    expect(got).toBe(fake);
  });

  it('多次 getOrCreateMysqlStoragePool 返回同一引用（生产单例语义）', () => {
    const fake: MysqlStoragePool = {
      query: () => Promise.resolve([[], undefined]),
      execute: () => Promise.resolve([{ affectedRows: 0 }, undefined]),
      end: () => Promise.resolve(),
    };
    setMysqlStoragePoolForTest(fake);
    const a = getOrCreateMysqlStoragePool({ DATABASE_URL: 'mysql://x:x@127.0.0.1:3306/db' });
    const b = getOrCreateMysqlStoragePool({ DATABASE_URL: 'mysql://x:x@127.0.0.1:3306/db' });
    expect(a).toBe(b);
  });

  it('resetMysqlStoragePoolForTest 后 set 才能换新实例', () => {
    const fakeA: MysqlStoragePool = {
      query: () => Promise.resolve([[], undefined]),
      execute: () => Promise.resolve([{ affectedRows: 0 }, undefined]),
      end: () => Promise.resolve(),
    };
    const fakeB: MysqlStoragePool = {
      query: () => Promise.resolve([[], undefined]),
      execute: () => Promise.resolve([{ affectedRows: 1 }, undefined]),
      end: () => Promise.resolve(),
    };
    setMysqlStoragePoolForTest(fakeA);
    expect(getOrCreateMysqlStoragePool({ DATABASE_URL: 'x' })).toBe(fakeA);
    resetMysqlStoragePoolForTest();
    setMysqlStoragePoolForTest(fakeB);
    expect(getOrCreateMysqlStoragePool({ DATABASE_URL: 'x' })).toBe(fakeB);
  });
});

describe('切片 07 — closeMysqlStoragePool', () => {
  it('未创建过 → NOOP 不抛错（幂等）', async () => {
    await expect(closeMysqlStoragePool()).resolves.toBeUndefined();
  });

  it('创建后调用 → 触发 pool.end() 且后续重新可创建新实例', async () => {
    const endSpy = vi.fn(() => Promise.resolve());
    const fake: MysqlStoragePool = {
      query: () => Promise.resolve([[], undefined]),
      execute: () => Promise.resolve([{ affectedRows: 0 }, undefined]),
      end: endSpy,
    };
    setMysqlStoragePoolForTest(fake);
    expect(getOrCreateMysqlStoragePool({ DATABASE_URL: 'x' })).toBe(fake);

    await closeMysqlStoragePool();
    expect(endSpy).toHaveBeenCalledTimes(1);

    // 关闭后单例已清空 —— 再次注入新 fake 应生效
    const fake2: MysqlStoragePool = {
      query: () => Promise.resolve([[], undefined]),
      execute: () => Promise.resolve([{ affectedRows: 0 }, undefined]),
      end: () => Promise.resolve(),
    };
    setMysqlStoragePoolForTest(fake2);
    expect(getOrCreateMysqlStoragePool({ DATABASE_URL: 'x' })).toBe(fake2);
  });

  it('pool.end() 抛错时 closeMysqlStoragePool 不再向外抛（不阻断 SIGTERM）', async () => {
    const fake: MysqlStoragePool = {
      query: () => Promise.resolve([[], undefined]),
      execute: () => Promise.resolve([{ affectedRows: 0 }, undefined]),
      end: () => Promise.reject(new Error('pool gone')),
    };
    setMysqlStoragePoolForTest(fake);
    await expect(closeMysqlStoragePool()).resolves.toBeUndefined();
  });

  it('多次 closeMysqlStoragePool 幂等（第二次为 NOOP）', async () => {
    const endSpy = vi.fn(() => Promise.resolve());
    const fake: MysqlStoragePool = {
      query: () => Promise.resolve([[], undefined]),
      execute: () => Promise.resolve([{ affectedRows: 0 }, undefined]),
      end: endSpy,
    };
    setMysqlStoragePoolForTest(fake);
    await closeMysqlStoragePool();
    await closeMysqlStoragePool();
    expect(endSpy).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(!sqlMysqlAvailable)('切片 07 — sql.ts 真实 mysql2 Pool 创建 + wrap 路径', () => {
  it('getOrCreateMysqlStoragePool 走 mysql.createPool；query/execute/end 转发可用', async () => {
    // 确保从 0 起：清掉已有单例（避免被前面用例的 fake 残留影响）
    resetMysqlStoragePoolForTest();
    const pool = getOrCreateMysqlStoragePool({ DATABASE_URL: TEST_URL as string });
    try {
      // 1) query 转发：SELECT 1 返回一行
      const [rows] = await pool.query<{ ok: number }>(`SELECT 1 AS ok`);
      expect(rows.length).toBe(1);
      expect(rows[0]?.ok).toBe(1);

      // 2) execute 转发：CREATE TEMPORARY TABLE + INSERT 验证 affectedRows 回路
      await pool.execute(`CREATE TEMPORARY TABLE _tbl_sql_smoke (id INT)`);
      const [insRes] = await pool.execute(`INSERT INTO _tbl_sql_smoke (id) VALUES (?), (?)`, [
        1, 2,
      ]);
      expect(insRes.affectedRows).toBe(2);
    } finally {
      // 3) end 转发：closeMysqlStoragePool 间接触发 pool.end()
      await closeMysqlStoragePool();
    }
  });

  it('transaction 使用同一连接 BEGIN/COMMIT 包住回调', async () => {
    resetMysqlStoragePoolForTest();
    const pool = getOrCreateMysqlStoragePool({ DATABASE_URL: TEST_URL as string });
    try {
      if (typeof pool.transaction !== 'function') {
        throw new Error('pool.transaction must be registered');
      }
      const result = await pool.transaction(async (tx) => {
        await tx.execute(`CREATE TEMPORARY TABLE _tbl_sql_tx (id INT)`, []);
        const [inserted] = await tx.execute(`INSERT INTO _tbl_sql_tx (id) VALUES (?)`, [7]);
        const [rows] = await tx.query<{ id: number }>(
          `SELECT id FROM _tbl_sql_tx WHERE id = ?`,
          [7],
        );
        return { inserted: inserted.affectedRows, id: rows[0]?.id };
      });
      expect(result).toEqual({ inserted: 1, id: 7 });
    } finally {
      await closeMysqlStoragePool();
    }
  });

  it('transaction 回调抛错时 ROLLBACK，不提交写入', async () => {
    resetMysqlStoragePoolForTest();
    const pool = getOrCreateMysqlStoragePool({ DATABASE_URL: TEST_URL as string });
    try {
      await pool.execute(`CREATE TABLE _tbl_sql_tx_rollback (id INT PRIMARY KEY)`);
      await expect(
        pool.transaction!(async (tx) => {
          await tx.execute(`INSERT INTO _tbl_sql_tx_rollback (id) VALUES (?)`, [9]);
          throw new Error('rollback-me');
        }),
      ).rejects.toThrow(/rollback-me/);
      const [rows] = await pool.query<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM _tbl_sql_tx_rollback WHERE id = ?`,
        [9],
      );
      expect(Number(rows[0]?.cnt ?? 0)).toBe(0);
    } finally {
      await pool.execute(`DROP TABLE IF EXISTS _tbl_sql_tx_rollback`).catch(() => undefined);
      await closeMysqlStoragePool();
    }
  });

  it('再次 getOrCreateMysqlStoragePool 重新创建（前次已 close）+ 自定义 pool 容量', async () => {
    resetMysqlStoragePoolForTest();
    const pool = getOrCreateMysqlStoragePool({
      DATABASE_URL: TEST_URL as string,
      DB_POOL_MAX: 3,
      DB_QUEUE_LIMIT: 10,
    });
    try {
      const [rows] = await pool.query<{ ok: number }>(`SELECT 1 AS ok`);
      expect(rows[0]?.ok).toBe(1);
    } finally {
      await closeMysqlStoragePool();
    }
  });
});

afterAll(async () => {
  if (!sqlMysqlAvailable) return;
  // afterAll 兜底：DROP 临时 schema，避免重跑残留
  const mysql = await import('mysql2/promise');
  const c = await mysql.default.createConnection({ uri: BASE_URL });
  try {
    await c.query(`DROP DATABASE IF EXISTS \`${TEST_SCHEMA}\``);
  } finally {
    await c.end().catch(() => undefined);
  }
}, 15_000);
