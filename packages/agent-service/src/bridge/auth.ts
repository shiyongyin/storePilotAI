/**
 * 切片 09 — API Key 鉴权（argon2id + prefix 候选检索 + last_used_at 节流，T-BRIDGE-01）
 *
 * 严格按 docs/tanks/09-bridge-auth-session.md §8.1 + 任务卡 C-桥接层.md §T-BRIDGE-01 落地。
 *
 * 流程（任务卡 §8.1）：
 *   1. 解析 `Authorization: Bearer <apiKey>`；缺/不匹配 → `missing_authorization`。
 *   2. `apiKey.startsWith(env.AGENT_API_KEY_PREFIX)` 否则 `invalid_prefix`。
 *   3. 取 `apiKey.slice(0, 16)` 作为 `apiKeyPrefix` 候选检索（命中 idx_api_key_prefix_status）。
 *   4. 遍历候选：`expires_at < NOW()` skip → `argon2.verify(secret = AGENT_API_KEY_HASH_SALT)` → 命中即返回。
 *   5. `touchLastUsedAt(id)` 节流 SQL：`(last_used_at IS NULL OR last_used_at < NOW(3) - INTERVAL 1 MINUTE)`。
 *
 * 强约束（违反即拒收 / 任务卡 §7）：
 *   - argon2id + `secret: Buffer.from(env.AGENT_API_KEY_HASH_SALT)`（server pepper）。
 *   - 必须 prefix 候选检索（≤ 5 行），禁全表 verify（P95 < 200ms / 1000 把 key）。
 *   - 节流 SQL 用 `<` 不是 `>`（写反会让每次都 UPDATE → DB 写爆）。
 *   - 5 类异常（missing_authorization / invalid_prefix / 过期 / disabled / hash_mismatch）外部统一
 *     `401 + UNAUTHORIZED + "无效的 API Key"`，不暴露具体原因（由调用方桥接路由完成）。
 *   - `expires_at < NOW()` `continue` skip 该候选行（不 throw）。
 *   - 错误响应 / 日志中不得回显完整 API Key（仅 apiKeyPrefix 前 16 字符）。
 *
 * 设计决策（DI 注入 Pool，与 draft-manager 同模式）：
 *   切片 09 在 server bootstrap 完成 mysql2 storagePool 创建后立即调用 {@link setAuthPool}；
 *   测试在 beforeEach 注入 fake pool，afterEach 调 {@link resetAuthPoolForTest} 清理。
 *   生产路径不允许直接拿 pool 绕过 authenticate（不暴露 query/execute 二级 API）。
 *
 * 引用：
 *   - 任务卡 docs/tanks/09-bridge-auth-session.md §6-§9
 *   - C-桥接层.md §T-BRIDGE-01.5
 *   - migrations/004-init-api-key.sql（agent_api_key + idx_api_key_prefix_status）
 *   - shared-contracts/errors（UNAUTHORIZED；调用方在 chat-completions 路由统一返回）
 */
import argon2 from 'argon2';
import { BizError } from '@storepilot/shared-contracts';

import { getEnv } from '../config/env.js';
import { logger } from '../observability/logger.js';

/* ============================================================================
 * 1) 常量
 * ========================================================================== */

/** API Key 前缀长度（任务卡 §6 MUST DO §2：候选检索用前 16 字符） */
export const API_KEY_PREFIX_LENGTH = 16;

/** Bearer 头解析正则（保留 Bearer 后的全部内容，再 .trim()） */
const BEARER_RE = /^Bearer\s+(.+)$/;

/* ============================================================================
 * 2) 公开类型
 * ========================================================================== */

/**
 * `agent_api_key` 表行投影（authenticate 仅消费这些字段）。
 *
 * 与 migrations/004-init-api-key.sql 列名 1:1 对齐；
 * `expires_at` 在 mysql2 + dateStrings=true 下为字符串，未配置时为 Date —— 兼容两种形态。
 */
export interface ApiKeyRow extends Record<string, unknown> {
  id: number;
  api_key_hash: string;
  api_key_prefix: string;
  merchant_id: string;
  store_id: string | null;
  user_id: string;
  status: string;
  expires_at: Date | string | null;
}

