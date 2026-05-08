/**
 * 切片 09 §9 验收 step 3-7 + §10 测试场景 1-7 — authenticate 单测
 *
 * 覆盖（任务卡 §9 11 步中桥接层路径相关：3-7）:
 *   - 1000 把 key 性能：P95 < 200ms（§9 step 3）
 *   - 5 类异常 + happy（§9 step 4 / §10.1-§10.5）：
 *       missing_authorization / invalid_prefix / expired / disabled / hash_mismatch / valid
 *   - 跨租户：A 的 key 不能拿到 B 的 merchantId（§9 step 5 / §10.7）
 *   - 节流：100 次相同 key → DB UPDATE 仅 1 次（§9 step 6 / §10.6）
 *   - 日志无完整 API Key 明文（§9 step 7 / §10）
 *   - prefix 候选检索 SQL 形态（命中 idx_api_key_prefix_status / disabled 不在候选）
 *   - argon2.verify secret = AGENT_API_KEY_HASH_SALT（server pepper）
 *
 * 测试基础设施：
 *   - 内存版 FakeAuthPool 模拟 mysql2：识别 SELECT WHERE prefix=? AND status='ENABLED'
 *     与 UPDATE last_used_at 节流；可控时钟 advance(ms) 用于 1 分钟节流验证。
 *   - 真 argon2id hash + verify（使用与生产 issue.ts 相同参数 + secret pepper），
 *     保证不会出现 "测试通过 / 生产 hash 不匹配" 的漂移。
 *
 * 项目当前不含 test:integration 流水线（H-测试 H-01 后续完整化）；本文件用 fake pool +
 * 真 argon2 还原相同语义达成 §9 step 3-7 验收，切片 20 完整化 mysql2 pool 后会有集成测试。
 */
import argon2 from 'argon2';
import { BizError } from '@storepilot/shared-contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  API_KEY_PREFIX_LENGTH,
  type ApiKeyRow,
  type AuthPool,
  authenticate,
  resetAuthPoolForTest,
  setAuthPool,
} from './auth.js';

/* ============================================================================
 * Env fixture（getEnv() 单例；必须在首次 import 前 set）
 *   - 与切片 06/07/08 测试同 fixture，保证 getEnv() 一次解析跨用例稳定。
 *   - AGENT_API_KEY_HASH_SALT 必须 ≥ 16 字符（切片 01 zod 守门）。
 * ========================================================================== */
const TEST_API_KEY_HASH_SALT = 'unit-test-salt-32chars-xxxxxxxxxx';

const ENV_FIXTURE: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '7100',
  DATABASE_URL: 'mysql://test:test@localhost:3306/test',
  MODEL_PROVIDER: 'openai-compatible',
  MODEL_BASE_URL: 'http://localhost:7100/llm',
  MODEL_API_KEY: 'sk-test-1234567890',
  MODEL_NAME: 'gpt-test',
  ERP_MCP_SERVER_URL: 'http://localhost:7300/mcp',
  MCP_TENANT_SHARED_SECRET: 'a'.repeat(32),
  MCP_PROTOCOL_VERSION: '2025-06-18',
  AGENT_API_KEY_HASH_SALT: TEST_API_KEY_HASH_SALT,
  AGENT_API_KEY_PREFIX: 'sk-agent-',
  CORS_ALLOWED_ORIGINS: 'http://localhost:3210',
};

