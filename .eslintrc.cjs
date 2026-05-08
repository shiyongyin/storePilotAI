/**
 * 切片 01 — V2.1 红线 ESLint 配置
 * 严格按 docs/任务卡/A-基础设施.md §T-INFRA-01 §5.5 落地。
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: true,
    tsconfigRootDir: __dirname,
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
  ],
  env: {
    node: true,
    es2022: true,
  },
  rules: {
    // 红线 2：禁用 experimental_createMCPClient
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: 'ai',
            importNames: ['experimental_createMCPClient'],
            message: 'V2.1 必须用 @mastra/mcp.MCPClient',
          },
        ],
      },
    ],
    // 红线 4：禁用 streamText({ maxSteps })
    'no-restricted-syntax': [
      'error',
      {
        selector: 'Property[key.name="maxSteps"]',
        message: 'V2.1 已废弃 maxSteps，请用 stopWhen: isStepCount(N)',
      },
    ],
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-explicit-any': 'error',
    'no-console': 'error',
  },
  overrides: [
    {
      // tools/* CLI 工具允许 console（占位实现）
      files: ['tools/**/src/**/*.ts'],
      rules: { 'no-console': 'off' },
    },
    {
      // env.ts 是允许 console 的唯一源文件（fail-fast 输出）
      files: ['packages/agent-service/src/config/env.ts'],
      rules: { 'no-console': 'off' },
    },
    {
      // mcp-mock-server 占位允许 console
      files: ['packages/mcp-mock-server/src/**/*.ts'],
      rules: { 'no-console': 'off' },
    },
    {
      // 测试文件允许 console
      files: ['**/*.test.ts', '**/*.spec.ts'],
      rules: { 'no-console': 'off' },
    },
  ],
  ignorePatterns: [
    'dist',
    'coverage',
    'node_modules',
    '*.cjs',
    '*.mjs',
    '*.js',
    '.eslintrc.cjs',
    'vitest.config.ts',
    'vitest.workspace.ts',
  ],
};
