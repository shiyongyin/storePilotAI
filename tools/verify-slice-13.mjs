#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const checks = [];

function record(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`);
}

function run(name, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    stdio: options.live ? 'inherit' : 'pipe',
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  const ok = result.status === 0;
  record(name, ok, ok ? '' : output);
  if (!ok) throw new Error(`${name} failed`);
  return output;
}

function assertCheck(name, ok, detail = '') {
  record(name, ok, detail);
  if (!ok) throw new Error(`${name} failed`);
}

function checkNodeVersion() {
  const [, majorRaw, minorRaw] = process.version.match(/^v(\d+)\.(\d+)\./) ?? [];
  const major = Number(majorRaw);
  const minor = Number(minorRaw);
  const ok = major === 22 && minor >= 13;
  assertCheck('node engine >=22.13 <23', ok, process.version);
}

function readSource(path) {
  return readFileSync(`${root}/${path}`, 'utf8');
}

function checkShortTransactionBoundary() {
  const src = readSource('packages/agent-service/src/safety/draft-manager.ts');
  assertCheck(
    'draft-manager has no explicit long transaction',
    !/\b(BEGIN|START\s+TRANSACTION)\b/i.test(src),
    'no BEGIN / START TRANSACTION',
  );
  assertCheck(
    'draft-manager has no awaited LLM/MCP call',
    !/await.*(mcp|openai|anthropic|llm)/i.test(src),
    '0 matches',
  );
}

function checkServerInjectsDraftPool() {
  const src = readSource('packages/agent-service/src/server.ts');
  assertCheck(
    'server imports shared pool and DraftManager injector',
    src.includes('getOrCreateMysqlStoragePool') && src.includes('setDraftPool'),
  );
  assertCheck(
    'server injects DraftPool before expire-drafts cron starts',
    /const\s+storagePool\s*=\s*getOrCreateMysqlStoragePool\(env\)[\s\S]*setDraftPool\(storagePool\)[\s\S]*startExpireDraftsCron\(\)/.test(
      src,
    ),
  );
}

function parseLcovPercent(lcov, fileSuffix) {
  const record = lcov
    .split('end_of_record')
    .find((entry) => {
      const source = entry.match(/^SF:(.+)$/m)?.[1];
      return source === fileSuffix || source?.endsWith(`/${fileSuffix}`);
    });
  if (!record) return null;
  const lh = Number(record.match(/^LH:(\d+)$/m)?.[1] ?? NaN);
  const lf = Number(record.match(/^LF:(\d+)$/m)?.[1] ?? NaN);
  if (!Number.isFinite(lh) || !Number.isFinite(lf) || lf === 0) return null;
  return (lh / lf) * 100;
}

function checkCoverage() {
  run('slice13 coverage command', 'pnpm', [
    '--dir',
    'packages/agent-service',
    'exec',
    'vitest',
    'run',
    '--coverage',
    'src/safety/draft-manager.test.ts',
    'src/safety/jobs/expire-drafts.test.ts',
  ]);

  const lcov = readSource('packages/agent-service/coverage/lcov.info');
  const draftCoverage = parseLcovPercent(
    lcov,
    'src/safety/draft-manager.ts',
  );
  const jobCoverage = parseLcovPercent(
    lcov,
    'src/safety/jobs/expire-drafts.ts',
  );
  assertCheck(
    'draft-manager line coverage >=90%',
    draftCoverage !== null && draftCoverage >= 90,
    draftCoverage === null ? 'missing lcov record' : `${draftCoverage.toFixed(2)}%`,
  );
  assertCheck(
    'expire-drafts line coverage >=90%',
    jobCoverage !== null && jobCoverage >= 90,
    jobCoverage === null ? 'missing lcov record' : `${jobCoverage.toFixed(2)}%`,
  );
}

function checkExplainUsesTenantRecentIndex() {
  const host = process.env.SLICE13_MYSQL_HOST ?? '127.0.0.1';
  const port = process.env.SLICE13_MYSQL_PORT ?? '3306';
  const user = process.env.SLICE13_MYSQL_USER ?? 'root';
  const password = process.env.SLICE13_MYSQL_PASSWORD ?? 'rootpw';
  const database = process.env.SLICE13_MYSQL_DATABASE ?? 'store_pilot';
  const explainSql =
    "EXPLAIN SELECT * FROM replenishment_draft WHERE merchant_id='M' AND store_id='S' AND user_id='U' AND status IN ('DRAFT','WAIT_CONFIRM','CONFIRMED') AND created_at > NOW(3) - INTERVAL 5 MINUTE\\G";

  const out = run(
    'idx_draft_tenant_recent EXPLAIN',
    'mysql',
    ['--protocol=TCP', `-u${user}`, `-h${host}`, `-P${port}`, database, '-e', explainSql],
    { env: { MYSQL_PWD: password } },
  );
  assertCheck(
    'EXPLAIN key is idx_draft_tenant_recent',
    /key:\s+idx_draft_tenant_recent/.test(out),
  );
}

async function main() {
  try {
    checkNodeVersion();
    run('slice13 target tests', 'pnpm', [
      '--dir',
      'packages/agent-service',
      'exec',
      'vitest',
      'run',
      'src/safety/draft-manager.test.ts',
      'src/safety/jobs/expire-drafts.test.ts',
      'src/observability/server-tracing.test.ts',
    ]);
    checkCoverage();
    checkShortTransactionBoundary();
    checkServerInjectsDraftPool();
    checkExplainUsesTenantRecentIndex();
  } finally {
    const passed = checks.filter((c) => c.ok).length;
    const failed = checks.length - passed;
    console.log(`\nverify:slice13 summary: ${passed}/${checks.length} passed`);
    if (failed > 0) process.exitCode = 1;
  }
}

await main();
