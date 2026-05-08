import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'mcp-mock-server',
    environment: 'node',
    globals: false,
    include: ['src/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.{test,spec}.ts', 'src/server.ts', 'src/index.ts'],
    },
  },
});