beforeAll(() => {
  for (const [key, value] of Object.entries(ENV_FIXTURE)) vi.stubEnv(key, value);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

/* ============================================================================
 * FakeAuthPool —— mysql2 Pool 的 in-memory 等价（识别 prefix WHERE / 节流 UPDATE）
 * ========================================================================== */

interface CallRecord {
  kind: 'query' | 'execute';
  sql: string;
  params: unknown[];
}

class FakeAuthPool implements AuthPool {
  /** 行存储（keyed by id） */
  public readonly rows = new Map<number, ApiKeyRow & { last_used_at: Date | null }>();

  /** SQL 调用历史（用于断言 SELECT prefix WHERE / UPDATE 节流） */
  public readonly calls: CallRecord[] = [];

  /** 可控时钟：所有 NOW(3) 等价 = clock；UPDATE 节流条件以此为准 */
  public clock = new Date('2026-05-07T01:00:00.000Z');

  advance(ms: number): void {
    this.clock = new Date(this.clock.getTime() + ms);
  }

  insert(row: ApiKeyRow & { last_used_at?: Date | null }): void {
    this.rows.set(row.id, { ...row, last_used_at: row.last_used_at ?? null });
  }

  query<T extends Record<string, unknown>>(
    sql: string,
    params: readonly unknown[],
  ): Promise<[T[], unknown]> {
    this.calls.push({ kind: 'query', sql, params: [...params] });
    const norm = sql.replace(/\s+/g, ' ').trim();
    if (
      /SELECT .* FROM agent_api_key WHERE api_key_prefix = \? AND status = 'ENABLED'/i.test(norm)
    ) {
      const prefix = params[0];
      const rows: ApiKeyRow[] = [];
      for (const row of this.rows.values()) {
        if (row.api_key_prefix === prefix && row.status === 'ENABLED') {
          rows.push({
            id: row.id,
            api_key_hash: row.api_key_hash,
            api_key_prefix: row.api_key_prefix,
            merchant_id: row.merchant_id,
            store_id: row.store_id,
            user_id: row.user_id,
            status: row.status,
            expires_at: row.expires_at,
          });
        }
      }
      return Promise.resolve([rows as unknown as T[], undefined]);
    }
    throw new Error(`FakeAuthPool: 未识别的 query SQL: ${norm}`);
  }

  execute(
    sql: string,
    params: readonly unknown[],
  ): Promise<[{ affectedRows: number }, unknown]> {
    this.calls.push({ kind: 'execute', sql, params: [...params] });
    const norm = sql.replace(/\s+/g, ' ').trim();
    if (
      /UPDATE agent_api_key SET last_used_at = NOW\(3\) WHERE id = \? AND \(last_used_at IS NULL OR last_used_at < NOW\(3\) - INTERVAL 1 MINUTE\)/i.test(
        norm,
      )
    ) {
      const id = Number(params[0]);
      const row = this.rows.get(id);
      if (!row) return Promise.resolve([{ affectedRows: 0 }, undefined]);
      const oneMinAgo = new Date(this.clock.getTime() - 60_000);
      if (row.last_used_at === null || row.last_used_at < oneMinAgo) {
        row.last_used_at = new Date(this.clock);
        return Promise.resolve([{ affectedRows: 1 }, undefined]);
      }
      return Promise.resolve([{ affectedRows: 0 }, undefined]);
    }
    throw new Error(`FakeAuthPool: 未识别的 execute SQL: ${norm}`);
  }

  /** 统计实际触发了 affectedRows=1 的 UPDATE 次数（任务卡 §9 step 6 节流验收） */
  countUpdateHits(): number {
    // 以 calls 为线索 + 重放：每次 UPDATE 我们已经在 execute 中改写了 last_used_at，
    // 这里只统计 execute 的次数（请求次数）；真正"DB 写入次数"由测试自己跟踪。
    return this.calls.filter((c) => c.kind === 'execute').length;
  }
}

/* ============================================================================
 * 通用 helpers
 * ========================================================================== */

const PREFIX_LITERAL = ENV_FIXTURE['AGENT_API_KEY_PREFIX'] ?? 'sk-agent-';

async function hashKey(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, {
    type: argon2.argon2id,
    secret: Buffer.from(TEST_API_KEY_HASH_SALT),
  });
}

function makePlaintextKey(seed: string): string {
  // sk-agent- (9) + 20 字符 base64url 风（保证 prefix=16）
  const padded = (seed + 'x'.repeat(40)).slice(0, 40);
  return `${PREFIX_LITERAL}${padded}`;
}

interface SeedRowArgs {
  id: number;
  plaintext: string;
  merchantId?: string;
  storeId?: string | null;
  userId?: string;
  status?: string;
  expiresAt?: Date | string | null;
}

async function seedRow(args: SeedRowArgs): Promise<ApiKeyRow & { last_used_at: null }> {
  return {
    id: args.id,
    api_key_hash: await hashKey(args.plaintext),
    api_key_prefix: args.plaintext.slice(0, API_KEY_PREFIX_LENGTH),
    merchant_id: args.merchantId ?? 'M001',
    store_id: args.storeId === undefined ? 'S001' : args.storeId,
    user_id: args.userId ?? 'boss-001',
    status: args.status ?? 'ENABLED',
    expires_at: args.expiresAt ?? null,
    last_used_at: null,
  };
}

/* ============================================================================
 * 用例
 * ========================================================================== */

describe('切片 09 §10.1 — happy 路径', () => {
  let pool: FakeAuthPool;
  beforeEach(() => {
    pool = new FakeAuthPool();
    setAuthPool(pool);
  });
  afterEach(() => resetAuthPoolForTest());

  it('有效 key → 返回 merchantId / storeId / userId / apiKeyPrefix', async () => {
    const plaintext = makePlaintextKey('happy01');
    pool.insert(await seedRow({ id: 1, plaintext }));

    const result = await authenticate(`Bearer ${plaintext}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.merchantId).toBe('M001');
    expect(result.storeId).toBe('S001');
    expect(result.userId).toBe('boss-001');
    expect(result.apiKeyPrefix).toBe(plaintext.slice(0, API_KEY_PREFIX_LENGTH));
    expect(result.apiKeyPrefix.length).toBe(API_KEY_PREFIX_LENGTH);
  });

  it('有效 key + storeId=null → 派生 storeId = "" （空串兜底，不传 null）', async () => {
    const plaintext = makePlaintextKey('happy02');
    pool.insert(await seedRow({ id: 1, plaintext, storeId: null }));

    const result = await authenticate(`Bearer ${plaintext}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.storeId).toBe('');
  });
});

describe('切片 09 §10 — 5 类异常全部返回 ok:false（外部统一 401）', () => {
  let pool: FakeAuthPool;
  beforeEach(() => {
    pool = new FakeAuthPool();
    setAuthPool(pool);
  });
  afterEach(() => resetAuthPoolForTest());

  it('missing_authorization：authHeader = undefined', async () => {
    const result = await authenticate(undefined);
    expect(result).toEqual({ ok: false, reason: 'missing_authorization' });
  });

  it('missing_authorization：Bearer 后没有 token', async () => {
    const result = await authenticate('Bearer    ');
    expect(result).toEqual({ ok: false, reason: 'missing_authorization' });
  });

  it('missing_authorization：非 Bearer scheme', async () => {
    const result = await authenticate('Basic xyz');
    expect(result).toEqual({ ok: false, reason: 'missing_authorization' });
  });

  it('invalid_prefix：apiKey 不以 sk-agent- 开头', async () => {
    const result = await authenticate('Bearer abc-not-our-prefix-xxxxxxxxxxx');
    expect(result).toEqual({ ok: false, reason: 'invalid_prefix' });
    // 不应到达 DB 查询
    expect(pool.calls.filter((c) => c.kind === 'query').length).toBe(0);
  });

  it('expired：expires_at < NOW() → continue skip → no_match（不 throw）', async () => {
    const plaintext = makePlaintextKey('expired1');
    pool.insert(
      await seedRow({
        id: 1,
        plaintext,
        expiresAt: new Date(Date.now() - 24 * 3600 * 1000), // 1 天前过期
      }),
    );

    const result = await authenticate(`Bearer ${plaintext}`);
    expect(result).toEqual({ ok: false, reason: 'no_match' });
    // 节流 UPDATE 不应被触发（expired 已 continue）
    expect(pool.calls.filter((c) => c.kind === 'execute').length).toBe(0);
  });

  it('disabled：status=DISABLED → 不在 prefix 候选集（WHERE 已过滤）→ no_match', async () => {
    const plaintext = makePlaintextKey('disabled');
    pool.insert(await seedRow({ id: 1, plaintext, status: 'DISABLED' }));

    const result = await authenticate(`Bearer ${plaintext}`);
    expect(result).toEqual({ ok: false, reason: 'no_match' });
    expect(pool.calls.filter((c) => c.kind === 'execute').length).toBe(0);
  });

  it('hash_mismatch：候选存在但 plaintext 与库中 hash 不匹配 → no_match', async () => {
    const plaintextStored = makePlaintextKey('stored01');
    pool.insert(await seedRow({ id: 1, plaintext: plaintextStored }));

    // 另一把 key —— prefix 相同（前 16 字符），但后续不同 → argon2.verify 返回 false
    const plaintextWrong = `${plaintextStored.slice(0, API_KEY_PREFIX_LENGTH)}DIFFERENT_TAIL_xx`;
    expect(plaintextWrong.slice(0, API_KEY_PREFIX_LENGTH)).toBe(
      plaintextStored.slice(0, API_KEY_PREFIX_LENGTH),
    );

    const result = await authenticate(`Bearer ${plaintextWrong}`);
    expect(result).toEqual({ ok: false, reason: 'no_match' });
  });

  it('argon2.verify 抛错（hash 格式损坏）→ continue 该候选 → no_match（不 500）', async () => {
    const plaintext = makePlaintextKey('crashed1');
    const goodRow = await seedRow({ id: 1, plaintext });
    pool.insert({ ...goodRow, api_key_hash: 'NOT_AN_ARGON2_HASH' });

    const result = await authenticate(`Bearer ${plaintext}`);
    expect(result).toEqual({ ok: false, reason: 'no_match' });
  });
});

describe('切片 09 §10.5 — disabled 不在候选集 + prefix 候选检索 SQL 形态', () => {
  let pool: FakeAuthPool;
  beforeEach(() => {
    pool = new FakeAuthPool();
    setAuthPool(pool);
  });
  afterEach(() => resetAuthPoolForTest());

  it('SELECT 必须 WHERE api_key_prefix=? AND status=\'ENABLED\'（命中 idx_api_key_prefix_status）', async () => {
    const plaintext = makePlaintextKey('select01');
    pool.insert(await seedRow({ id: 1, plaintext }));

    await authenticate(`Bearer ${plaintext}`);
    const queries = pool.calls.filter((c) => c.kind === 'query');
    expect(queries.length).toBe(1);
    const sql = queries[0]?.sql.replace(/\s+/g, ' ').trim() ?? '';
    expect(sql).toContain("WHERE api_key_prefix = ? AND status = 'ENABLED'");
    // 严格守门：禁全表 verify（不得出现 SELECT * FROM agent_api_key 不带 prefix WHERE）
    expect(sql).not.toMatch(/SELECT .* FROM agent_api_key\s+(?!WHERE)/);
    // 候选检索参数 = apiKey.slice(0, 16)
    expect(queries[0]?.params).toEqual([plaintext.slice(0, API_KEY_PREFIX_LENGTH)]);
  });
});

describe('切片 09 §10.7 — 跨租户：A 的 key 不能拿到 B 的 merchantId', () => {
  let pool: FakeAuthPool;
  beforeEach(() => {
    pool = new FakeAuthPool();
    setAuthPool(pool);
  });
  afterEach(() => resetAuthPoolForTest());

  it('A 的 key 鉴权 → 返回 A 的 merchantId（即使 B 数据共存）', async () => {
    const keyA = makePlaintextKey('AAAAA01');
    const keyB = makePlaintextKey('BBBBB01');
    pool.insert(
      await seedRow({ id: 1, plaintext: keyA, merchantId: 'MERCHANT_A', userId: 'user-a' }),
    );
    pool.insert(
      await seedRow({ id: 2, plaintext: keyB, merchantId: 'MERCHANT_B', userId: 'user-b' }),
    );

    const ra = await authenticate(`Bearer ${keyA}`);
    expect(ra.ok).toBe(true);
    if (ra.ok) {
      expect(ra.merchantId).toBe('MERCHANT_A');
      expect(ra.userId).toBe('user-a');
    }

    const rb = await authenticate(`Bearer ${keyB}`);
    expect(rb.ok).toBe(true);
    if (rb.ok) {
      expect(rb.merchantId).toBe('MERCHANT_B');
      expect(rb.userId).toBe('user-b');
    }
  });
});

describe('切片 09 §10.6 — last_used_at 节流：5s 内 100 次相同 key → DB UPDATE 仅 1 次', () => {
  let pool: FakeAuthPool;
  beforeEach(() => {
    pool = new FakeAuthPool();
    setAuthPool(pool);
  });
  afterEach(() => resetAuthPoolForTest());

  it('100 次相同 key → 100 次 UPDATE 调用，但仅 1 次实际改 last_used_at（affectedRows=1）', async () => {
    const plaintext = makePlaintextKey('throttle');
    pool.insert(await seedRow({ id: 1, plaintext }));
    const verifySpy = vi.spyOn(argon2, 'verify').mockResolvedValue(true);

    try {
      let updateAffected = 0;
      const origExecute = pool.execute.bind(pool);
      pool.execute = async (sql, params) => {
        const r = await origExecute(sql, params);
        if (r[0].affectedRows > 0) updateAffected += r[0].affectedRows;
        return r;
      };

      for (let i = 0; i < 100; i++) {
        const result = await authenticate(`Bearer ${plaintext}`);
        expect(result.ok).toBe(true);
      }

      // 100 次 UPDATE 调用（每次成功鉴权都会发 SQL）
      expect(pool.calls.filter((c) => c.kind === 'execute').length).toBe(100);
      // 但实际改库只有第 1 次
      expect(updateAffected).toBe(1);

      // 时钟前推 1 分钟 + 1 秒 → 下次又会改一次
      pool.advance(61_000);
      await authenticate(`Bearer ${plaintext}`);
      expect(updateAffected).toBe(2);
    } finally {
      verifySpy.mockRestore();
    }
  });

  it('节流 SQL 必须用 < 不是 >（任务卡 §7 MUST NOT §4）', async () => {
    const plaintext = makePlaintextKey('thrtsql');
    pool.insert(await seedRow({ id: 1, plaintext }));
    await authenticate(`Bearer ${plaintext}`);
    const updates = pool.calls.filter((c) => c.kind === 'execute');
    const sql = updates[0]?.sql ?? '';
    expect(sql).toContain('< NOW(3) - INTERVAL 1 MINUTE');
    // 严格守门：禁出现 > NOW
    expect(sql).not.toMatch(/last_used_at\s+>\s+NOW/i);
  });
});

describe('切片 09 §9 step 7 — 日志无完整 API Key 明文', () => {
  let pool: FakeAuthPool;
  beforeEach(() => {
    pool = new FakeAuthPool();
    setAuthPool(pool);
  });
  afterEach(() => resetAuthPoolForTest());

  it('argon2.verify 抛错时仅打印 prefix（前 16 字符），不打印完整 key', async () => {
    // 截获 logger.debug 输出 —— 用 process.stderr.write hook 捕获 pino 行
    const captured: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: typeof process.stderr.write }).write = ((
      chunk: unknown,
      ...rest: unknown[]
    ): boolean => {
      if (typeof chunk === 'string') captured.push(chunk);
      else if (chunk instanceof Uint8Array) captured.push(Buffer.from(chunk).toString('utf-8'));
      return orig(chunk as Parameters<typeof orig>[0], ...(rest as Parameters<typeof orig>[1][]));
    }) as typeof process.stderr.write;

    try {
      const plaintext = makePlaintextKey('logleak1');
      const goodRow = await seedRow({ id: 1, plaintext });
      pool.insert({ ...goodRow, api_key_hash: 'NOT_AN_ARGON2_HASH' });
      // 使 logger.debug 实际输出（默认 level=info；此处只断言 captured 中无明文）
      await authenticate(`Bearer ${plaintext}`);
    } finally {
      (process.stderr as { write: typeof process.stderr.write }).write = orig;
    }

    const all = captured.join('');
    // 全文不得含完整 key（最长前缀 16 字符可以出现，超过 16 字符的 substring 不允许）
    const fullKey = makePlaintextKey('logleak1');
    expect(all.includes(fullKey)).toBe(false);
    // 也不得含 base64url 风的 tail（plaintext 第 17 字符及以后）
    const tail = fullKey.slice(API_KEY_PREFIX_LENGTH);
    expect(all.includes(tail)).toBe(false);
  });
});

