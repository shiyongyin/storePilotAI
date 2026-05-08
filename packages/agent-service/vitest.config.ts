import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  /**
   * 切片 18 — agent-service 集成测试需要从 mcp-mock-server 直接 import test-utils；
   * 用 vitest alias 直指源文件（避免依赖 dist/ 构建产物，且不污染 production package.json）。
   */
  resolve: {
    alias: {
      '@storepilot/mcp-mock-server/test-utils': path.resolve(
        here,
        '../mcp-mock-server/src/test-utils.ts',
      ),
    },
  },
  test: {
    name: 'agent-service',
    environment: 'node',
    globals: false,
    include: ['src/**/*.{test,spec}.ts', 'tests/**/*.{test,spec}.ts'],
    /**
     * 切片 18 §7 MUST NOT §3 — 单测 < 5s；HITL E2E 在切片 19 单独跑。
     * 故排除 tests/e2e/**（属切片 19 范围；本切片只跑 unit + integration）。
     */
    exclude: ['node_modules/**', 'dist/**', 'tests/e2e/**'],
    testTimeout: 5_000,
    hookTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.{test,spec}.ts',
        'src/**/index.ts',
        'src/server.ts',
        'src/test-helpers/**',
        'tests/**',
      ],
    },
  },
});
