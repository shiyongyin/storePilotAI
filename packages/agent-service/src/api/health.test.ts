/**
 * 切片 20 §10 — health 路由单测（5 条路由 + readiness 隔离）
 *
 * 覆盖范围：
 *   1. /health 仅返回 `{ status: 'UP' }`，且不依赖任何 DI（liveness 任意环境必通）。
 *   2. /health/db UP / DOWN（pool 未注入 / SELECT 失败 / 表数 < 11）。
 *   3. /health/mcp UP / DOWN（mcpToolsFn 未注入走默认 → fail；返回少 / 多 / 不一致工具）。
 *   4. /health/model UP / DOWN（modelPingFn 未注入 = 503；ping 抛错 = 503）。
 *   5. /health/ready 聚合：db / mcp 任一失败即 503；不调 modelPingFn（任务卡 §7 MUST NOT §4）。
 *
 * 注：测试严格走 DI 注入 fake，不依赖真实 mysql / mcp / LLM 网关。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { TOOL_WHITELIST } from '../mastra/mcp/client.js';

import {
  health,
  resetHealthDepsForTest,
  setHealthDeps,
  type HealthPool,
} from './health.js';

// =============================================================================
// FakePool — 模拟 mysql2 pool 的最小子集（与 health.ts HealthPool 形状一致）
// =============================================================================
interface FakeRow extends Record<string, unknown> {
  cnt?: number;
  ok?: number;
}

class FakePool implements HealthPool {
  /** SELECT 1 的命中 */
  public selectOneOk = true;
  /** information_schema.tables COUNT(*) 返回值 */
  public tableCount = 13;
  /** 强制下一次 query 抛错的开关 */
  public throwOn: 'select1' | 'count' | null = null;

  query<T extends Record<string, unknown>>(
    sql: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _params?: readonly unknown[],
  ): Promise<[T[], unknown]> {
    const norm = sql.replace(/\s+/g, ' ').trim();
    if (/SELECT 1/.test(norm)) {
      if (this.throwOn === 'select1') {
        return Promise.reject(new Error('mysql connection refused'));
      }
      const rows: FakeRow[] = [{ ok: this.selectOneOk ? 1 : 0 }];
      return Promise.resolve([rows as unknown as T[], undefined]);
    }
    if (/information_schema\.tables/i.test(norm)) {
      if (this.throwOn === 'count') {
        return Promise.reject(new Error('information_schema unavailable'));
      }
      const rows: FakeRow[] = [{ cnt: this.tableCount }];
      return Promise.resolve([rows as unknown as T[], undefined]);
    }
    return Promise.reject(new Error(`FakePool: unexpected SQL: ${norm}`));
  }
}

const fullToolset = (): Record<string, { inputSchema: object; outputSchema: object }> => {
  const out: Record<string, { inputSchema: object; outputSchema: object }> = {};
  for (const name of TOOL_WHITELIST) {
    out[name] = { inputSchema: {}, outputSchema: {} };
  }
  return out;
};

