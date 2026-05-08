#!/usr/bin/env node
/**
 * Slice 16 verification gate.
 *
 * This script intentionally fails on skipped E2E / MySQL-backed checks. The
 * task card requires T-08..T-11 to be green, not silently skipped because the
 * database is unavailable.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const checks = [];

function pass(name, detail = '') {
  checks.push({ name, ok: true, detail });
  console.log(`PASS ${name}${detail ? ` - ${detail}` : ''}`);
}

function fail(name, detail) {
  checks.push({ name, ok: false, detail });
  console.error(`FAIL ${name} - ${detail}`);
}

function assert(name, condition, detail) {
  if (condition) pass(name, detail);
  else fail(name, detail);
}

function read(rel) {
  return readFileSync(path.join(root, rel), 'utf8');
}

function run(name, command, args, options = {}) {
  const child = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 1024 * 1024 * 20,
  });
  const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;
  if (child.error) {
    fail(name, child.error.message);
    return output;
  }
  if (child.status !== 0) {
    fail(name, `exit=${child.status}\n${tail(output)}`);
    return output;
  }
  if (options.disallowSkipped && hasSkipped(output)) {
    fail(name, `tests were skipped\n${tail(output)}`);
    return output;
  }
  pass(name, summarizeVitest(output));
  return output;
}

function hasSkipped(output) {
  return /\bskipped\b|↓ \|/.test(output);
}

function tail(output) {
  return output.split(/\r?\n/).slice(-30).join('\n');
}

function summarizeVitest(output) {
  const files = output.match(/Test Files\s+([^\n]+)/)?.[1]?.trim();
  const tests = output.match(/Tests\s+([^\n]+)/)?.[1]?.trim();
  if (files && tests) return `${files}; ${tests}`;
  return 'ok';
}

const server = read('packages/agent-service/src/server.ts');
const confirmManager = read('packages/agent-service/src/safety/confirm-manager.ts');
const expireJob = read('packages/agent-service/src/safety/jobs/expire-suspended-runs.ts');
const dispatcher = read('packages/agent-service/src/api/business-report-dispatcher.ts');

assert(
  'server injects ConfirmManager before expire-suspended cron',
  /setConfirmManagerPool\(asConfirmManagerPool\(storagePool\)\)[\s\S]*setMastraResolver\([\s\S]*createPurchaseOrderWorkflowHandle\(storagePool\)[\s\S]*\)[\s\S]*startExpireSuspendedRunsCron\(\)/.test(
    server,
  ),
  'setConfirmManagerPool + purchase_order_create resolver precede startExpireSuspendedRunsCron',
);

assert(
  'server injects HITL hook before dispatcher',
  /setHitlPreDispatchHook\([\s\S]*tickAtUserMessage[\s\S]*setDispatcher\(createBusinessReportDispatcher\(\)\)/.test(
    server,
  ),
  'tickAtUserMessage hook precedes setDispatcher',
);

assert(
  'server sets dispatcher once',
  (server.match(/setDispatcher\(createBusinessReportDispatcher\(\)\)/g) ?? []).length === 1,
  'exactly one production setDispatcher(createBusinessReportDispatcher())',
);

assert(
  'confirm-manager exports three public methods',
  /export async function tickAtUserMessage/.test(confirmManager) &&
    /export async function confirmDraft/.test(confirmManager) &&
    /export async function cancelInflight/.test(confirmManager),
  'tickAtUserMessage / confirmDraft / cancelInflight',
);

assert(
  'confirmDraft uses DraftManager recent fallback',
  /findRecentDraft\(args\.runtimeContext,\s*5\)/.test(confirmManager),
  'findRecentDraft(runtimeContext, 5)',
);

const transactionStart = confirmManager.indexOf('pool.transaction<SessionView>');
const transactionEnd = confirmManager.indexOf('const runId = lockedSession.activeRunId');
const transactionBlock =
  transactionStart >= 0 && transactionEnd > transactionStart
    ? confirmManager.slice(transactionStart, transactionEnd)
    : '';
assert(
  'confirmDraft does not resume inside transaction block',
  transactionBlock.length > 0 &&
    !/workflow\.resume|getWorkflow\(/.test(transactionBlock) &&
    /FOR UPDATE/.test(transactionBlock) &&
    /resume_locked_at = NOW\(3\)/.test(transactionBlock),
  'FOR UPDATE + lock write before workflow.resume',
);

assert(
  'confirmDraft releases resume lock in finally',
  /finally\s*\{[\s\S]*resume_locked_at = NULL[\s\S]*WHERE session_id = \?/.test(confirmManager),
  'UPDATE resume_locked_at = NULL in finally',
);

assert(
  'expire-suspended-runs batches by 200 with SKIP LOCKED',
  /EXPIRE_SUSPENDED_BATCH_LIMIT\s*=\s*200/.test(expireJob) &&
    /LIMIT \?[\s\S]*FOR UPDATE SKIP LOCKED/.test(expireJob),
  'LIMIT ? parameterized with EXPIRE_SUSPENDED_BATCH_LIMIT=200 and SKIP LOCKED',
);

assert(
  'expire-suspended-runs default interval is 5 minutes',
  /EXPIRE_SUSPENDED_DEFAULT_INTERVAL_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/.test(expireJob),
  '5 * 60 * 1000',
);

assert(
  'dispatcher covers 11 IntentEnum cases',
  [
    'BUSINESS_DAILY_REPORT',
    'BUSINESS_MONTHLY_REPORT',
    'GENERAL_QA',
    'EXPLAIN_METRIC',
    'COLLECT_REQUIREMENT',
    'CANCEL_REPLENISHMENT_DRAFT',
    'CONFIRM_CREATE_PURCHASE_ORDER',
    'REPLENISHMENT_PLAN',
    'ADJUST_REPLENISHMENT_DRAFT',
    'MULTI_INTENT',
  ].every((name) => dispatcher.includes(`Intent.${name}`)) &&
    /INTENT_LOW_CONFIDENCE/.test(dispatcher),
  '10 explicit branches plus UNKNOWN fallback',
);

assert(
  'no duplicate dispatch-by-intent implementation',
  !existsSync(path.join(root, 'packages/agent-service/src/api/dispatch-by-intent.ts')) &&
    readdirSync(path.join(root, 'packages/agent-service/src/api')).filter((name) =>
      /dispatch.*\.ts$|dispatcher.*\.ts$/.test(name),
    ).length === 2,
  'business-report-dispatcher.ts plus test only',
);

run('agent-service typecheck', 'pnpm', ['--filter', '@storepilot/agent-service', 'typecheck']);

run(
  'slice16 integration suite',
  'pnpm',
  [
    'test:integration',
    '--',
    'packages/agent-service/src/observability/server-tracing.test.ts',
    'packages/agent-service/src/mastra/storage/sql.test.ts',
    'packages/agent-service/src/safety/confirm-manager.test.ts',
    'packages/agent-service/src/safety/jobs/expire-suspended-runs.test.ts',
    'packages/agent-service/src/safety/jobs/expire-suspended-runs-extra.test.ts',
    'packages/agent-service/src/api/chat-completions.test.ts',
    'packages/agent-service/src/api/business-report-dispatcher.test.ts',
  ],
  { disallowSkipped: true },
);

run(
  'HITL E2E T-08..T-11',
  'pnpm',
  ['test:e2e', '--', 'T-08', 'T-09', 'T-10', 'T-11'],
  { disallowSkipped: true },
);

const passed = checks.filter((check) => check.ok).length;
const failed = checks.length - passed;
console.log(`verify:slice16 summary: ${passed}/${checks.length} passed`);
if (failed > 0) {
  process.exit(1);
}
