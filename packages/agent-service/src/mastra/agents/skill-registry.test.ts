/**
 * 切片 21 — skill-registry 单测
 *
 * 覆盖：
 *   - collectWorkflowIds：从 createMastra workflows barrel 导出唯一 id（去重 alias）
 *   - loadSkillRegistryFromDb：V1 5 个 + V2 marketing_growth_copilot 齐 → 通过；缺一 / 多一 / required disabled → 抛错
 *   - assertSkillUsable：disabled / gray + 名外 / gray + 命中 / enabled 4 类
 *
 * 用 FakePool 隔离 mysql2，env 通过 vi.stubEnv 注入 `GRAY_MERCHANT_WHITELIST`，
 * 复用 packages/agent-service 现有测试基线。
 */
import { BizError } from '@storepilot/shared-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetEnvForTest } from '../../config/env.js';
import type { MysqlStoragePool } from '../storage/sql.js';

import {
  INTENT_TO_SKILL,
  SkillDefMismatchError,
  assertSkillUsable,
  collectWorkflowIds,
  createInMemorySkillRegistry,
  loadSkillRegistryFromDb,
  setSkillRegistry,
  verifySkillDef,
} from './skill-registry.js';

/**
 * 同步代码块抛 BizError 的断言：先调用、再用 instanceof + code 校验，
 * 避免 vitest `toThrow(expect.objectContaining(...))` 的类型限制。
 */
function expectBizErrorSync(fn: () => void, expectedCode: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(BizError);
  expect((caught as BizError).code).toBe(expectedCode);
}

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
  AGENT_API_KEY_HASH_SALT: 'salt-abcdef-1234',
  AGENT_API_KEY_PREFIX: 'sk-agent-',
  CORS_ALLOWED_ORIGINS: 'http://localhost:3210',
  GRAY_MERCHANT_WHITELIST: '',
};

const REQUIRED_SKILLS = [
  'business_daily_report',
  'business_monthly_report',
  'marketing_growth_copilot',
  'purchase_order_create',
  'replenishment_adjustment',
  'replenishment_forecast',
] as const;

class FakePool implements Pick<MysqlStoragePool, 'query'> {
  public rows: Array<{
    skill_code: string;
    status: string;
    risk_level: string;
    version: string;
  }> = [];

  query<T extends Record<string, unknown>>(
    sql: string,
  ): Promise<[T[], unknown]> {
    void sql;
    return Promise.resolve([this.rows as unknown as T[], undefined]);
  }
}

function buildHappyRows(): Array<{
  skill_code: string;
  status: string;
  risk_level: string;
  version: string;
}> {
  return [
    { skill_code: 'business_daily_report', status: 'enabled', risk_level: 'LOW', version: '1.0.0' },
    { skill_code: 'business_monthly_report', status: 'enabled', risk_level: 'LOW', version: '1.0.0' },
    { skill_code: 'marketing_growth_copilot', status: 'gray', risk_level: 'MEDIUM', version: '1.0.0' },
    { skill_code: 'replenishment_forecast', status: 'enabled', risk_level: 'MEDIUM', version: '1.0.0' },
    { skill_code: 'replenishment_adjustment', status: 'enabled', risk_level: 'MEDIUM', version: '1.0.0' },
    { skill_code: 'purchase_order_create', status: 'gray', risk_level: 'HIGH', version: '1.0.0' },
  ];
}

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV_FIXTURE)) vi.stubEnv(k, v);
  resetEnvForTest();
  setSkillRegistry(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvForTest();
  setSkillRegistry(null);
});

