/**
 * 切片 19 — T-14 sessionId 稳定（同 messages → 同 sessionId）
 *
 * 严格按 docs/tanks/19-test-e2e-20-cases.md §8.1 §T-14 + 切片 09 §10.1/§10.3 落地：
 *   - 同 apiKey + 同 first system + 同 first user → sessionId 100% 稳定
 *   - 多轮对话（追加 user/assistant 消息）→ sessionId 不变
 *   - 不同 apiKey → 不同 sessionId
 *
 * @since 切片 19
 */
import type { Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { issueE2eApiKey } from './_helpers/api-key.js';
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

const MERCHANT_ID = 'M_E2E_T14';
const STORE_ID = 'S_E2E_T14';
const USER_ID = 'boss-e2e-t14';

let pool: Pool;
let apiKeyA: string;
let prefixA: string;
let prefixB: string;

beforeAll(async () => {
  if (!isMysqlReady()) return;
  pool = getMysqlPool();
  await cleanTenantData(pool, MERCHANT_ID);

  const issuedA = await issueE2eApiKey(pool, {
    merchantId: MERCHANT_ID,
    storeId: STORE_ID,
    userId: USER_ID,
  });
  apiKeyA = issuedA.apiKey;
  prefixA = issuedA.prefix;
  void asAuthPool;
  void apiKeyA;

  const issuedB = await issueE2eApiKey(pool, {
    merchantId: MERCHANT_ID,
    storeId: STORE_ID,
    userId: USER_ID + '-b',
  });
  prefixB = issuedB.prefix;
}, 30_000);

afterAll(async () => {
  if (isMysqlReady()) {
    await cleanTenantData(pool, MERCHANT_ID).catch(() => undefined);
    await closeMysqlPool();
  }
  vi.unstubAllEnvs();
});

describe.skipIf(!isMysqlReady())('T-14 sessionId 稳定（任务卡 §8.1 §T-14）', () => {
  it('同 prefix + 同 first system/user → 100 次相同 sessionId', async () => {
    logCommand(
      'T-14.a',
      'inferSessionId(apiKeyPrefix, [system,user]) × 100',
      'all 100 results equal',
    );
    const sessionMod = await import('../../src/bridge/session.js');
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(
        sessionMod.inferSessionId({
          apiKeyPrefix: prefixA,
          messages: [
            { role: 'system', content: 'You are a helpful agent.' },
            { role: 'user', content: '今天经营如何' },
          ],
        }),
      );
    }
    expect(ids.size).toBe(1);
    const only = [...ids][0]!;
    expect(only).toMatch(/^sess_[a-f0-9]{16}$/);
  });

  it('追加 user / assistant 消息 → sessionId 不变（首条 system/user 不动）', async () => {
    logCommand(
      'T-14.b',
      'inferSessionId messages=[s,u] vs [s,u,a,u2]',
      'sessionId 相等',
    );
    const sessionMod = await import('../../src/bridge/session.js');
    const baseId = sessionMod.inferSessionId({
      apiKeyPrefix: prefixA,
      messages: [
        { role: 'system', content: 'You are a helpful agent.' },
        { role: 'user', content: '今天经营如何' },
      ],
    });
    const longId = sessionMod.inferSessionId({
      apiKeyPrefix: prefixA,
      messages: [
        { role: 'system', content: 'You are a helpful agent.' },
        { role: 'user', content: '今天经营如何' },
        { role: 'assistant', content: '今天营业额 ¥4520' },
        { role: 'user', content: '看看库存' },
      ],
    });
    expect(longId).toBe(baseId);
  });

  it('不同 apiKey → 不同 sessionId', async () => {
    logCommand('T-14.c', 'inferSessionId prefix=A vs B (相同 messages)', 'sessionId 不相等');
    const sessionMod = await import('../../src/bridge/session.js');
    const idA = sessionMod.inferSessionId({
      apiKeyPrefix: prefixA,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
    });
    const idB = sessionMod.inferSessionId({
      apiKeyPrefix: prefixB,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(idA).not.toBe(idB);
  });
});
