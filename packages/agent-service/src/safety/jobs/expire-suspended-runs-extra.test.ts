/**
 * 切片 18 §8.6 — expire-suspended-runs 补充覆盖率测试
 *
 * 目标：覆盖 §8.5 cov-check safety/ 档剩余 6 条分支：
 *   - 168/185/205：catch (e) 走 String(e) fallback（throw 非 Error 对象）
 *   - DELETE / UPDATE 抛错时 swallow 不阻断后续行
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HITL_WORKFLOW_ID,
  type ConfirmManagerPool,
  type MastraResolver,
  resetConfirmManagerForTest,
  setConfirmManagerPool,
  setMastraResolver,
} from '../confirm-manager.js';

import { expireSuspendedRunsJob } from './expire-suspended-runs.js';

class FakePool implements ConfirmManagerPool {
  deleteShouldThrow: 'never' | 'string-error' | 'object-error' = 'never';
  updateShouldThrow: 'never' | 'string-error' | 'object-error' = 'never';
  rowsRemaining = 1;
  query<T extends Record<string, unknown>>(
    sql: string,
  ): Promise<[T[], unknown]> {
    if (sql.includes('FROM mastra_workflow_suspend')) {
      const out = this.rowsRemaining > 0
        ? [{ run_id: 'r1', step_id: 's1' }] as unknown as T[]
        : [] as T[];
      this.rowsRemaining = 0;
      return Promise.resolve([out, undefined]);
    }
    throw new Error('unexpected query');
  }
  execute(sql: string): Promise<[{ affectedRows: number }, unknown]> {
    if (sql.startsWith('DELETE FROM mastra_workflow_suspend')) {
      if (this.deleteShouldThrow === 'string-error') return Promise.reject('boom-string');
      if (this.deleteShouldThrow === 'object-error') return Promise.reject({ code: 42 });
      return Promise.resolve([{ affectedRows: 1 }, undefined]);
    }
    if (sql.startsWith('UPDATE agent_session')) {
      if (this.updateShouldThrow === 'string-error') return Promise.reject('boom-string');
      if (this.updateShouldThrow === 'object-error') return Promise.reject({ code: 9 });
      return Promise.resolve([{ affectedRows: 1 }, undefined]);
    }
    throw new Error('unexpected execute');
  }
  transaction<T>(): Promise<T> {
    throw new Error('not used in cron');
  }
}

class ResolverThrowingNonError implements MastraResolver {
  getWorkflow(workflowId: string) {
    if (workflowId !== HITL_WORKFLOW_ID) throw new Error('id mismatch');
    return {
      // 抛非 Error 对象 → 触发 String(e) fallback 分支
      // eslint-disable-next-line @typescript-eslint/no-throw-literal, @typescript-eslint/require-await
      resume: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'mastra-string-error';
      },
    };
  }
}

let pool: FakePool;
let mastra: ResolverThrowingNonError;

beforeEach(() => {
  pool = new FakePool();
  mastra = new ResolverThrowingNonError();
  setConfirmManagerPool(pool);
  setMastraResolver(mastra);
});

afterEach(() => {
  resetConfirmManagerForTest();
  vi.useRealTimers();
});

describe('expire-suspended-runs — String(e) fallback 分支', () => {
  it('mastra.resume 抛非 Error（字符串）→ swallow + resumeErrors+1', async () => {
    const result = await expireSuspendedRunsJob({ pool, mastraResolver: mastra });
    expect(result.resumeErrors).toBe(1);
    expect(result.totalProcessed).toBe(1);
  });

  it('DELETE suspend 抛字符串 → 仅 logger.warn，不阻断 totalProcessed', async () => {
    pool.rowsRemaining = 1;
    pool.deleteShouldThrow = 'string-error';
    const result = await expireSuspendedRunsJob({ pool, mastraResolver: mastra });
    expect(result.totalProcessed).toBe(1);
  });

  it('UPDATE agent_session 抛非 Error 对象 → 仅 logger.warn，不阻断 totalProcessed', async () => {
    pool.rowsRemaining = 1;
    pool.updateShouldThrow = 'object-error';
    const result = await expireSuspendedRunsJob({ pool, mastraResolver: mastra });
    expect(result.totalProcessed).toBe(1);
  });
});
