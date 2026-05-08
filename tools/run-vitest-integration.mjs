#!/usr/bin/env node
/**
 * Thin wrapper for `pnpm test:integration -- <filter>`.
 *
 * pnpm forwards the literal `--` to lifecycle scripts in this workspace. Vitest
 * treats that token as option terminator and ignores following file filters, so
 * this wrapper strips only the separator token and preserves the actual filter.
 */
import { spawnSync } from 'node:child_process';

const aliases = new Map([
  [
    'skills/purchase-order-create',
    [
      'packages/agent-service/src/mastra/workflows/purchase-order-create.test.ts',
      'packages/agent-service/src/safety/jobs/compensate-mark-submitted.test.ts',
      'packages/agent-service/src/safety/confirm-manager.test.ts',
      'packages/agent-service/src/safety/jobs/expire-suspended-runs.test.ts',
      'packages/agent-service/src/skills/replenishment/compose-po-preview.test.ts',
    ],
  ],
  [
    'skills/replenishment/assert-draft-can-create-po',
    ['packages/agent-service/src/skills/replenishment/assert-draft-can-create-po.test.ts'],
  ],
]);

const args = [];
const rawArgs = process.argv.slice(2).filter((arg) => arg !== '--');
for (let i = 0; i < rawArgs.length; i += 1) {
  const arg = rawArgs[i];
  if (arg === '--grep') {
    const pattern = normalizePattern(rawArgs[i + 1]);
    if (pattern) {
      args.push('-t', pattern);
      i += 1;
    }
    continue;
  }
  const mapped = aliases.get(arg);
  if (mapped) {
    args.push(...mapped);
    continue;
  }
  args.push(arg);
}
const child = spawnSync('vitest', ['run', ...args], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (child.error) {
  console.error(child.error);
  process.exit(1);
}

process.exit(child.status ?? 1);

function normalizePattern(pattern) {
  if (!pattern) return pattern;
  if (pattern === 'intent') return '[iI]ntent|意图|isHitl';
  if (pattern === 'preview') return '[pP]review|composePoPreview|完整';
  return pattern;
}
