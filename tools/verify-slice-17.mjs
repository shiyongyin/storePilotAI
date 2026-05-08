#!/usr/bin/env node
/**
 * Slice 17 verification gate.
 *
 * The task card requires the HITL purchase-order path to be executable, not
 * silently skipped when MySQL is unavailable. This gate combines static
 * redline checks, focused unit/integration tests, and the six HITL E2E cases.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

function assertCheck(name, condition, detail) {
  if (condition) pass(name, detail);
  else fail(name, detail);
}

function read(rel) {
  return readFileSync(path.join(root, rel), 'utf8');
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function run(name, command, args, options = {}) {
  const child = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 1024 * 1024 * 30,
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
  return output.split(/\r?\n/).slice(-35).join('\n');
}

function summarizeVitest(output) {
  const files = output.match(/Test Files\s+([^\n]+)/)?.[1]?.trim();
  const tests = output.match(/Tests\s+([^\n]+)/)?.[1]?.trim();
  if (files && tests) return `${files}; ${tests}`;
  return 'ok';
}

const workflow = read('packages/agent-service/src/mastra/workflows/purchase-order-create.ts');
const workflowNoComments = stripComments(workflow);
const compensation = read('packages/agent-service/src/safety/jobs/compensate-mark-submitted.ts');
const compensationNoComments = stripComments(compensation);
const composePreview = read('packages/agent-service/src/skills/replenishment/compose-po-preview.ts');
const assertDraft = read('packages/agent-service/src/skills/replenishment/assert-draft-can-create-po.ts');
const workflowIndex = read('packages/agent-service/src/mastra/workflows/index.ts');
const server = read('packages/agent-service/src/server.ts');
const dispatcher = read('packages/agent-service/src/api/business-report-dispatcher.ts');

assertCheck(
  'workflow has preview, askConfirm, createPo steps',
  /previewStep[\s\S]*askConfirmStep[\s\S]*createPoStep/.test(workflow),
  '3-step HITL pipeline',
);

assertCheck(
  'askConfirmStep declares suspend/resume schemas',
  /suspendSchema:\s*PreviewSchema/.test(workflow) &&
    /resumeSchema:\s*ResumeSchema/.test(workflow) &&
    /await\s+suspend\(inputData\)/.test(workflow),
  'PreviewSchema + ResumeSchema + suspend(inputData)',
);

assertCheck(
  'cancel resume throws USER_CANCELLED',
  /resumeData\.decision\s*!==\s*'CONFIRM'[\s\S]*USER_CANCELLED/.test(workflow),
  'decision != CONFIRM maps to USER_CANCELLED',
);

assertCheck(
  'createPoStep repeats assertDraftCanCreatePo before ERP write',
  /const draft = await draftManager\.getByIdStrict[\s\S]*assertDraftCanCreatePo\(draft\)[\s\S]*createPurchaseOrder\.execute/.test(
    workflow,
  ),
  'race re-check before createPurchaseOrder',
);

assertCheck(
  'workflow uses Mastra 1.x direct MCP input',
  /createPurchaseOrder\.execute\s*\(\s*\{\s*merchantId:[\s\S]*sourceDraftId:\s*draft\.draftId[\s\S]*idempotencyKey:\s*draft\.draftId/.test(
    workflowNoComments,
  ),
  'execute({ merchantId, storeId, sourceDraftId, idempotencyKey, items })',
);

assertCheck(
  'workflow never wraps createPurchaseOrder input in context',
  !/createPurchaseOrder\.execute\s*\(\s*\{\s*context\s*:/.test(workflowNoComments),
  'no Mastra 0.x context wrapper',
);

assertCheck(
  'workflow maps PO items from draft.items',
  /items:\s*draft\.items\.map\(\(it\)\s*=>\s*\(\{[\s\S]*quantity:\s*it\.finalSuggestQty/.test(
    workflowNoComments,
  ),
  'structured draft items only',
);

const createPoBlock =
  workflowNoComments.match(/export const createPoStep[\s\S]*?export const purchaseOrderCreate/)?.[0] ??
  '';
assertCheck(
  'createPoStep has no markdown reverse parsing',
  !/\b(summaryMarkdown|parseMarkdown)\b/.test(createPoBlock),
  'R-PO-003 redline',
);

assertCheck(
  'markSubmitted happens only after ERP result',
  /const result = await tools\.createPurchaseOrder\.execute[\s\S]*draftManager\.markSubmitted\(draft\.draftId,\s*result\.purchaseOrderNo/.test(
    workflowNoComments,
  ),
  'ERP success precedes markSubmitted',
);

assertCheck(
  'markSubmitted failure is logged and not rethrown',
  /catch\s*\(e\)\s*\{[\s\S]*logger\.error[\s\S]*compensate job will retry[\s\S]*\}/.test(
    workflow,
  ),
  'compensation job owns retry',
);

assertCheck(
  'assertDraftCanCreatePo covers core preconditions',
  /WAIT_CONFIRM[\s\S]*CONFIRMED/.test(assertDraft) &&
    /items\.length\s*===\s*0/.test(assertDraft) &&
    /finalSuggestQty\s*<\s*0/.test(assertDraft) &&
    /submittedPoNo/.test(assertDraft) &&
    /DRAFT_EXPIRED/.test(assertDraft),
  'status, non-empty items, non-negative qty, already submitted, expired',
);

assertCheck(
  'preview includes complete SKU list and totals',
  /itemCount/.test(composePreview) &&
    /totalQty/.test(composePreview) &&
    /uniqueUnits\.size/.test(composePreview) &&
    /影响 SKU/.test(composePreview) &&
    !/slice\(0/.test(composePreview),
  'itemCount + totalQty + unique unit count + full SKU list',
);

assertCheck(
  'compensation job scans confirmed pending drafts with 30s grace and limit 100',
  /status\s*=\s*'CONFIRMED'/.test(compensation) &&
    /submitted_po_no\s+IS\s+NULL/.test(compensation) &&
    /INTERVAL 30 SECOND/.test(compensation) &&
    /LIMIT 100/.test(compensation),
  'CONFIRMED + submitted_po_no IS NULL + 30s + LIMIT 100',
);

assertCheck(
  'compensation job uses direct MCP input with idempotent draft id',
  /createPurchaseOrder\.execute\s*\(\s*\{[\s\S]*sourceDraftId:\s*row\.draft_id[\s\S]*idempotencyKey:\s*row\.draft_id/.test(
    compensationNoComments,
  ) && !/createPurchaseOrder\.execute\s*\(\s*\{\s*context\s*:/.test(compensationNoComments),
  'row.draft_id drives sourceDraftId and idempotencyKey',
);

assertCheck(
  'workflow is registered under purchase_order_create key',
  /purchaseOrderCreate\s+as\s+purchase_order_create/.test(workflowIndex),
  'ConfirmManager HITL_WORKFLOW_ID-compatible key',
);

assertCheck(
  'server starts markSubmitted compensation cron',
  /startCompensateMarkSubmittedCron\(\)/.test(server),
  'cron registered at bootstrap',
);

assertCheck(
  'dispatcher confirm/cancel routes through ConfirmManager',
  /Intent\.CANCEL_REPLENISHMENT_DRAFT[\s\S]*cancelInflight/.test(dispatcher) &&
    /Intent\.CONFIRM_CREATE_PURCHASE_ORDER[\s\S]*confirmDraft/.test(dispatcher),
  'cancelInflight + confirmDraft',
);

run('agent-service lint', 'pnpm', ['--filter', '@storepilot/agent-service', 'lint']);
run('agent-service typecheck', 'pnpm', ['--filter', '@storepilot/agent-service', 'typecheck']);
run('workspace consistency', 'pnpm', ['check:consistency']);

run('slice17 focused unit tests', 'pnpm', [
  'test',
  '--',
  'packages/agent-service/src/mastra/workflows/purchase-order-create.test.ts',
  'packages/agent-service/src/skills/replenishment/assert-draft-can-create-po.test.ts',
  'packages/agent-service/src/skills/replenishment/compose-po-preview.test.ts',
  'packages/agent-service/src/safety/jobs/compensate-mark-submitted.test.ts',
  'packages/agent-service/src/safety/jobs/compensate-mark-submitted-extra.test.ts',
]);

run('slice17 integration alias', 'pnpm', [
  'test:integration',
  '--',
  'skills/purchase-order-create',
]);

for (const e2eCase of [
  'T-08-po-suspend',
  'T-09-po-resume-confirm',
  'T-10-po-resume-cancel',
  'T-11-po-idempotent',
  'T-19-suspend-expired',
  'T-20-multi-instance-resume',
]) {
  run(`slice17 e2e ${e2eCase}`, 'pnpm', ['test:e2e', '--', e2eCase], {
    disallowSkipped: true,
  });
}

const passed = checks.filter((check) => check.ok).length;
const failed = checks.length - passed;
console.log(`verify:slice17 summary: ${passed}/${checks.length} passed`);
if (failed > 0) {
  process.exit(1);
}
