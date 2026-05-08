#!/usr/bin/env node
/**
 * 切片 21 — seed-strategy CLI（T-OPS-02 §6 / §8.7）
 *
 * 用法：
 *   pnpm --filter @storepilot/tools-seed-strategy run start -- --file <strategy.json>
 *   # 或多个商家：
 *   pnpm --filter @storepilot/tools-seed-strategy run start -- --file <multi.json>
 *
 * 输入 JSON 单条形态（任务卡 §8.7 / runbook 06 §2.2.2）：
 *
 * {
 *   "merchantId":  "M042",
 *   "storeId":     null,                 // 可选；若提供则写 agent_store_strategy
 *   "version":     "merchant-M042-v1.0.0",
 *   "status":      "enabled",            // enabled | disabled（默认 enabled）
 *   "strategyJson": { ... StrategySchema ... }
 * }
 *
 * 也支持数组形态：`[ {...}, {...} ]`（一次种入多个）。
 *
 * 强约束（任务卡 §7 MUST DO §6 / MUST NOT §3）：
 *   1. 输入 strategyJson 必须通过 `@storepilot/shared-contracts` 的 `StrategySchema`
 *      校验（避免误写一份不可用的 JSON 落库）。
 *   2. INSERT 而非 UPDATE：依赖 `(merchant_id, version)` UNIQUE 索引（migration 001）
 *      触发 `ER_DUP_ENTRY` → 改用 `ON DUPLICATE KEY UPDATE strategy_json/status`，
 *      让运维侧"重新种 v1.0.0"成为幂等动作；新版本则用新 version 字符串。
 *   3. 不在错误日志中打印明文 strategyJson（可能包含商户敏感配置）；只打印
 *      `merchantId / storeId / version / status / fields=N`。
 *   4. fail-fast：任一步骤抛错 → `process.exit(1)`。
 *
 * 不属本切片：
 *   - 真实 ERP 接入 / 三层合并 / LRU 失效（属切片 11 / 21 strategy 回滚 SQL）；
 *   - 颁发 API Key（属 `tools/api-key-issuer`）。
 */
/* eslint-disable no-console */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import 'dotenv/config';
import mysql, { type Connection } from 'mysql2/promise';

import { StrategySchema } from '@storepilot/shared-contracts';

const STATUS_VALUES = ['enabled', 'disabled'] as const;
type StatusLiteral = (typeof STATUS_VALUES)[number];

interface SeedRow {
  merchantId: string;
  storeId: string | null;
  version: string;
  status: StatusLiteral;
  strategyJson: Record<string, unknown>;
}

interface CliArgs {
  file: string;
  dryRun: boolean;
}

/**
 * 解析 CLI 参数 —— 只支持 `--file <path>` 与 `--dry-run`。
 *
 * 不引入 commander/yargs，保持工具包零额外依赖（同 `tools/api-key-issuer` 风格）。
 */
function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const args: { file?: string; dryRun: boolean } = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (typeof token !== 'string') continue;
    if (token === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (token === '--file' || token.startsWith('--file=')) {
      const eq = token.indexOf('=');
      if (eq > 0) {
        args.file = token.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (typeof next === 'string' && !next.startsWith('--')) {
          args.file = next;
          i++;
        }
      }
    }
  }
  if (!args.file) {
    console.error('[seed-strategy] 缺少必填参数 --file');
    console.error(
      'Usage: pnpm --filter @storepilot/tools-seed-strategy run start -- --file <strategy.json> [--dry-run]',
    );
    process.exit(2);
  }
  return { file: args.file, dryRun: args.dryRun };
}

/**
 * env 兜底 —— CLI 单跑时不依赖 agent-service 全集 env，仅校验 DATABASE_URL。
 */
function readDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (!url || !/^mysql:\/\//.test(url)) {
    console.error('[seed-strategy] DATABASE_URL 必须以 mysql:// 开头');
    process.exit(1);
  }
  return url;
}

/**
 * 把 JSON 文件解析成 N 条 SeedRow；同时用 `StrategySchema` 把 strategyJson 跑一遍
 * zod parse —— 不通过即拒绝种入（任务卡 §6 MUST DO §1）。
 */