/**
 * 鉴权失败的内部原因码 —— 仅供日志 / 单测使用，不得直接回显给客户端。
 *
 * 5 类异常映射（任务卡 §10）：
 *   - `missing_authorization`：缺 Authorization 头 / 不匹配 Bearer 正则
 *   - `invalid_prefix`：apiKey 不以 env.AGENT_API_KEY_PREFIX 开头
 *   - `no_match`：prefix 候选为空 / 全部过期 / 全部 hash 不匹配（disabled 通过 prefix WHERE 已过滤）
 */
export type AuthFailReason = 'missing_authorization' | 'invalid_prefix' | 'no_match';

/**
 * authenticate 返回值 —— 命中时携带派生租户身份；未命中时仅含原因码（仅日志用，不外抛）。
 */
export type AuthResult =
  | { ok: false; reason: AuthFailReason }
  | {
      ok: true;
      merchantId: string;
      storeId: string;
      userId: string;
      apiKeyPrefix: string;
    };

/**
 * mysql2 Pool 的最小子集 —— 与 storage/sql.ts MysqlStoragePool / safety/draft-manager DraftPool 同形状，
 * 便于 server bootstrap 注入同一个 mysql2 storagePool 实例（全 workspace 共用一个连接池）。
 */
export interface AuthPool {
  query<T extends Record<string, unknown>>(
    sql: string,
    params: readonly unknown[],
  ): Promise<[T[], unknown]>;
  execute(
    sql: string,
    params: readonly unknown[],
  ): Promise<[{ affectedRows: number }, unknown]>;
}

/* ============================================================================
 * 3) Pool DI（与 draft-manager 同模式）
 * ========================================================================== */

let registeredPool: AuthPool | null = null;

/**
 * 注入全局 AuthPool 实例。
 *
 * - 生产：由切片 09 在 server bootstrap 完成 mysql2 storagePool 创建后调用一次。
 * - 测试：每个 beforeEach 注入 fake pool；afterEach 调用 {@link resetAuthPoolForTest} 清理。
 */
export function setAuthPool(pool: AuthPool): void {
  registeredPool = pool;
}

/**
 * 测试辅助：清空已注册的 pool，避免用例间相互污染。
 */
export function resetAuthPoolForTest(): void {
  registeredPool = null;
}

/**
 * 取注册的 pool。未注册抛错，防止生产忘记 bootstrap。
 */
function getAuthPool(): AuthPool {
  if (!registeredPool) {
    throw new BizError('INTERNAL_ERROR', 'AuthPool 未注入；请在 bootstrap 期调用 setAuthPool(pool)。');
  }
  return registeredPool;
}

/* ============================================================================
 * 4) authenticate（核心）
 * ========================================================================== */

/**
 * 鉴权 + 派生租户身份（任务卡 §T-BRIDGE-01 §5.1 / §8.1）。
 *
 * @param authHeader 原始 `Authorization` header 值；undefined / 不匹配 Bearer → `missing_authorization`。
 * @returns {@link AuthResult}；`ok: false` 时调用方统一回 `401 + UNAUTHORIZED + "无效的 API Key"`。
 *
 * @throws BizError 仅在 AuthPool 未注入等基础设施错误时抛出（500 类）；
 *                  argon2 verify 抛错（如 hash 格式损坏）会被吞 + logger.debug 后 `continue` 该候选，
 *                  避免单条脏数据让整个鉴权链路 500。
 */