describe('skill-registry', () => {
  describe('collectWorkflowIds', () => {
    it('从 createMastra workflows barrel 拿到唯一 id（去重 snake_case 别名）', () => {
      const ids = collectWorkflowIds();
      expect(ids).toEqual([...REQUIRED_SKILLS]);
    });
  });

  describe('loadSkillRegistryFromDb — happy path', () => {
    it('V1 5 个 + V2 marketing_growth_copilot 齐 → 通过', async () => {
      const pool = new FakePool();
      pool.rows = buildHappyRows();

      const registry = await loadSkillRegistryFromDb(pool as unknown as MysqlStoragePool);
      expect(registry.list()).toEqual([...REQUIRED_SKILLS]);
      expect(registry.get('purchase_order_create')).toMatchObject({
        skillCode: 'purchase_order_create',
        status: 'gray',
        riskLevel: 'HIGH',
      });
    });
  });

  describe('loadSkillRegistryFromDb — 校验失败', () => {
    it('缺一个 Skill → 抛 SkillDefMismatchError 含 missing', async () => {
      const pool = new FakePool();
      pool.rows = buildHappyRows().filter((r) => r.skill_code !== 'replenishment_forecast');
      await expect(loadSkillRegistryFromDb(pool as unknown as MysqlStoragePool)).rejects.toMatchObject(
        {
          name: 'SkillDefMismatchError',
          missing: ['replenishment_forecast'],
        },
      );
    });

    it('多一个未注册 Skill → 抛 extra', async () => {
      const pool = new FakePool();
      pool.rows = [
        ...buildHappyRows(),
        { skill_code: 'rogue_skill', status: 'enabled', risk_level: 'LOW', version: '1.0.0' },
      ];
      await expect(loadSkillRegistryFromDb(pool as unknown as MysqlStoragePool)).rejects.toMatchObject(
        {
          name: 'SkillDefMismatchError',
          extra: ['rogue_skill'],
        },
      );
    });

    it('5 项中有 1 个 status=disabled → 抛 disabledRequired（任务卡 §9 step 9）', async () => {
      const pool = new FakePool();
      const rows = buildHappyRows();
      const idx = rows.findIndex((r) => r.skill_code === 'purchase_order_create');
      rows[idx]!.status = 'disabled';
      pool.rows = rows;

      const promise = loadSkillRegistryFromDb(pool as unknown as MysqlStoragePool);
      await expect(promise).rejects.toBeInstanceOf(SkillDefMismatchError);
      await expect(promise).rejects.toMatchObject({
        missing: ['purchase_order_create'],
        disabledRequired: ['purchase_order_create'],
      });
    });
  });

  describe('verifySkillDef — 注入单例 + 灰度网关', () => {
    it('verifySkillDef 通过后 setSkillRegistry 已注入；assertSkillUsable 走单例', async () => {
      const pool = new FakePool();
      pool.rows = buildHappyRows();

      vi.stubEnv('GRAY_MERCHANT_WHITELIST', 'M001,M002');
      resetEnvForTest();
      await verifySkillDef(pool as unknown as MysqlStoragePool);

      // M001 在白名单 → 灰度 Skill 可用
      expect(() => assertSkillUsable('purchase_order_create', 'M001')).not.toThrow();
      // M999 不在 → 抛 BizError(SKILL_NOT_AVAILABLE)
      expectBizErrorSync(
        () => assertSkillUsable('purchase_order_create', 'M999'),
        'SKILL_NOT_AVAILABLE',
      );
      // enabled Skill 任意商家可用
      expect(() => assertSkillUsable('business_daily_report', 'M999')).not.toThrow();
    });

    it('GRAY_MERCHANT_WHITELIST 空 / 缺省 → 灰度 Skill 一律拒绝', async () => {
      const pool = new FakePool();
      pool.rows = buildHappyRows();
      vi.stubEnv('GRAY_MERCHANT_WHITELIST', '');
      resetEnvForTest();
      await verifySkillDef(pool as unknown as MysqlStoragePool);

      expectBizErrorSync(
        () => assertSkillUsable('purchase_order_create', 'M001'),
        'SKILL_NOT_AVAILABLE',
      );
    });

    it('未注入 SkillRegistry 时 assertSkillUsable NOOP（避免单点把对话拉挂）', () => {
      setSkillRegistry(null);
      expect(() => assertSkillUsable('purchase_order_create', 'MANY')).not.toThrow();
    });
  });

  describe('createInMemorySkillRegistry — disabled / gray / enabled 三状态', () => {
    it('disabled → BizError(SKILL_NOT_AVAILABLE)', () => {
      const reg = createInMemorySkillRegistry([
        { skillCode: 'business_daily_report', status: 'disabled', riskLevel: 'LOW', version: '1.0.0' },
      ]);
      expectBizErrorSync(
        () => reg.assertUsable('business_daily_report', 'M001'),
        'SKILL_NOT_AVAILABLE',
      );
    });

    it('未注册 skillCode → BizError(SKILL_NOT_AVAILABLE)', () => {
      const reg = createInMemorySkillRegistry([]);
      expectBizErrorSync(
        () => reg.assertUsable('not_registered', 'M001'),
        'SKILL_NOT_AVAILABLE',
      );
    });
  });

  describe('INTENT_TO_SKILL 映射 SSOT', () => {
    it('6 个业务执行 intent 映射到 5 个 Skill 之一，取消动作不走创建采购单灰度门禁', () => {
      const allIntents = Object.keys(INTENT_TO_SKILL);
      expect(allIntents).toEqual(
        expect.arrayContaining([
          'BUSINESS_DAILY_REPORT',
          'EXPLAIN_METRIC',
          'BUSINESS_MONTHLY_REPORT',
          'REPLENISHMENT_PLAN',
          'ADJUST_REPLENISHMENT_DRAFT',
          'CONFIRM_CREATE_PURCHASE_ORDER',
        ]),
      );
      expect(INTENT_TO_SKILL).not.toHaveProperty('CANCEL_REPLENISHMENT_DRAFT');
      const targets = new Set(Object.values(INTENT_TO_SKILL));
      expect([...targets].sort()).toEqual([
        'business_daily_report',
        'business_monthly_report',
        'purchase_order_create',
        'replenishment_adjustment',
        'replenishment_forecast',
      ]);
    });
  });
});