export function loadSeedRows(filePath: string): SeedRow[] {
  const abs = path.resolve(process.cwd(), filePath);
  const raw = readFileSync(abs, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : [parsed];

  return list.map((item, idx) => normalizeRow(item, idx));
}

function normalizeRow(input: unknown, idx: number): SeedRow {
  if (!input || typeof input !== 'object') {
    throw new Error(`[seed-strategy] 第 ${idx} 行不是对象`);
  }
  const r = input as Record<string, unknown>;

  const merchantId = expectString(r['merchantId'], `[${idx}].merchantId`);
  const storeIdRaw = r['storeId'];
  const storeId =
    typeof storeIdRaw === 'string' && storeIdRaw.length > 0 ? storeIdRaw : null;
  const version = expectString(r['version'], `[${idx}].version`);
  const statusRaw = (r['status'] as string | undefined) ?? 'enabled';
  if (!STATUS_VALUES.includes(statusRaw as StatusLiteral)) {
    throw new Error(
      `[seed-strategy] [${idx}].status 非法（必须是 ${STATUS_VALUES.join('|')}），实际：${statusRaw}`,
    );
  }
  const strategyJsonRaw = r['strategyJson'];
  if (!strategyJsonRaw || typeof strategyJsonRaw !== 'object') {
    throw new Error(`[seed-strategy] [${idx}].strategyJson 必须是对象`);
  }

  const validated = StrategySchema.safeParse(strategyJsonRaw);
  if (!validated.success) {
    const flat = validated.error.flatten();
    throw new Error(
      `[seed-strategy] [${idx}].strategyJson 不符合 StrategySchema：${JSON.stringify(flat)}`,
    );
  }

  return {
    merchantId,
    storeId,
    version,
    status: statusRaw as StatusLiteral,
    strategyJson: validated.data as unknown as Record<string, unknown>,
  };
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`[seed-strategy] ${label} 必须是非空字符串`);
  }
  return value;
}

/**
 * 写一行到 agent_merchant_strategy（storeId 为 null 时）或 agent_store_strategy。
 *
 * 用 `ON DUPLICATE KEY UPDATE strategy_json/status` 让"重新种同 version"成为幂等
 * 动作；新版本应使用新 version 字符串（任务卡 §7 MUST NOT §3 —— 不直接覆盖历史的
 * 抽象由"换 version + 旧版 disabled"实现，本 CLI 只负责写入一行）。
 */
export async function insertOne(conn: Connection, row: SeedRow): Promise<void> {
  const json = JSON.stringify(row.strategyJson);
  if (row.storeId === null) {
    await conn.execute(
      `INSERT INTO agent_merchant_strategy (merchant_id, strategy_json, version, status)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         strategy_json = VALUES(strategy_json),
         status        = VALUES(status),
         updated_at    = CURRENT_TIMESTAMP(3)`,
      [row.merchantId, json, row.version, row.status],
    );
  } else {
    await conn.execute(
      `INSERT INTO agent_store_strategy (merchant_id, store_id, strategy_json, version, status)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         strategy_json = VALUES(strategy_json),
         status        = VALUES(status),
         updated_at    = CURRENT_TIMESTAMP(3)`,
      [row.merchantId, row.storeId, json, row.version, row.status],
    );
  }
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const rows = loadSeedRows(cli.file);
  console.log(`[seed-strategy] 解析 ${rows.length} 行成功（已通过 StrategySchema）`);

  if (cli.dryRun) {
    for (const r of rows) {
      console.log(
        `[seed-strategy] [dry-run] would insert merchantId=${r.merchantId} ` +
          `storeId=${r.storeId ?? '(null)'} version=${r.version} status=${r.status} ` +
          `fields=${Object.keys(r.strategyJson).length}`,
      );
    }
    console.log('[seed-strategy] dry-run done; no DB writes');
    return;
  }

  const databaseUrl = readDatabaseUrl();
  const conn = await mysql.createConnection({ uri: databaseUrl });
  try {
    for (const r of rows) {
      await insertOne(conn, r);
      console.log(
        `[seed-strategy] inserted merchantId=${r.merchantId} ` +
          `storeId=${r.storeId ?? '(null)'} version=${r.version} status=${r.status}`,
      );
    }
  } finally {
    await conn.end();
  }
  console.log(`[seed-strategy] OK; ${rows.length} row(s) committed.`);
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isDirectRun || process.env['SEED_STRATEGY_RUN'] === '1') {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error('[seed-strategy] 失败：', msg);
    process.exit(1);
  });
}
