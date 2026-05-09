#!/usr/bin/env node
/**
 * 切片 09 — api-key-issuer CLI（T-BRIDGE-01 §5.3 / 任务卡 §8.4）
 *
 * 用法：
 *   pnpm issue:apikey -- --merchantId M001 --storeId S001 --userId boss-001 [--ttlDays 90]
 *
 * 行为（任务卡 §6 MUST DO + §7 MUST NOT）：
 *   1. crypto.randomBytes(32).toString('base64url') 生成 raw → `${prefix}${raw}` 明文。
 *   2. argon2id hash + `secret = AGENT_API_KEY_HASH_SALT`（server pepper） → DB 仅存 hash。
 *   3. INSERT agent_api_key 行（status='ENABLED'，默认 expires_at = NOW(3) + 90 天）。
 *   4. **明文仅 console.log 一次**（不入库 / 不入日志 / 不入 RunLog；切片 01 redact 守门）。
 *   5. 验证：参数缺失 → 退出码 2 + usage；DB 错误 → 退出码 1 + 错误文本（不含明文）。
 *
 * 安全约束（任务卡 §7 MUST NOT）：
 *   - 不得在错误响应或日志中回显完整 API Key（仅 apiKeyPrefix 前 16 字符）。
 *   - 不得使用 bcrypt / sha256（必须 argon2id）。
 *   - 不得跳过 argon2 hash 直接存明文。
 *
 * 与 packages/agent-service/src/bridge/auth.ts 共享 hash 参数（type=argon2id + secret pepper），
 * 保证 CLI 颁发的 key 能被 authenticate() 在生产环境 verify 命中。
 */
/* eslint-disable no-console */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import argon2 from 'argon2';
import 'dotenv/config';
import mysql, { type Connection } from 'mysql2/promise';
import { z } from 'zod';

const DEFAULT_TTL_DAYS = 90;

export interface CliArgs {
  merchantId: string;
  storeId: string | null;
  userId: string;
  ttlDays: number;
}

export interface IssueEnv {
  databaseUrl: string;
  salt: string;
  prefix: string;
}

export interface IssueResult {
  plaintext: string;
  prefix: string;
  args: CliArgs;
}

export class IssueCliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = 'IssueCliError';
  }
}

const ArgsSchema = z.object({
  merchantId: z.string().min(1),
  storeId: z.string().min(1).nullable(),
  userId: z.string().min(1),
  ttlDays: z.coerce.number().int().min(1).max(365),
});

/**
 * 解析 CLI 参数 —— 严格按任务卡 §8.4 约定的 --merchantId / --storeId / --userId 三参数。
 *
 * 不依赖任何 CLI 框架（commander / yargs），保持 tools 包零业务依赖；
 * 兼容 `--key value` 与 `--key=value` 两种语法。
 */
export function parseIssueArgs(argv: ReadonlyArray<string>): CliArgs {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (typeof token !== 'string' || !token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq > 0) {
      map.set(token.slice(2, eq), token.slice(eq + 1));
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (typeof next === 'string' && !next.startsWith('--')) {
      map.set(key, next);
      i++;
    } else {
      map.set(key, '');
    }
  }
  const parsed = ArgsSchema.safeParse({
    merchantId: map.get('merchantId') ?? '',
    storeId: map.has('storeId') && (map.get('storeId') ?? '') !== '' ? map.get('storeId') : null,
    userId: map.get('userId') ?? '',
    ttlDays: map.get('ttlDays') ?? DEFAULT_TTL_DAYS,
  });
  if (!parsed.success) {
    throw new IssueCliError(
      `[api-key-issuer] 参数错误：${JSON.stringify(parsed.error.flatten())}\n${usage()}`,
      2,
    );
  }
  return parsed.data;
}

/**
 * env 兜底：CLI 单独跑时不依赖 agent-service 的 getEnv()，避免引入 23 字段全集校验；
 * 仅校验 issue 必需的 3 个 env（DATABASE_URL / AGENT_API_KEY_HASH_SALT / AGENT_API_KEY_PREFIX）。
 */
export function readIssueEnv(env: NodeJS.ProcessEnv = process.env): IssueEnv {
  const databaseUrl = env['DATABASE_URL'];
  if (!databaseUrl || !/^mysql:\/\//.test(databaseUrl)) {
    throw new IssueCliError(
      '[api-key-issuer] DATABASE_URL 必须以 mysql:// 开头（见切片 01 .env.example）',
      1,
    );
  }
  const salt = env['AGENT_API_KEY_HASH_SALT'];
  if (!salt || salt.length < 16) {
    throw new IssueCliError(
      '[api-key-issuer] AGENT_API_KEY_HASH_SALT 必须 ≥ 16 字符（server pepper）',
      1,
    );
  }
  const prefix = env['AGENT_API_KEY_PREFIX'] ?? 'sk-agent-';
  if (prefix !== 'sk-agent-') {
    throw new IssueCliError('[api-key-issuer] AGENT_API_KEY_PREFIX 必须固定为 "sk-agent-"', 1);
  }
  return { databaseUrl, salt, prefix };
}

