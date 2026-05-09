/**
 * 切片 18 — vitest workspace 配置
 *
 * 严格按 docs/tanks/18-test-unit-integration.md §8.1 + 任务卡 H-测试 §T-TEST-01.5 落地：
 *   - 独立 vitest project：shared-contracts / agent-service / mcp-mock-server / tools
 *   - 各自独立 vitest.config.ts；每个包独立 coverage 打分（任务卡 §8 验收 §5）
 *   - 无重复 schema、无业务实现，仅 workspace 拓扑
 *
 * 顺序故意按"契约 → 业务 → mock"排列，便于 reporter 输出对人友好（先底层后上层）。
 */
export default [
  'packages/shared-contracts/vitest.config.ts',
  'packages/agent-service/vitest.config.ts',
  'packages/mcp-mock-server/vitest.config.ts',
  'tools/api-key-issuer/vitest.config.ts',
  'tools/migrate-runner/vitest.config.ts',
  'tools/seed-strategy/vitest.config.ts',
];
