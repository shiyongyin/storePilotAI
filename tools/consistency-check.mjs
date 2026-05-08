#!/usr/bin/env node
/**
 * 切片 18 — README §6 一致性矩阵 + 4 类一致性 grep 守门
 *
 * 严格按 docs/tanks/18-test-unit-integration.md §8.4 + 任务卡 H-测试 §T-TEST-01.5 §4 落地。
 *
 * 4 类规则：
 *   1. 禁字面量（红线 4：experimental_createMCPClient / streamText({maxSteps}) 永禁）
 *   2. shared-contracts 单源（DraftStatus / Purchase schema 在 agent-service / mcp-mock-server 0 重复）
 *   3. process.env 直读（除 config/env.ts 外 0 命中；测试不得直接赋值 env）
 *   4. Skill 不调写工具（READ workflow 不得真实调 createPurchaseOrder.execute）
 *
 * 任一规则命中 → process.exit(1)。
 *
 * 用法：
 *   node tools/consistency-check.mjs
 */
import { spawnSync } from 'node:child_process';

const failures = [];

/**
 * 跑 ripgrep 命令；返回 stdout 行数组（去空行）。
 * ripgrep 无命中时退出码=1，本函数把"无命中"视为正常并返回 []。
 *
 * @param {string} description rule 名，仅日志用
 * @param {string[]} args ripgrep 参数（不含 `rg` 命令本身）
 * @returns {string[]} 命中行列表
 */
