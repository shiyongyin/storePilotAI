#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const checks = [];

function record(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`);
}

function run(name, command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  const ok = result.status === 0;
  record(name, ok, ok ? '' : output);
  if (!ok) throw new Error(`${name} failed`);
}

function assertCheck(name, ok, detail = '') {
  record(name, ok, detail);
  if (!ok) throw new Error(`${name} failed`);
}

function source(path) {
  return readFileSync(`${root}/${path}`, 'utf8');
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function stripImports(src) {
  return src.replace(/^import[\s\S]*?;\s*$/gm, '');
}

function checkWorkflowRedlines() {
  const src = stripComments(
    source('packages/agent-service/src/mastra/workflows/replenishment-forecast.ts'),
  );
  assertCheck(
    'workflow uses Mastra 1.x direct MCP input',
    /queryReplenishmentBaseData\.execute\s*\(\s*\{\s*merchantId[\s\S]*storeId[\s\S]*forecastDays/.test(
      src,
    ),
  );
  assertCheck(
    'workflow does not wrap MCP input in context',
    !/queryReplenishmentBaseData\.execute\s*\(\s*\{\s*context\s*:/.test(src),
  );
  assertCheck('workflow never calls createPurchaseOrder', !/\bcreatePurchaseOrder\b/.test(src));
  assertCheck(
    'workflow writes drafts only through DraftManager.create',
    /draftManager\.create\s*\(/.test(src) && !/\bINSERT\s+replenishment_draft\b/i.test(src),
  );
  assertCheck(
    'workflow passes numeric consistency flag to validateOutput',
    /enforceNumberConsistency:\s*env\.NUMBER_CONSISTENCY_CHECK_ENABLED/.test(src),
  );

  const dispatcherSrc = stripComments(
    source('packages/agent-service/src/api/business-report-dispatcher.ts'),
  );
  assertCheck(
    'dispatcher routes REPLENISHMENT_PLAN to slice14 workflow',
    /intent\s*===\s*Intent\.REPLENISHMENT_PLAN[\s\S]*replenishmentComputeStep[\s\S]*replenishmentPersistDraftStep/.test(
      dispatcherSrc,
    ),
  );
  assertCheck(
    'dispatcher allows later slice15 adjustment route without mixing it into slice14 route',
    /intent\s*===\s*Intent\.REPLENISHMENT_PLAN[\s\S]*replenishmentComputeStep[\s\S]*replenishmentPersistDraftStep[\s\S]*intent\s*===\s*Intent\.ADJUST_REPLENISHMENT_DRAFT/.test(
      dispatcherSrc,
    ) &&
      /intent\s*===\s*Intent\.ADJUST_REPLENISHMENT_DRAFT[\s\S]*adjustmentLoadActiveDraftStep[\s\S]*adjustmentPersistAdjustmentStep/.test(
        dispatcherSrc,
      ),
    'slice15 adjustment branch is separate and follows slice14 forecast branch',
  );
}

function checkCalculatorPurity() {
  const src = stripImports(
    stripComments(source('packages/agent-service/src/skills/replenishment/calculator.ts')),
  );
  assertCheck('calculator has no await', !/\bawait\b/.test(src));
  assertCheck('calculator has no network or LLM calls', !/\b(fetch|openai|mcp|require)\b/i.test(src));
  assertCheck('calculator has no Math.random', !/Math\.random\s*\(/.test(src));
}

function checkTaskCardCommands() {
  const src = source('docs/tanks/14-skill-replenishment-forecast.md');
  assertCheck('task card has no stale Vitest --grep command', !/\s--grep\s/.test(src));
  assertCheck(
    'task card points to workflow test file',
    src.includes('src/mastra/workflows/replenishment-forecast.workflow.test.ts'),
  );
}

async function main() {
  try {
    run('slice14 calculator + workflow tests', 'pnpm', [
      '--filter',
      '@storepilot/agent-service',
      'test',
      '--',
      'src/skills/replenishment/calculator.test.ts',
      'src/mastra/workflows/replenishment-forecast.test.ts',
      'src/mastra/workflows/replenishment-forecast.workflow.test.ts',
      'src/api/business-report-dispatcher.test.ts',
    ]);
    run('agent-service build', 'pnpm', ['--filter', '@storepilot/agent-service', 'build']);
    run('agent-service typecheck', 'pnpm', ['--filter', '@storepilot/agent-service', 'typecheck']);
    checkWorkflowRedlines();
    checkCalculatorPurity();
    checkTaskCardCommands();
  } finally {
    const passed = checks.filter((c) => c.ok).length;
    console.log(`\nverify:slice14 summary: ${passed}/${checks.length} passed`);
    if (passed !== checks.length) process.exitCode = 1;
  }
}

await main();
