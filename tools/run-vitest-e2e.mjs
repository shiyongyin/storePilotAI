#!/usr/bin/env node
/**
 * 切片 19 — 全栈 E2E 测试入口（HTTP + 真实 MySQL + 进程内 MCP mock）
 *
 * 真正的 20 个 T-01..T-20 文件位于
 *   packages/agent-service/tests/e2e/T-XX-*.test.ts
 *
 * 直接调用 agent-service 的 vitest.e2e.config.ts，并把命令行参数（指定 case
 * 或 -t 过滤）原样传给 vitest。如果想跑单一 case，可：
 *
 *   pnpm test:e2e tests/e2e/T-08-po-suspend.test.ts
 *   pnpm test:e2e -t T-09
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const agentServiceDir = path.join(repoRoot, 'packages', 'agent-service');

const passThrough = process.argv.slice(2).filter((arg) => arg !== '--');
const vitestArgs = ['run', '--config', 'vitest.e2e.config.ts', ...passThrough];

const child = spawnSync('pnpm', ['exec', 'vitest', ...vitestArgs], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  cwd: agentServiceDir,
});

if (child.error) {
  console.error(child.error);
  process.exit(1);
}

process.exit(child.status ?? 1);