function rg(description, args) {
  const result = spawnSync('rg', args, { encoding: 'utf8' });
  if (result.error) {
    failures.push({
      rule: description,
      reason: `ripgrep spawn failed: ${result.error.message}`,
    });
    return [];
  }
  // rg 退出码：0=有命中 / 1=无命中 / 2=错误
  if (result.status === 2) {
    failures.push({
      rule: description,
      reason: `ripgrep error: ${result.stderr.trim()}`,
    });
    return [];
  }
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 期望 ripgrep 0 命中；命中 → 记录失败。
 *
 * @param {string} rule
 * @param {string[]} args ripgrep 参数
 * @param {string} hint 命中后给开发者的修复提示
 */
function expectZero(rule, args, hint) {
  const hits = rg(rule, args);
  if (hits.length > 0) {
    failures.push({
      rule,
      reason: `${hits.length} hit(s); ${hint}`,
      sample: hits.slice(0, 5),
    });
  }
}

/* ============================================================================
 * 规则 1 — 禁字面量（红线 4，永禁）
 *   - experimental_createMCPClient：ai 包内的实验性 client，必须改用 @mastra/mcp.MCPClient
 *   - streamText({ maxSteps：Mastra 红线，禁止裸用 streamText.maxSteps 覆盖 workflow
 * ========================================================================== */
expectZero(
  'no-experimental-mcp',
  [
    '-n',
    'experimental_createMCPClient',
    'packages/agent-service/src',
    'packages/mcp-mock-server/src',
  ],
  '改用 @mastra/mcp.MCPClient（红线 4 / 设计指南 §24.1）',
);

expectZero(
  'no-maxSteps',
  [
    '-nU',
    '--multiline',
    String.raw`streamText\(\s*\{[^}]*\bmaxSteps\b`,
    'packages/agent-service/src',
  ],
  'workflow 不得裸调 streamText({ maxSteps })（红线 1 / 设计指南 §24.1）',
);

/* ============================================================================
 * 规则 2 — shared-contracts 单源（schema 重复定义 0 命中）
 *   - DraftStatus 7 状态枚举只能在 shared-contracts/drafts.ts 定义
 *   - PurchaseOrderResult 字段（purchaseOrderNo: z.）只能在 shared-contracts/mcp/createPurchaseOrder.ts
 * ========================================================================== */
expectZero(
  'no-duplicate-draft-status',
  [
    '-n',
    String.raw`z\.enum\(\[\s*'DRAFT'`,
    'packages/agent-service/src',
    'packages/mcp-mock-server/src',
  ],
  'DraftStatus 必须从 @storepilot/shared-contracts 引用（任务卡 §6 真相源）',
);

expectZero(
  'no-duplicate-purchase-schema',
  [
    '-n',
    String.raw`purchaseOrderNo:\s*z\.`,
    'packages/agent-service/src',
    'packages/mcp-mock-server/src',
  ],
  'PurchaseOrderResult 字段必须从 shared-contracts/mcp 引用',
);

/* ============================================================================
 * 规则 3 — process.env 直读（仅 config/env.ts 允许）+ 测试 env 赋值红线
 *   - 业务代码必须经 getEnv()，避免类型不安全 + 漏 zod 校验
 *   - 测试 setup 必须用 vi.stubEnv / vi.unstubAllEnvs，不得写 process.env.X = ...
 * ========================================================================== */
expectZero(
  'no-direct-env-read-agent',
  [
    '-n',
    String.raw`process\.env\.`,
    'packages/agent-service/src',
    '--glob',
    '!**/config/env.ts',
    '--glob',
    '!**/*.test.ts',
    '--glob',
    '!**/*.spec.ts',
  ],
  '业务代码必须经 getEnv()；动态端口用 vi.stubEnv（任务卡 §T-INFRA-04）',
);

expectZero(
  'no-direct-env-bracket-agent',
  [
    '-n',
    String.raw`process\.env\[`,
    'packages/agent-service/src',
    '--glob',
    '!**/config/env.ts',
    '--glob',
    '!**/*.test.ts',
    '--glob',
    '!**/*.spec.ts',
  ],
  '业务代码不得用 process.env["X"] 桥接 zod；统一走 getEnv()',
);

expectZero(
  'no-test-env-assignment-agent',
  [
    '-n',
    String.raw`process\.env(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[^\]]+\])\s*=`,
    'packages/agent-service',
    '--glob',
    '**/*.{test,spec}.ts',
  ],
  '测试文件不得直接写 process.env；请改用 vi.stubEnv / vi.unstubAllEnvs（切片 18 §7 MUST NOT）',
);

/* ============================================================================
 * 规则 4 — READ workflow 不得调写工具（createPurchaseOrder 仅在 purchase-order-create.ts 调）
 *   - 用 `\.createPurchaseOrder\.execute` 仅匹配真实调用点（comment / 文档不计）
 *   - 4 个 READ workflow 文件白名单审查（业务月报 / 日报 / 补货预测 / 调整）
 * ========================================================================== */
const readWorkflows = [
  'packages/agent-service/src/mastra/workflows/business-daily-report.ts',
  'packages/agent-service/src/mastra/workflows/business-monthly-report.ts',
  'packages/agent-service/src/mastra/workflows/replenishment-forecast.ts',
  'packages/agent-service/src/mastra/workflows/replenishment-adjustment.ts',
];
expectZero(
  'no-write-tool-in-read-workflows',
  ['-n', String.raw`\.createPurchaseOrder\.execute`, ...readWorkflows],
  'READ workflow 不得直接调 createPurchaseOrder.execute；写路径必须经 purchase-order-create + ConfirmManager',
);

/* ============================================================================
 * 输出 / 退出码
 * ========================================================================== */
if (failures.length > 0) {
  console.error('[consistency] FAIL — 一致性 grep 命中以下违规：\n');
  for (const f of failures) {
    console.error(`  • ${f.rule}: ${f.reason}`);
    if (f.sample) {
      for (const line of f.sample) console.error(`      ${line}`);
    }
  }
  console.error(
    '\n参考：docs/tanks/18-test-unit-integration.md §8.4；docs/任务卡/README.md §6 一致性矩阵。',
  );
  process.exit(1);
}

console.log('[consistency] OK — 4 类一致性 grep 全过（0 命中）。');
process.exit(0);
