/**
 * 切片 05 — create-po-idempotent profile
 * createPurchaseOrder 由 mcp-server 直接走 idempotencyStore,该 profile 主要用于
 * 切片 17 的"重复确认幂等"E2E 回归。本 profile 不覆写任何工具(因为幂等行为
 * 已在 idempotencyStore 落地,所有 profile 共用)。
 *
 * 之所以保留此目录,是任务卡 §6 / §7 MUST DO §15 要求"6 个 fixture 目录全部就位"。
 */
import type { ProfileFixtures } from '../../support/fixture-loader.js';

export const createPoIdempotentFixtures: ProfileFixtures = {
  // 全部 fall back 到 happy-path;createPurchaseOrder 由 idempotencyStore 控制
};
