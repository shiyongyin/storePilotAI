/**
 * 切片 19 — E2E 颁发 API Key（真实 argon2id + agent_api_key 表）
 *
 * 与 tools/api-key-issuer/src/issue.ts 行为 1:1：
 *   - randomBytes(32).base64url 生成明文 → `${prefix}${raw}`；
 *   - argon2id + secret = AGENT_API_KEY_HASH_SALT；
 *   - INSERT agent_api_key（status='ENABLED'）。
 *
 * E2E 用法：
 *   ```ts
 *   const { apiKey, prefix } = await issueE2eApiKey(pool, {
 *     merchantId: 'M_E2E_T03', storeId: 'S_E2E_T03', userId: 'boss-e2e',
 *   });
 *   ```
 *
 * @since 切片 19
 */
import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { Pool } from 'mysql2/promise';

import { E2E_BASE_ENV } from './env.js';

/** 唯一标识颁发结果 */
export interface IssuedApiKey {
  apiKey: string;
  prefix: string;
  merchantId: string;
  storeId: string | null;
  userId: string;
}

/** 颁发参数；status 不可选（统一 ENABLED；T-02 用 disable / disable / expire 分支由 SQL 自定） */
export interface IssueArgs {
  merchantId: string;
  storeId: string | null;
  userId: string;
  /** 默认 90 天；T-02 过期分支可传 -1 触发已过期 */
  ttlDays?: number;
  /** 默认 ENABLED；T-02 禁用分支可传 'DISABLED' */
  status?: 'ENABLED' | 'DISABLED' | 'REVOKED';
}

/**
 * 颁发一把测试 API Key 并写入 agent_api_key。
 *
 * @returns 明文 sk-agent-... + 前 16 字符 prefix（与生产形态完全一致）
 */
export async function issueE2eApiKey(pool: Pool, args: IssueArgs): Promise<IssuedApiKey> {
  const prefixCfg = E2E_BASE_ENV['AGENT_API_KEY_PREFIX'] ?? 'sk-agent-';
  const salt = E2E_BASE_ENV['AGENT_API_KEY_HASH_SALT']!;
  const ttlDays = args.ttlDays ?? 90;
  const status = args.status ?? 'ENABLED';

  const raw = randomBytes(32).toString('base64url');
  const apiKey = `${prefixCfg}${raw}`;
  const prefix = apiKey.slice(0, 16);
  const hash = await argon2.hash(apiKey, {
    type: argon2.argon2id,
    secret: Buffer.from(salt),
  });

  await pool.execute(
    `INSERT INTO agent_api_key
       (api_key_hash, api_key_prefix, merchant_id, store_id, user_id, status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW(3) + INTERVAL ? DAY)`,
    [hash, prefix, args.merchantId, args.storeId, args.userId, status, ttlDays],
  );

  return {
    apiKey,
    prefix,
    merchantId: args.merchantId,
    storeId: args.storeId,
    userId: args.userId,
  };
}