// =============================================================================
// 测试入口
// =============================================================================
describe('api/health.ts — 5 路由（liveness / db / mcp / model / ready）', () => {
  beforeEach(() => {
    resetHealthDepsForTest();
  });

  afterEach(() => {
    resetHealthDepsForTest();
    vi.restoreAllMocks();
  });

  describe('/health（liveness 唯一探针）', () => {
    it('总是返回 200 + { status: UP }；不依赖任何 DI', async () => {
      const res = await health.request('/health');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe('UP');
    });

    it('未注入任何依赖也通过（liveness 任意环境必通）', async () => {
      // 显式不调用 setHealthDeps —— 仍 200
      const res = await health.request('/health');
      expect(res.status).toBe(200);
    });
  });

  describe('/health/db', () => {
    it('pool 未注入 → 503 reason="pool not injected"', async () => {
      const res = await health.request('/health/db');
      expect(res.status).toBe(503);
      const body = (await res.json()) as { status: string; reason: string };
      expect(body.status).toBe('DOWN');
      expect(body.reason).toContain('pool not injected');
    });

    it('SELECT 1 + 13 表 → 200 UP', async () => {
      const pool = new FakePool();
      pool.tableCount = 13;
      setHealthDeps({ pool });

      const res = await health.request('/health/db');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; tables: number };
      expect(body.status).toBe('UP');
      expect(body.tables).toBe(13);
    });

    it('表数 < 11 → 503 reason 含具体计数', async () => {
      const pool = new FakePool();
      pool.tableCount = 9;
      setHealthDeps({ pool });

      const res = await health.request('/health/db');
      expect(res.status).toBe(503);
      const body = (await res.json()) as { status: string; reason: string };
      expect(body.status).toBe('DOWN');
      expect(body.reason).toContain('tables=9');
    });

    it('SELECT 1 抛错 → 503 reason 含错误信息', async () => {
      const pool = new FakePool();
      pool.throwOn = 'select1';
      setHealthDeps({ pool });

      const res = await health.request('/health/db');
      expect(res.status).toBe(503);
      const body = (await res.json()) as { status: string; reason: string };
      expect(body.reason).toContain('mysql connection refused');
    });
  });

  describe('/health/mcp', () => {
    it('mcpToolsFn 注入 + 7 工具齐全 → 200 UP + tools[7]', async () => {
      setHealthDeps({ mcpToolsFn: () => Promise.resolve(fullToolset()) });

      const res = await health.request('/health/mcp');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        tools: string[];
        whitelist: string[];
      };
      expect(body.status).toBe('UP');
      expect(body.tools).toHaveLength(7);
      expect(body.whitelist).toEqual([...TOOL_WHITELIST].sort());
    });

    it('白名单缺一项 → 503 reason 含 drift 提示', async () => {
      const tools = fullToolset();
      const firstTool = TOOL_WHITELIST[0];
      if (firstTool === undefined) throw new Error('TOOL_WHITELIST 不应为空');
      delete tools[firstTool];
      setHealthDeps({ mcpToolsFn: () => Promise.resolve(tools) });

      const res = await health.request('/health/mcp');
      expect(res.status).toBe(503);
      const body = (await res.json()) as { status: string; reason: string };
      expect(body.status).toBe('DOWN');
      expect(body.reason).toContain('whitelist drift');
    });

    it('mcpToolsFn 抛错 → 503 reason 含错误信息', async () => {
      setHealthDeps({
        mcpToolsFn: () => Promise.reject(new Error('mcp server unreachable')),
      });

      const res = await health.request('/health/mcp');
      expect(res.status).toBe(503);
      const body = (await res.json()) as { reason: string };
      expect(body.reason).toContain('mcp server unreachable');
    });
  });

  describe('/health/model', () => {
    it('未注入 modelPingFn → 503 reason="model ping not injected"（避免本地挂死）', async () => {
      const res = await health.request('/health/model');
      expect(res.status).toBe(503);
      const body = (await res.json()) as { status: string; reason: string };
      expect(body.reason).toBe('model ping not injected');
    });

    it('modelPingFn 注入 + 通过 → 200 UP', async () => {
      const ping = vi.fn().mockResolvedValue(undefined);
      setHealthDeps({ modelPingFn: ping });

      const res = await health.request('/health/model');
      expect(res.status).toBe(200);
      expect(ping).toHaveBeenCalledOnce();
    });

    it('modelPingFn 抛错 → 503 reason 含错误信息', async () => {
      setHealthDeps({
        modelPingFn: () => Promise.reject(new Error('LLM 502 Bad Gateway')),
      });

      const res = await health.request('/health/model');
      expect(res.status).toBe(503);
      const body = (await res.json()) as { reason: string };
      expect(body.reason).toContain('LLM 502 Bad Gateway');
    });
  });

  describe('/health/ready（聚合 db + mcp，不含 model）', () => {
    it('db UP + mcp UP → 200 UP', async () => {
      const pool = new FakePool();
      setHealthDeps({
        pool,
        mcpToolsFn: () => Promise.resolve(fullToolset()),
      });

      const res = await health.request('/health/ready');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        db: { status: string };
        mcp: { status: string };
      };
      expect(body.status).toBe('UP');
      expect(body.db.status).toBe('UP');
      expect(body.mcp.status).toBe('UP');
    });

    it('db DOWN → 503 + db.reason 透出，mcp UP 仍展示', async () => {
      const pool = new FakePool();
      pool.tableCount = 5;
      setHealthDeps({
        pool,
        mcpToolsFn: () => Promise.resolve(fullToolset()),
      });

      const res = await health.request('/health/ready');
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        status: string;
        db: { status: string; reason?: string };
        mcp: { status: string };
      };
      expect(body.status).toBe('DOWN');
      expect(body.db.status).toBe('DOWN');
      expect(body.db.reason).toContain('tables=5');
      expect(body.mcp.status).toBe('UP');
    });

    it('mcp DOWN → 503 + mcp.reason 透出', async () => {
      const pool = new FakePool();
      setHealthDeps({
        pool,
        mcpToolsFn: () => Promise.reject(new Error('mock-server down')),
      });

      const res = await health.request('/health/ready');
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        db: { status: string };
        mcp: { status: string; reason?: string };
      };
      expect(body.db.status).toBe('UP');
      expect(body.mcp.status).toBe('DOWN');
      expect(body.mcp.reason).toContain('mock-server down');
    });

    it('绝不调用 modelPingFn（任务卡 §7 MUST NOT §4：外网模型抖动让所有 pod 不可用）', async () => {
      const pool = new FakePool();
      const ping = vi.fn();
      setHealthDeps({
        pool,
        mcpToolsFn: () => Promise.resolve(fullToolset()),
        modelPingFn: ping,
      });

      await health.request('/health/ready');
      expect(ping).not.toHaveBeenCalled();
    });
  });

  describe('liveness 隔离 — readiness DOWN 时 /health 必须仍 UP', () => {
    it('db DOWN + mcp DOWN → /health/ready=503 / /health=200', async () => {
      const pool = new FakePool();
      pool.throwOn = 'select1';
      setHealthDeps({
        pool,
        mcpToolsFn: () => Promise.reject(new Error('mock-server down')),
      });

      const ready = await health.request('/health/ready');
      const live = await health.request('/health');

      expect(ready.status).toBe(503);
      expect(live.status).toBe(200);
      const liveBody = (await live.json()) as { status: string };
      expect(liveBody.status).toBe('UP');
    });
  });
});
