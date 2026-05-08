import { BizError } from '@storepilot/shared-contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MysqlStoragePool } from '../storage/sql.js';
import { buildRuntimeContext } from '../runtime-context.js';

const stepMocks = vi.hoisted(() => ({
  previewExecute: vi.fn(),
  askConfirmExecute: vi.fn(),
  createPoExecute: vi.fn(),
}));

vi.mock('./purchase-order-create.js', () => ({
  previewStep: { execute: stepMocks.previewExecute },
  askConfirmStep: { execute: stepMocks.askConfirmExecute },
  createPoStep: { execute: stepMocks.createPoExecute },
}));

import {
  createPurchaseOrderStarter,
  createPurchaseOrderWorkflowHandle,
} from './purchase-order-hitl-runtime.js';

const runtimeContext = buildRuntimeContext({
  traceId: 'trace_runtime',
  sessionId: 'sess_runtime',
  merchantId: 'M-1',
  storeId: 'S-1',
  userId: 'U-1',
  apiKeyPrefix: 'sk-agent-test',
  requestStartedAt: 0,
});

const previewPayload = {
  draftId: 'drf_aaaaaaaaaaaaaaaaaaaaaaaa',
  itemCount: 2,
  totalQty: 60,
  previewMarkdown: '# 采购单确认\n...',
};

class FakePool implements MysqlStoragePool {
  rows: Array<{ step_id: string; payload_json: unknown }> = [];
  queries: Array<{ sql: string; params: readonly unknown[] }> = [];

  query<T extends Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<[T[], unknown]> {
    this.queries.push({ sql, params });
    return Promise.resolve([this.rows as unknown as T[], undefined]);
  }

  execute(): Promise<[{ affectedRows: number }, unknown]> {
    throw new Error('not used');
  }

  end(): Promise<void> {
    return Promise.resolve();
  }
}

beforeEach(() => {
  stepMocks.previewExecute.mockReset();
  stepMocks.askConfirmExecute.mockReset();
  stepMocks.createPoExecute.mockReset();
});

describe('purchase-order-hitl-runtime', () => {
  it('startPreview 执行 previewStep 并返回 ask-confirm suspend payload', async () => {
    stepMocks.previewExecute.mockResolvedValue(previewPayload);

    const starter = createPurchaseOrderStarter();
    const result = await starter.startPreview({
      draftId: previewPayload.draftId,
      runtimeContext,
    });

    expect(result.runId).toMatch(/^run_po_[0-9a-f]{24}$/);
    expect(result.step).toBe('ask-confirm');
    expect(result.previewMarkdown).toBe(previewPayload.previewMarkdown);
    expect(result.suspendPayload).toEqual(previewPayload);
    expect(stepMocks.previewExecute).toHaveBeenCalledWith({
      inputData: { draftId: previewPayload.draftId },
      requestContext: runtimeContext,
    });
  });

  it('resume 读取 JSON suspend payload，执行 askConfirmStep 后继续 createPoStep', async () => {
    const pool = new FakePool();
    pool.rows = [{ step_id: 'ask-confirm', payload_json: JSON.stringify(previewPayload) }];
    const resumedPayload = { ...previewPayload, totalQty: 61 };
    const poResult = { purchaseOrderNo: 'PO_1', createdAt: '2026-05-08T00:00:00.000Z' };
    stepMocks.askConfirmExecute.mockResolvedValue(resumedPayload);
    stepMocks.createPoExecute.mockResolvedValue(poResult);

    const handle = createPurchaseOrderWorkflowHandle(pool);
    const result = await handle.resume({
      runId: 'run_po_1',
      step: 'ask-confirm',
      resumeData: { decision: 'CONFIRM' },
      runtimeContext,
    });

    expect(result).toEqual(poResult);
    expect(pool.queries[0]?.params).toEqual(['run_po_1', 'ask-confirm']);
    expect(stepMocks.askConfirmExecute).toHaveBeenCalledOnce();
    const askConfirmArgs = stepMocks.askConfirmExecute.mock.calls[0]?.[0] as
      | {
          inputData: unknown;
          resumeData: unknown;
          requestContext: unknown;
          suspend: unknown;
        }
      | undefined;
    expect(askConfirmArgs).toMatchObject({
      inputData: previewPayload,
      resumeData: { decision: 'CONFIRM' },
      requestContext: runtimeContext,
    });
    expect(typeof askConfirmArgs?.suspend).toBe('function');
    expect(stepMocks.createPoExecute).toHaveBeenCalledWith({
      inputData: resumedPayload,
      requestContext: runtimeContext,
    });
  });

  it('resume 找不到 suspend payload 时抛 SUSPEND_NOT_FOUND', async () => {
    const pool = new FakePool();
    const handle = createPurchaseOrderWorkflowHandle(pool);

    const caught = await handle
      .resume({
        runId: 'run_missing',
        step: 'ask-confirm',
        resumeData: { decision: 'CONFIRM' },
        runtimeContext,
      })
      .catch((err: unknown) => err);

    expect(caught).toBeInstanceOf(BizError);
    expect((caught as BizError).code).toBe('SUSPEND_NOT_FOUND');
  });

  it('resume 遇到非法 JSON suspend payload 时抛 SCHEMA_FAIL', async () => {
    const pool = new FakePool();
    pool.rows = [{ step_id: 'ask-confirm', payload_json: 'not-json' }];
    const handle = createPurchaseOrderWorkflowHandle(pool);

    const caught = await handle
      .resume({
        runId: 'run_bad_json',
        step: 'ask-confirm',
        resumeData: { decision: 'CONFIRM' },
        runtimeContext,
      })
      .catch((err: unknown) => err);

    expect(caught).toBeInstanceOf(BizError);
    expect((caught as BizError).code).toBe('SCHEMA_FAIL');
  });

  it('resume 遇到结构非法的 suspend payload 时抛 SCHEMA_FAIL', async () => {
    const pool = new FakePool();
    pool.rows = [{ step_id: 'ask-confirm', payload_json: { draftId: previewPayload.draftId } }];
    const handle = createPurchaseOrderWorkflowHandle(pool);

    const caught = await handle
      .resume({
        runId: 'run_bad_shape',
        step: 'ask-confirm',
        resumeData: { decision: 'CONFIRM' },
        runtimeContext,
      })
      .catch((err: unknown) => err);

    expect(caught).toBeInstanceOf(BizError);
    expect((caught as BizError).code).toBe('SCHEMA_FAIL');
  });
});
