/**
 * 切片 19 — T-02 API Key 5 类异常 → 全部 401
 *
 * 严格按 docs/tanks/19-test-e2e-20-cases.md §8.1 §T-02 落地：
 *   1. 缺 Authorization 头 → 401
 *   2. prefix 错（不以 sk-agent- 开头）→ 401
 *   3. 已过期（agent_api_key.expires_at < NOW(3)） → 401
 *   4. 已禁用（status='DISABLED'） → 401
 *   5. hash 不匹配（同 prefix，但不同 raw） → 401
 *
 * 全部 401 + body.error.code='UNAUTHORIZED'，且不暴露具体原因（任务卡 §7 + 切片 09）。
 *
 * 真实 MySQL（任务卡 §7 MUST NOT §3）；不写 process.env（§7 MUST NOT §6）。
 *
 * @since 切片 19
 */
import type { Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  asAuthPool,
  cleanTenantData,
  closeMysqlPool,
  getMysqlPool,
  isMysqlReady,
} from './_helpers/mysql.js';
import { issueE2eApiKey } from './_helpers/api-key.js';
import { ensureBaseEnv } from './_helpers/env.js';
import { startAgentForTest, type AgentTestHandle } from './_helpers/agent-app.js';
import { logCommand, postChat } from './_helpers/chat-client.js';

const MERCHANT_ID = 'M_E2E_T02';
const STORE_ID = 'S_E2E_T02';
const USER_ID = 'boss-e2e-t02';

let pool: Pool;
let handle: AgentTestHandle;
let validKey: string;
let prefixCollisionKey: string; // 同 prefix 不同 raw 的另一把 key

beforeAll(async () => {
  ensureBaseEnv();
  if (!isMysqlReady()) return;
  pool = getMysqlPool();
  await cleanTenantData(pool, MERCHANT_ID);

  // 1) 颁发一把 ENABLED 且未过期的 key（用于 hash_mismatch 比对）
  const enabled = await issueE2eApiKey(pool, {
    merchantId: MERCHANT_ID,
    storeId: STORE_ID,
    userId: USER_ID,
  });
  validKey = enabled.apiKey;

  // 2) 颁发一把过期 key
  await issueE2eApiKey(pool, {
    merchantId: MERCHANT_ID,
    storeId: STORE_ID,
    userId: USER_ID + '-expired',
    ttlDays: -1,
  });

  // 3) 颁发一把 DISABLED key
  await issueE2eApiKey(pool, {
    merchantId: MERCHANT_ID,
    storeId: STORE_ID,
    userId: USER_ID + '-disabled',
    status: 'DISABLED',
  });

  // 4) 同 prefix 不同 raw 的 key —— 用同一个 prefix 但拼一段 random 后缀
  // 注意：authenticate() 用前 16 字符做候选检索；我们故意构造一个"prefix 命中、但 hash
  // 不匹配"的 key（直接复用 enabled.prefix 的 16 字符前缀 + 随机 raw 即可制造冲突）。
  prefixCollisionKey = `${enabled.prefix}_NOT_REAL_${'x'.repeat(20)}`;

  handle = startAgentForTest({ authPool: asAuthPool(pool) });
}, 30_000);

afterAll(async () => {
  if (isMysqlReady()) {
    await cleanTenantData(pool, MERCHANT_ID).catch(() => undefined);
    handle?.cleanup();
    await closeMysqlPool();
  }
  vi.unstubAllEnvs();
});

const BODY = {
  model: 'store-agent-v1',
  stream: true,
  messages: [{ role: 'user' as const, content: '你好' }],
};

describe.skipIf(!isMysqlReady())('T-02 API Key 5 类异常（任务卡 §8.1 §T-02）', () => {
  it('case 1: 缺 Authorization → 401 UNAUTHORIZED', async () => {
    logCommand(
      'T-02.1',
      "curl -X POST -H 'Content-Type: application/json' -d '{...}' /v1/chat/completions （无 Authorization）",
      'status=401 + error.code=UNAUTHORIZED',
    );
    const res = await postChat({ app: handle.app, body: BODY });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('case 2: prefix 错（不以 sk-agent- 开头）→ 401 UNAUTHORIZED', async () => {
    logCommand(
      'T-02.2',
      "curl -H 'Authorization: Bearer xxxxxxxxxxxxx' /v1/chat/completions",
      'status=401',
    );
    const res = await postChat({
      app: handle.app,
      apiKey: 'wrong-prefix-1234567890abcdef',
      body: BODY,
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('case 3: 已过期（expires_at < NOW(3)） → 401', async () => {
    // 颁发新过期 key 仅用于本 case 的明文（以避免同 USER 内 key 冲撞）
    const expired = await issueE2eApiKey(pool, {
      merchantId: MERCHANT_ID,
      storeId: STORE_ID,
      userId: USER_ID + '-expired-2',
      ttlDays: -1,
    });
    logCommand('T-02.3', `curl -H 'Authorization: Bearer ${expired.prefix}***'`, 'status=401（过期）');
    const res = await postChat({ app: handle.app, apiKey: expired.apiKey, body: BODY });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('case 4: 已禁用（status=DISABLED）→ 401（prefix 检索按 status=ENABLED 直接过滤）', async () => {
    const disabled = await issueE2eApiKey(pool, {
      merchantId: MERCHANT_ID,
      storeId: STORE_ID,
      userId: USER_ID + '-disabled-2',
      status: 'DISABLED',
    });
    logCommand(
      'T-02.4',
      `curl -H 'Authorization: Bearer ${disabled.prefix}***' /v1/chat/completions`,
      'status=401（DISABLED）',
    );
    const res = await postChat({ app: handle.app, apiKey: disabled.apiKey, body: BODY });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('case 5: hash 不匹配（同 prefix 但 raw 不同）→ 401', async () => {
    logCommand(
      'T-02.5',
      "curl -H 'Authorization: Bearer sk-agent-xxxxxxx_FAKE_xxx' /v1/chat/completions",
      'status=401（hash 不匹配）',
    );
    // 真实 valid key 会通过校验；故意构造 prefix 命中但 hash 不命中
    expect(prefixCollisionKey.length).toBeGreaterThan(16);
    const res = await postChat({
      app: handle.app,
      apiKey: prefixCollisionKey,
      body: BODY,
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('对照组：合法 key 不返回 401（status≠401）', async () => {
    const res = await postChat({ app: handle.app, apiKey: validKey, body: BODY });
    // 合法 key 走 SSE → 状态码 200；这里仅要求 not 401（具体协议见 T-03）
    expect(res.status).not.toBe(401);
    // 关闭 body 防止 SSE 卡住
    if (res.body) await res.body.cancel().catch(() => undefined);
  });
});
