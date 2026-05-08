import { randomBytes } from 'node:crypto';

import { BizError } from '@storepilot/shared-contracts';

import type {
  PurchaseOrderStarter,
  StartPurchaseOrderPreviewArgs,
  StartPurchaseOrderPreviewResult,
  WorkflowHandle,
  WorkflowResumeArgs,
} from '../../safety/confirm-manager.js';
import type { MysqlStoragePool } from '../storage/sql.js';

import {
  askConfirmStep,
  createPoStep,
  previewStep,
} from './purchase-order-create.js';

const ASK_CONFIRM_STEP_ID = 'ask-confirm';

interface StepExecutor<T> {
  execute(args: Record<string, unknown>): Promise<T>;
}

interface PreviewData {
  draftId: string;
  itemCount: number;
  totalQty: number;
  previewMarkdown: string;
}

interface SuspendRow extends Record<string, unknown> {
  step_id: string;
  payload_json: unknown;
}

export function createPurchaseOrderStarter(): PurchaseOrderStarter {
  return {
    startPreview: async (
      args: StartPurchaseOrderPreviewArgs,
    ): Promise<StartPurchaseOrderPreviewResult> => {
      const preview = await executeStep<PreviewData>(previewStep, {
        inputData: { draftId: args.draftId },
        requestContext: args.runtimeContext,
      });
      return {
        runId: newPurchaseOrderRunId(),
        step: ASK_CONFIRM_STEP_ID,
        previewMarkdown: preview.previewMarkdown,
        suspendPayload: preview,
      };
    },
  };
}

export function createPurchaseOrderWorkflowHandle(pool: MysqlStoragePool): WorkflowHandle {
  return {
    resume: async (args: WorkflowResumeArgs): Promise<unknown> => {
      const loaded = await loadSuspendPayload(pool, args.runId, args.step);
      const resumed = await executeStep<PreviewData>(askConfirmStep, {
        inputData: loaded.payload,
        resumeData: args.resumeData,
        requestContext: args.runtimeContext,
        suspend: () => Promise.resolve(undefined),
      });
      return await executeStep<unknown>(createPoStep, {
        inputData: resumed,
        requestContext: args.runtimeContext,
      });
    },
  };
}

async function loadSuspendPayload(
  pool: MysqlStoragePool,
  runId: string,
  stepId: string,
): Promise<{ stepId: string; payload: PreviewData }> {
  const [rows] = await pool.query<SuspendRow>(
    `SELECT step_id, payload_json
       FROM mastra_workflow_suspend
      WHERE run_id = ? AND step_id = ?
      LIMIT 1`,
    [runId, stepId],
  );
  const row = rows[0];
  if (!row) {
    throw new BizError('SUSPEND_NOT_FOUND', '未找到待确认采购单预览', {
      meta: { runId, stepId },
    });
  }
  const payload = parsePreviewPayload(row.payload_json);
  return { stepId: row.step_id, payload };
}

async function executeStep<T>(step: unknown, args: Record<string, unknown>): Promise<T> {
  return await (step as StepExecutor<T>).execute(args);
}

function parsePreviewPayload(raw: unknown): PreviewData {
  const parsed = parseJsonColumn(raw);
  if (!isPreviewData(parsed)) {
    throw new BizError('SCHEMA_FAIL', '采购单预览挂起载荷结构非法', {
      meta: { payloadType: typeof parsed },
    });
  }
  return parsed;
}

function parseJsonColumn(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as unknown;
    } catch (cause) {
      throw new BizError('SCHEMA_FAIL', '采购单预览挂起载荷不是合法 JSON', {
        cause,
      });
    }
  }
  return raw;
}

function isPreviewData(value: unknown): value is PreviewData {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.draftId === 'string' &&
    Number.isInteger(record.itemCount) &&
    Number.isInteger(record.totalQty) &&
    typeof record.previewMarkdown === 'string'
  );
}

function newPurchaseOrderRunId(): string {
  return `run_po_${randomBytes(12).toString('hex')}`;
}