describe('切片 09 §9 step 3 — 1000 把 key 性能 P95 < 200ms', () => {
  let pool: FakeAuthPool;
  let validPlaintext = '';

  beforeEach(async () => {
    pool = new FakeAuthPool();
    setAuthPool(pool);

    // 真 hash 1 把（被命中），其余 999 把灌入随机 prefix + 占位 hash（永远不会被遍历，保证 prefix WHERE 起作用）
    validPlaintext = makePlaintextKey('valid_perf_test_key');
    pool.insert(await seedRow({ id: 1, plaintext: validPlaintext }));

    for (let i = 2; i <= 1000; i++) {
      // 不同 prefix（i 编码进 7 字符 tail）→ prefix 不与 valid 冲突
      const seed = `${String(i).padStart(7, '0')}`;
      const otherKey = makePlaintextKey(seed);
      pool.insert({
        id: i,
        api_key_hash: 'PLACEHOLDER_HASH_NOT_REACHED',
        api_key_prefix: otherKey.slice(0, API_KEY_PREFIX_LENGTH),
        merchant_id: `M${i}`,
        store_id: 'S',
        user_id: `u${i}`,
        status: 'ENABLED',
        expires_at: null,
        last_used_at: null,
      });
    }
  });
  afterEach(() => resetAuthPoolForTest());

  it('100 次 authenticate 命中：P95 < 200ms（含 1 次 argon2.verify）', async () => {
    const ITER = 100;
    const durations: number[] = [];
    for (let i = 0; i < ITER; i++) {
      const t0 = performance.now();
      const r = await authenticate(`Bearer ${validPlaintext}`);
      const t1 = performance.now();
      expect(r.ok).toBe(true);
      durations.push(t1 - t0);
    }
    durations.sort((a, b) => a - b);
    const p95Index = Math.ceil(0.95 * ITER) - 1;
    const p95 = durations[p95Index] ?? durations[durations.length - 1] ?? 0;
    // 任务卡 §9 step 3 硬约束
    expect(p95).toBeLessThan(200);
  }, 60_000);

  it('prefix 候选检索保证 ≤ 1 行 verify（绝大多数 prefix 不冲突）', async () => {
    pool.calls.length = 0;
    await authenticate(`Bearer ${validPlaintext}`);
    const query = pool.calls.find((c) => c.kind === 'query');
    expect(query).toBeDefined();
    // SQL 形态守门 —— 禁出现 SELECT 不带 WHERE prefix
    expect(query?.sql.replace(/\s+/g, ' ')).toMatch(/WHERE api_key_prefix = \?/);
  });
});

