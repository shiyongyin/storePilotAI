#!/usr/bin/env node
/**
 * 切片 03 — MySQL 迁移执行器(umzug + mysql2)
 *
 * 用法:
 *   pnpm migrate:up                  # 顺序执行所有 pending migration
 *   pnpm migrate:down --dry-run      # 输出回滚 SQL,不真删表(线上禁 down)
 *
 * 强约束:
 *   - 生产环境(NODE_ENV=production)拒绝执行 down(只允许 dry-run)
 *   - 用 _agent_migrations 元数据表跟踪已执行 migration
 *   - 所有 SQL 用 IF NOT EXISTS 包裹 → 多次 up 可重入
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import 'dotenv/config';
import mysql, { type Connection } from 'mysql2/promise';
import { Umzug } from 'umzug';

import { buildRollbackSql } from './rollback-plan.js';

/* eslint-disable no-console */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 解析仓库根的 migrations/ 目录(本工具在 tools/migrate-runner/{src,dist}/ 下)
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../migrations');
const META_TABLE = '_agent_migrations';

interface Args {
  command: 'up' | 'down';
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const command = argv[2];
  if (command !== 'up' && command !== 'down') {
    console.error('Usage: migrate <up|down> [--dry-run]');
    process.exit(2);
  }
  const dryRun = argv.includes('--dry-run');
  return { command, dryRun };
}

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[migrate] DATABASE_URL 未设置');
    process.exit(1);
  }
  if (!/^mysql:\/\//.test(url)) {
    console.error('[migrate] DATABASE_URL 必须以 mysql:// 开头,实际:', url.slice(0, 16));
    process.exit(1);
  }
  return url;
}

async function ensureMetaTable(conn: Connection): Promise<void> {
  await conn.query(
    `CREATE TABLE IF NOT EXISTS \`${META_TABLE}\` (
      name VARCHAR(255) PRIMARY KEY,
      executed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT='切片 03 migrate-runner 元数据表'`,
  );
}

interface MigrationFile {
  name: string;
  path: string;
  sql: string;
}

function loadMigrations(): MigrationFile[] {
  if (!existsSync(MIGRATIONS_DIR)) {
    console.error('[migrate] migrations 目录不存在:', MIGRATIONS_DIR);
    process.exit(1);
  }
  const names = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}-.+\.sql$/.test(f))
    .sort((a, b) => a.localeCompare(b));
  return names.map((name) => {
    const p = path.join(MIGRATIONS_DIR, name);
    const sql = readFileSync(p, 'utf-8');
    return { name, path: p, sql };
  });
}

/**
 * 整体执行 SQL 文件(连接以 multipleStatements=true 创建,允许多语句一起 query)。
 * 注:这要求 main() 在 createConnection 时显式开启 multipleStatements。
 * 比拆分 ; 更稳:不会因"注释行+DDL"混排而漏执行。
 */
async function execSqlFile(conn: Connection, sql: string): Promise<void> {
  await conn.query(sql);
}

function buildUmzug(conn: Connection): Umzug<Connection> {
  const files = loadMigrations();
  return new Umzug({
    migrations: files.map((f) => ({
      name: f.name,
      up: async () => {
        console.log(`[migrate] up   ${f.name}`);
        await execSqlFile(conn, f.sql);
      },
      down: () => {
        // V1 非 dry-run 仍只清理元数据,防止开发误删业务表;dry-run 会输出可审阅 SQL。
        console.log(`[migrate] down ${f.name} (仅清理 _agent_migrations;DDL 回滚请先审阅 --dry-run SQL)`);
        return Promise.resolve();
      },
    })),
    context: conn,
    storage: {
      async logMigration({ name }): Promise<void> {
        await conn.query(
          `INSERT INTO \`${META_TABLE}\` (name) VALUES (?) ON DUPLICATE KEY UPDATE executed_at = CURRENT_TIMESTAMP(3)`,
          [name],
        );
      },
      async unlogMigration({ name }): Promise<void> {
        await conn.query(`DELETE FROM \`${META_TABLE}\` WHERE name = ?`, [name]);
      },
      async executed(): Promise<string[]> {
        const [rows] = await conn.query<mysql.RowDataPacket[]>(
          `SELECT name FROM \`${META_TABLE}\` ORDER BY name ASC`,
        );
        return rows.map((r) => r.name as string);
      },
    },
    logger: undefined,
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const url = getDatabaseUrl();

  // 生产 down 守门(MUST NOT §4 / §6:线上禁 down)
  if (args.command === 'down' && process.env.NODE_ENV === 'production' && !args.dryRun) {
    console.error('[migrate] 生产环境拒绝执行 down(只允许 --dry-run)');
    process.exit(1);
  }

  // multipleStatements=true 让 .sql 文件可以整体 query(允许文件内多个 ; 分隔的语句一起执行)
  const conn = await mysql.createConnection({ uri: url, multipleStatements: true });
  try {
    await ensureMetaTable(conn);
    const umzug = buildUmzug(conn);

    if (args.command === 'up') {
      const migrated = await umzug.up();
      console.log(
        `[migrate] up 完成,本次执行 ${migrated.length} 个 migration:`,
        migrated.map((m) => m.name).join(', ') || '(全部已是最新)',
      );
    } else {
      const executed = await umzug.executed();
      if (!args.dryRun) {
        // 非 dry-run 时(开发环境)真跑 down(逐个 unlog,不删表)
        await umzug.down({ to: 0 });
        console.log('[migrate] down 完成(_agent_migrations 元数据表已清);DDL 表本身需人工 DROP');
      } else {
        console.log('[migrate] down --dry-run(输出可审阅 SQL,不真删表):');
        console.log(buildRollbackSql(executed.map((m) => m.name)));
        console.log('[migrate] dry-run 模式,未做任何修改');
      }
    }
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('[migrate] 失败:', err);
  process.exit(1);
});
