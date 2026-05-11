import type { DispatchArgs } from './chat-completions.js';
import { createHash } from 'node:crypto';

import { getEnv } from '../config/env.js';

export function isMarketingEnabledForStore(args: Pick<DispatchArgs, 'auth'>): boolean {
  const env = getEnv();
  if (!env.MARKETING_AGENT_ENABLED) return false;
  const whitelist = env.MARKETING_AGENT_ENABLED_STORE_WHITELIST.split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (whitelist.includes(args.auth.storeId)) return true;
  if (env.MARKETING_AGENT_ROLLOUT_PERCENT <= 0) return false;
  return rolloutBucket(args.auth.merchantId, args.auth.storeId) < env.MARKETING_AGENT_ROLLOUT_PERCENT;
}

function rolloutBucket(merchantId: string, storeId: string): number {
  const hex = createHash('sha256')
    .update(`${merchantId}:${storeId}`)
    .digest('hex')
    .slice(0, 8);
  return Number.parseInt(hex, 16) % 100;
}