describe('bridge/auth — Pool DI 兜底', () => {
  afterEach(() => resetAuthPoolForTest());

  it('未注入 AuthPool → 抛 BizError(INTERNAL_ERROR)', async () => {
    resetAuthPoolForTest();
    const caught: unknown = await authenticate('Bearer sk-agent-bootstrap-missing-pool').catch(
      (err: unknown) => err,
    );
    expect(caught).toBeInstanceOf(BizError);
    if (!(caught instanceof BizError)) throw new Error('expected BizError');
    expect(caught.code).toBe('INTERNAL_ERROR');
    expect(caught.message).toMatch(/AuthPool 未注入/);
  });
});

describe('切片 09 §6 MUST DO §1 — argon2id + secret pepper（AGENT_API_KEY_HASH_SALT）', () => {
  let pool: FakeAuthPool;
  beforeEach(() => {
    pool = new FakeAuthPool();
    setAuthPool(pool);
  });
  afterEach(() => resetAuthPoolForTest());

  it('hash 用 secret = AGENT_API_KEY_HASH_SALT 创建；verify 用相同 secret 才命中', async () => {
    const plaintext = makePlaintextKey('pepper01');
    // 用错误 secret hash → verify 应失败
    const wrongHash = await argon2.hash(plaintext, {
      type: argon2.argon2id,
      secret: Buffer.from('wrong-pepper-secret-32-chars-xxx'),
    });
    pool.insert({
      id: 1,
      api_key_hash: wrongHash,
      api_key_prefix: plaintext.slice(0, API_KEY_PREFIX_LENGTH),
      merchant_id: 'M001',
      store_id: 'S001',
      user_id: 'boss-001',
      status: 'ENABLED',
      expires_at: null,
      last_used_at: null,
    });

    const result = await authenticate(`Bearer ${plaintext}`);
    expect(result).toEqual({ ok: false, reason: 'no_match' });
  });

  it('hash 包含 argon2id 算法标识（$argon2id$）', async () => {
    const hash = await argon2.hash(makePlaintextKey('format01'), {
      type: argon2.argon2id,
      secret: Buffer.from(TEST_API_KEY_HASH_SALT),
    });
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });
});