/**
 * 生成明文 API Key + 前 16 字符 prefix。
 *
 * 算法：`${prefix}${crypto.randomBytes(32).toString('base64url')}`
 *
 * - randomBytes(32) → 32 字节熵；base64url 编码后 ≈ 43 字符；
 * - 拼上 9 字符 `sk-agent-` → 总长 ≈ 52 字符；
 * - prefix = plaintext.slice(0, 16) → `sk-agent-` + 7 字符 base64url（≈ 64^7 = 4.4×10^12 空间，
 *   1000 把 key 几乎不可能 prefix 冲突，保证候选检索 ≤ 1 行）。
 */
export function generateAgentApiKey(prefix: string): { plaintext: string; prefix: string } {
  const raw = randomBytes(32).toString('base64url');
  const plaintext = `${prefix}${raw}`;
  return { plaintext, prefix: plaintext.slice(0, 16) };
}

/**
 * 写入 agent_api_key（任务卡 §8.4 + §6 MUST DO §5）。
 *
 * 注：dateStrings=true 不影响 INSERT 行为；NOW(3) + INTERVAL N DAY 由 MySQL 服务端计算。
 */
async function insertRow(
  conn: Connection,
  args: {
    hash: string;
    prefix: string;
    merchantId: string;
    storeId: string | null;
    userId: string;
    ttlDays: number;
  },
): Promise<void> {
  await conn.execute(
    `INSERT INTO agent_api_key
       (api_key_hash, api_key_prefix, merchant_id, store_id, user_id, status, expires_at)
     VALUES (?, ?, ?, ?, ?, 'ENABLED', NOW(3) + INTERVAL ? DAY)`,
    [args.hash, args.prefix, args.merchantId, args.storeId, args.userId, args.ttlDays],
  );
}

type IssueConnection = Pick<Connection, 'execute' | 'end'>;

interface IssueAgentApiKeyDeps {
  args: CliArgs;
  env: IssueEnv;
  createConnection?: (options: { uri: string }) => Promise<IssueConnection>;
  generateKey?: (prefix: string) => { plaintext: string; prefix: string };
}

export async function issueAgentApiKey({
  args,
  env,
  createConnection = (options) => mysql.createConnection(options),
  generateKey = generateAgentApiKey,
}: IssueAgentApiKeyDeps): Promise<IssueResult> {
  const { plaintext, prefix } = generateKey(env.prefix);
  const hash = await argon2.hash(plaintext, {
    type: argon2.argon2id,
    secret: Buffer.from(env.salt),
  });

  const conn = await createConnection({ uri: env.databaseUrl });
  try {
    await insertRow(conn as Connection, {
      hash,
      prefix,
      merchantId: args.merchantId,
      storeId: args.storeId,
      userId: args.userId,
      ttlDays: args.ttlDays,
    });
  } finally {
    await conn.end();
  }

  return { plaintext, prefix, args };
}

/**
 * 主流程（fail-fast；任意步骤抛错 → process.exit(1)）。
 */
async function main(): Promise<void> {
  const args = parseIssueArgs(process.argv.slice(2));
  const env = readIssueEnv();
  const result = await issueAgentApiKey({ args, env });

  // 任务卡 §6 MUST DO §5：明文只在颁发时打印一次（不入库 / 不入日志 / 不入 RunLog）
  console.log('[api-key-issuer] 颁发成功');
  console.log(
    `  merchantId=${args.merchantId}  storeId=${args.storeId ?? '(null)'}  userId=${args.userId}`,
  );
  console.log(`  apiKeyPrefix=${result.prefix}  ttlDays=${args.ttlDays}`);
  console.log('  明文 sk（仅此一次，请立即保存）：');
  console.log(`  ${result.plaintext}`);
}

function usage(): string {
  return 'Usage: pnpm issue:apikey -- --merchantId <id> [--storeId <id>] --userId <id> [--ttlDays 90]';
}

function isDirectRun(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
}

if (isDirectRun()) {
  main().catch((err: unknown) => {
    if (err instanceof IssueCliError) {
      console.error(err.message);
      process.exit(err.exitCode);
    }

    // 仅打印 message + name，避免 stack 中混入 secret（极端情况下 mysql2 错误可能含 URL）
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error('[api-key-issuer] 失败：', msg);
    process.exit(1);
  });
}
