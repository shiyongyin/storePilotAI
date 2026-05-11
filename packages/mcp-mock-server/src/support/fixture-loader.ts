/**
 * 切片 05 — fixture profile 加载器
 *
 * 策略:每个 profile 目录下提供一组 ESM 模块,按 toolName 命名:
 *   fixtures/<profile>/<toolName>.ts → default export 工具的输出 fixture 数据(纯函数式,接收 input,返回 output)
 *
 * 若该 profile 下没有该工具的 fixture,fall back 到 happy-path。
 * V1 mock 不读外部 JSON,fixture 直接打包到 dist。
 */
import type { FixtureProfile } from '../config/env.js';

import { happyPathFixtures } from '../fixtures/happy-path/index.js';
import { marketingShoeStoreFixtures } from '../fixtures/marketing-shoe-store/index.js';
import { missingCategoryRatioFixtures } from '../fixtures/missing-category-ratio/index.js';
import { slowSalesSummaryFixtures } from '../fixtures/slow-sales-summary/index.js';
import { createPoIdempotentFixtures } from '../fixtures/create-po-idempotent/index.js';
import { emptyInventoryFixtures } from '../fixtures/empty-inventory/index.js';
import { crossTenantDeniedFixtures } from '../fixtures/cross-tenant-denied/index.js';

export type FixtureFn<I = unknown, O = unknown> = (input: I) => O | Promise<O>;

export type ProfileFixtures = Partial<Record<string, FixtureFn>>;

const REGISTRY: Record<FixtureProfile, ProfileFixtures> = {
  'happy-path': happyPathFixtures,
  'marketing-shoe-store': marketingShoeStoreFixtures,
  'missing-category-ratio': missingCategoryRatioFixtures,
  'slow-sales-summary': slowSalesSummaryFixtures,
  'create-po-idempotent': createPoIdempotentFixtures,
  'empty-inventory': emptyInventoryFixtures,
  'cross-tenant-denied': crossTenantDeniedFixtures,
};

export function pickFixture<I = unknown, O = unknown>(
  profile: FixtureProfile,
  toolName: string,
): FixtureFn<I, O> {
  const profileFx = REGISTRY[profile];
  const fn = profileFx[toolName] ?? REGISTRY['happy-path'][toolName];
  if (!fn) {
    throw new Error(`[mcp-mock] fixture not found: profile=${profile} tool=${toolName}`);
  }
  return fn as FixtureFn<I, O>;
}
