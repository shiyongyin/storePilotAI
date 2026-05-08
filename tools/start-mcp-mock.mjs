#!/usr/bin/env node
/**
 * 切片 18 — 集成测试 / 临时启动用：随机端口起 mcp-mock-server
 *
 * 严格按 docs/tanks/18-test-unit-integration.md §6 + 任务卡 H-测试 §T-TEST-01.5 落地。
 *
 * 用途：
 *   - 集成测试期不依赖外部 docker compose；只需 `node tools/start-mcp-mock.mjs` 即可起 mock。
 *   - 默认 fixture=happy-path / port=0(由 OS 分配)；启动后把 url 写到 stdout 第一行，
 *     便于上层脚本（CI / smoke）解析。
 *   - 仍接受 `--fixtures missing-category-ratio` 等子命令切换 fixture。
 *
 * 退出条件：
 *   - SIGINT / SIGTERM → 优雅 close；
 *   - 启动失败 → 退出码 1。
 *
 * 用法：
 *   node tools/start-mcp-mock.mjs                  # 默认 happy-path + 随机端口
 *   node tools/start-mcp-mock.mjs --fixtures slow-sales-summary --port 7300
 */
import { createMcpApp } from '../packages/mcp-mock-server/dist/test-utils.js';

/* ============================================================================
 * 解析参数
 * ========================================================================== */
const args = process.argv.slice(2);
const opts = { fixtures: 'happy-path', port: 0, enableWriteTools: true };
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--fixtures' && args[i + 1]) {
    opts.fixtures = args[++i];
  } else if (a === '--port' && args[i + 1]) {
    opts.port = Number(args[++i]);
  } else if (a === '--no-write-tools') {
    opts.enableWriteTools = false;
  } else if (a === '-h' || a === '--help') {
    console.log(
      'Usage: node tools/start-mcp-mock.mjs [--fixtures <profile>] [--port <port>] [--no-write-tools]\n' +
        'profiles: happy-path | missing-category-ratio | slow-sales-summary | create-po-idempotent | empty-inventory | cross-tenant-denied',
    );
    process.exit(0);
  }
}

/* ============================================================================
 * 启动
 * ========================================================================== */
let handle = null;
try {
  handle = await createMcpApp({
    fixtures: opts.fixtures,
    port: opts.port,
    enableWriteTools: opts.enableWriteTools,
  });
} catch (e) {
  console.error(`[start-mcp-mock] start failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

console.log(handle.url); // 第一行：url（便于解析）
console.error(
  `[start-mcp-mock] listening url=${handle.url} fixtures=${handle.fixtures} ` +
    `tools=${opts.enableWriteTools ? 7 : 6}`,
);

/* ============================================================================
 * 优雅停机
 * ========================================================================== */
let stopped = false;
const shutdown = async (signal) => {
  if (stopped) return;
  stopped = true;
  console.error(`[start-mcp-mock] received ${signal}; closing`);
  try {
    await handle.close();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