export async function authenticate(authHeader?: string): Promise<AuthResult> {
  const env = getEnv();
  const apiKey = parseBearer(authHeader);
  if (apiKey === null) return { ok: false, reason: 'missing_authorization' };

  if (!apiKey.startsWith(env.AGENT_API_KEY_PREFIX)) {
    return { ok: false, reason: 'invalid_prefix' };
  }

  const apiKeyPrefix = apiKey.slice(0, API_KEY_PREFIX_LENGTH);
  const pool = getAuthPool();

  // 关键：prefix + status='ENABLED' 候选检索（任务卡 §6 MUST DO §2，命中 idx_api_key_prefix_status）。
  // disabled / revoked 通过 status WHERE 已过滤；剩余候选 ≤ 5 行（按设计指南 §6.5 容量假设）。
  const [candidates] = await pool.query<ApiKeyRow>(
    `SELECT id, api_key_hash, api_key_prefix, merchant_id, store_id, user_id, status, expires_at
     FROM agent_api_key
     WHERE api_key_prefix = ? AND status = 'ENABLED'`,
    [apiKeyPrefix],
  );

  for (const row of candidates) {
    if (isExpired(row.expires_at)) continue; // 任务卡 §6 MUST DO §6：continue 不 throw

    let matched = false;
    try {
      matched = await argon2.verify(row.api_key_hash, apiKey, {
        secret: Buffer.from(env.AGENT_API_KEY_HASH_SALT),
      });
    } catch (err) {
      // 单条候选 hash 格式损坏不阻断整个鉴权（仅 debug 记录，不打印明文）；
      // 调用方仍会拿到 no_match → 401（不暴露具体原因）。
      logger.debug(
        {
          apiKeyPrefix,
          candidateId: row.id,
          err: err instanceof Error ? err.message : String(err),
        },
        '[auth] argon2.verify threw; treat as miss',
      );
      continue;
    }

    if (matched) {
      await touchLastUsedAt(row.id);
      return {
        ok: true,
        merchantId: row.merchant_id,
        storeId: row.store_id ?? '',
        userId: row.user_id,
        apiKeyPrefix,
      };
    }
  }

  return { ok: false, reason: 'no_match' };
}

/* ============================================================================
 * 5) touchLastUsedAt（节流 UPDATE）
 * ========================================================================== */

/**
 * `last_used_at` 节流更新（任务卡 §8.1 / §6 MUST DO §3）。
 *
 * 节流逻辑由 SQL 完成（无应用层计时），多实例横向扩展安全：
 * `WHERE id = ? AND (last_used_at IS NULL OR last_used_at < NOW(3) - INTERVAL 1 MINUTE)`
 *
 * - 同一 key 1 分钟内首次命中 → 1 行 UPDATE。
 * - 同一 key 1 分钟内再次命中 → 0 行 UPDATE（affectedRows=0；不报错）。
 *
 * 任务卡红线（§7 MUST NOT §4）：节流 SQL 必须用 `<`，写成 `>` 会让每次都更新 → DB 写爆。
 *
 * @param id 候选行 PK（仅在 argon2 verify 命中后调用，不会泄漏到日志）。
 */
export async function touchLastUsedAt(id: number): Promise<void> {
  const pool = getAuthPool();
  await pool.execute(
    `UPDATE agent_api_key
     SET last_used_at = NOW(3)
     WHERE id = ? AND (last_used_at IS NULL OR last_used_at < NOW(3) - INTERVAL 1 MINUTE)`,
    [id],
  );
}

/* ============================================================================
 * 6) 内部 helpers
 * ========================================================================== */

/**
 * 解析 `Authorization: Bearer <apiKey>`。
 *
 * - undefined / 空串 / 不匹配 → null。
 * - 匹配后取捕获组并 .trim() → string。
 *
 * 不抛错；调用方靠返回 null 走 `missing_authorization` 分支。
 */
function parseBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = BEARER_RE.exec(authHeader);
  const captured = m ? m[1] : undefined;
  if (captured === undefined) return null;
  const trimmed = captured.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * 过期判断 —— 兼容 mysql2 在 dateStrings=true 时返回字符串、未配置时返回 Date 两种形态。
 *
 * - null / undefined → 未设置过期时间（永久有效），不算过期。
 * - 无效日期（NaN）→ 视为不过期，避免单行脏数据让整批候选被丢弃；切片 20 起会有
 *   迁移守门保证 expires_at 形态正确。
 */
function isExpired(value: Date | string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  const date = value instanceof Date ? value : new Date(value);
  const t = date.getTime();
  if (Number.isNaN(t)) return false;
  return t < Date.now();
}
