/**
 * 切片 19 — E2E 专用 Vitest 配置。
 *
 * 与单测/集成测共享 vitest.config.ts 的核心 alias，但放宽 testTimeout 至 30s（单条 E2E 上限），
 * hookTimeout 给到 60s（beforeAll 里要建 MCP mock + 真实 MySQL probe）。
 *
 * 任务卡 §6 MUST DO §4：单条 E2E（除 HITL 链）≤ 30s。
 *
 * @since 切片 19
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@storepilot/mcp-mock-server/test-utils': path.resolve(
        here,
        '../mcp-mock-server/src/test-utils.ts',
      ),
    },
  },
  test: {
    name: 'agent-service-e2e',
    environment: 'node',
    globals: false,
    include: ['tests/e2e/**/*.test.ts'],
    /**
     * E2E 单条 ≤ 30s（任务卡 §6 MUST DO §4）；HITL 链路（T-08..T-11）走 describe.serial，
     * 单条 it 仍 ≤ 30s，链路总耗时通过共享 sessionId / draftId 控制。
     */
    testTimeout: 30_000,
    hookTimeout: 60_000,
    /**
     * 任务卡 §7 MUST DO §5：必须打日志（reporter=verbose 由 npm script 注入）。
     * 这里默认 dot 即可；CI 用 --reporter=verbose 覆盖。
     */
    reporters: ['default'],
  },
});
