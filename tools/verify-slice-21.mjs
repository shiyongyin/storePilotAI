#!/usr/bin/env node
/**
 * Slice 21 repository-local verification gate.
 *
 * This covers the parts of the grayscale / rollback / V2 cutover design that
 * can be verified inside this repository. Real V2 ERP cutover still requires
 * `pnpm test:e2e:v2` with explicit external endpoints.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

function assertCheck(name, condition, detail = '') {
  if (condition) pass(name, detail);
  else fail(name, detail || 'assertion failed');
}

function hasTableRowNumber(markdown, value) {
  return new RegExp(String.raw`^\|\s*${value}\s*\|`, 'm').test(markdown);
}

function read(rel) {
  return readFileSync(path.join(root, rel), 'utf8');
}

function exists(rel) {
  return existsSync(path.join(root, rel));
}

function run(name, command, args) {
  const child = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 1024 * 1024 * 30,
  });
  const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;
  if (child.error) {
    fail(name, child.error.message);
    return;
  }
  if (child.status !== 0) {
    fail(name, `exit=${child.status}\n${tail(output)}`);
    return;
  }
  pass(name, summarize(output));
}

function tail(output) {
  return output.split(/\r?\n/).slice(-30).join('\n');
}

function summarize(output) {
  const files = output.match(/Test Files\s+([^\n]+)/)?.[1]?.trim();
  const tests = output.match(/Tests\s+([^\n]+)/)?.[1]?.trim();
  if (files && tests) return `${files}; ${tests}`;
  return 'ok';
}

function checkRunbooks() {
  const files = [
    'deploy/runbook/03-grayscale-release.md',
    'deploy/runbook/04-rollback.md',
    'deploy/runbook/05-v2-erp-cutover.md',
    'deploy/runbook/06-onboard-new-customer.md',
  ];
  for (const file of files) assertCheck(`${file} exists`, exists(file));

  const gray = read('deploy/runbook/03-grayscale-release.md');
  assertCheck(
    'grayscale runbook has 6 stages, 24h observation, wrong-PO redline',
    [1, 2, 3, 4, 5, 6].every((stage) => hasTableRowNumber(gray, stage)) &&
      /≥ 24h/.test(gray) &&
      /误提单 = 0/.test(gray) &&
      /立即[\s\S]{0,80}回滚/.test(gray),
  );

  const rollback = read('deploy/runbook/04-rollback.md');
  assertCheck(
    'rollback runbook covers service, Skill, strategy, and no programmatic PO rollback',
    /服务回滚/.test(rollback) &&
      /Skill 回滚/.test(rollback) &&
      /策略回滚/.test(rollback) &&
      /strategy_invalidation/.test(rollback) &&
      /不得[\s\S]{0,80}程序化撤销/.test(rollback),
  );

  const cutover = read('deploy/runbook/05-v2-erp-cutover.md');
  assertCheck(
    'V2 cutover runbook has five checks, explicit V2 dry-run, and zero-code env switch',
    /5 项检查/.test(cutover) &&
      /tools\/list/.test(cutover) &&
      /source_draft_id/.test(cutover) &&
      /pnpm test:e2e:v2/.test(cutover) &&
      /V2_MCP_URL/.test(cutover) &&
      /V2_AGENT_BASE_URL/.test(cutover) &&
      /默认 pnpm test:e2e 是本地 \/ 进程内 fixture 回归/.test(cutover) &&
      /零代码改动/.test(cutover) &&
      /ERP_MCP_SERVER_URL/.test(cutover),
  );

  const onboard = read('deploy/runbook/06-onboard-new-customer.md');
  assertCheck(
    'onboard runbook covers API key, seed-strategy, monitoring, and zero deploy',
    /pnpm issue:apikey/.test(onboard) &&
      /tools\/seed-strategy/.test(onboard) &&
      /agent_runlog/.test(onboard) &&
      /零应用部署/.test(onboard) &&
      /30 分钟/.test(onboard),
  );
}

function checkSkillSeedAndRegistry() {
  const seed = read('migrations/011-seed-agent-skill-def.sql');
  const expectedRows = [
    ["'business_daily_report'", "'LOW'", "'enabled'"],
    ["'business_monthly_report'", "'LOW'", "'enabled'"],
    ["'replenishment_forecast'", "'MEDIUM'", "'enabled'"],
    ["'replenishment_adjustment'", "'MEDIUM'", "'enabled'"],
    ["'purchase_order_create'", "'HIGH'", "'gray'"],
  ];
  for (const [skill, risk, status] of expectedRows) {
    assertCheck(`skill seed ${skill}`, seed.includes(skill) && seed.includes(risk) && seed.includes(status));
  }
  assertCheck('skill seed is idempotent', /ON DUPLICATE KEY UPDATE/.test(seed));

  const registry = read('packages/agent-service/src/mastra/agents/skill-registry.ts');
  assertCheck(
    'SkillRegistry verifies DB rows against workflow ids',
    /collectWorkflowIds/.test(registry) &&
      /SELECT skill_code, status, risk_level, version/.test(registry) &&
      /missing/.test(registry) &&
      /extra/.test(registry) &&
      /disabledRequired/.test(registry),
  );
  assertCheck(
    'SkillRegistry enforces gray whitelist and disabled gate',
    /GRAY_MERCHANT_WHITELIST/.test(registry) &&
      /SKILL_NOT_AVAILABLE/.test(registry) &&
      /status === 'disabled'/.test(registry) &&
      /status === 'gray'/.test(registry),
  );
  assertCheck(
    'cancel intent is not blocked by purchase order gray gate',
    /CONFIRM_CREATE_PURCHASE_ORDER:\s*'purchase_order_create'/.test(registry) &&
      !/CANCEL_REPLENISHMENT_DRAFT:\s*'purchase_order_create'/.test(registry),
  );

  const server = read('packages/agent-service/src/server.ts');
  assertCheck(
    'server runs verifySkillDef after MCP whitelist and before serving traffic',
    /await verifyMcpToolsAtStartup\(\)[\s\S]*await verifySkillDef\(storagePool\)[\s\S]*setAuthPool\(storagePool\)/.test(
      server,
    ),
  );
}

function checkScripts() {
  const pkg = JSON.parse(read('package.json'));
  assertCheck('root script verify:slice21 exists', pkg.scripts?.['verify:slice21'] === 'node tools/verify-slice-21.mjs');
  assertCheck(
    'root script test:e2e:v2 requires explicit V2 dry-run',
    typeof pkg.scripts?.['test:e2e:v2'] === 'string' &&
      pkg.scripts['test:e2e:v2'].includes('verify-v2-mcp.mjs') &&
      pkg.scripts['test:e2e:v2'].includes('--require-agent-health'),
  );

  const v2 = read('tools/verify-v2-mcp.mjs');
  assertCheck(
    'V2 dry-run script requires explicit endpoints and avoids false green',
    /V2_MCP_URL/.test(v2) &&
      /MCP_TENANT_SHARED_SECRET/.test(v2) &&
      /V2_AGENT_BASE_URL/.test(v2) &&
      /--require-agent-health/.test(v2) &&
      /intentionally not runnable without explicit external endpoints/.test(v2),
  );
}

checkRunbooks();
checkSkillSeedAndRegistry();
checkScripts();

run('skill-registry and dispatcher tests', 'pnpm', [
  '--filter',
  '@storepilot/agent-service',
  'test',
  '--',
  'src/mastra/agents/skill-registry.test.ts',
  'src/api/business-report-dispatcher.test.ts',
]);
run('seed-strategy tests', 'pnpm', ['--filter', '@storepilot/tools-seed-strategy', 'test']);
run('seed-strategy typecheck', 'pnpm', ['--filter', '@storepilot/tools-seed-strategy', 'typecheck']);

const failed = checks.filter((check) => !check.ok);
if (failed.length > 0) {
  console.error(`verify:slice21 failed: ${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`verify:slice21 passed: ${checks.length}/${checks.length} checks passed`);