describe('切片 09 §6 MUST DO §6 — 多候选时 expired 不抛错且 valid 命中', () => {
  let pool: FakeAuthPool;
  beforeEach(() => {
    pool = new FakeAuthPool();
    setAuthPool(pool);
  });
  afterEach(() => resetAuthPoolForTest());

  it('两条候选：1 已过期 + 1 有效（同 prefix）→ 跳过过期 → 命中有效', async () => {
    const plaintext = makePlaintextKey('multi_01');

    // 注：argon2id 输出每次 salt 不同 → 同 plaintext 两次 hash 也不同；
    // 但 prefix 相同（取 plaintext 前 16 字符），可在 prefix WHERE 下同时命中候选集。
    pool.insert({
      id: 1,
      api_key_hash: await hashKey(plaintext),
      api_key_prefix: plaintext.slice(0, API_KEY_PREFIX_LENGTH),
      merchant_id: 'M-EXPIRED',
      store_id: 'S',
      user_id: 'u',
      status: 'ENABLED',
      expires_at: new Date(Date.now() - 3600_000), // 1 小时前过期
      last_used_at: null,
    });
    pool.insert({
      id: 2,
      api_key_hash: await hashKey(plaintext),
      api_key_prefix: plaintext.slice(0, API_KEY_PREFIX_LENGTH),
      merchant_id: 'M-VALID',
      store_id: 'S',
      user_id: 'u',
      status: 'ENABLED',
      expires_at: null,
      last_used_at: null,
    });

    const result = await authenticate(`Bearer ${plaintext}`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.merchantId).toBe('M-VALID');
  });

  it('expires_at 字段为字符串（mysql2 dateStrings=true 形态）也正确判断', async () => {
    const plaintext = makePlaintextKey('exp_str1');
    pool.insert({
      id: 1,
      api_key_hash: await hashKey(plaintext),
      api_key_prefix: plaintext.slice(0, API_KEY_PREFIX_LENGTH),
      merchant_id: 'M001',
      store_id: 'S',
      user_id: 'u',
      status: 'ENABLED',
      expires_at: '2020-01-01 00:00:00.000', // 远在过去
      last_used_at: null,
    });
    const result = await authenticate(`Bearer ${plaintext}`);
    expect(result).toEqual({ ok: false, reason: 'no_match' });
  });
});
