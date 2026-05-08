/**
 * 切片 11 V2.1 补丁 — MysqlStrategyLoader（StrategyLoader 的 mysql2 默认实现）。
 *
 * 切片 11 自身只交付 `StrategyLoader` 接口 + `setStrategyLoader` hook；本文件提供
 * server bootstrap 期可直接注入的默认 mysql 实现，避免每次接 LobeChat 都因
 * `StrategyLoader 未注入` 而把 BUSINESS_DAILY_REPORT 等业务 case 兜底成"系统忙"。
 *
 * 数据来源（migrations 001 / 007）：
 *   - `agent_merchant_strategy WHERE merchant_id='__PLATFORM_DEFAULT__'`
 *     → loadPlatformDefault
 *   - `agent_merchant_strategy WHERE merchant_id=?`
 *     → loadMerchantStrategy
 *   - `agent_store_strategy WHERE merchant_id=? AND store_id=?`
 *     → loadStoreStrategy
 *
 * 强约束：
 *   - 复用 `MysqlStoragePool`（全 workspace 共用一个 mysql2 连接池）；不得自己 createPool。
 *   - 任意行的 `strategy_json` 已经是 JSON 列；mysql2 默认会自动 parse 为 object，无需 JSON.parse 兜底。
 *   - `loadPlatformDefault` 缺行时按"未配置"抛 BizError，让 mergeStrategy 走平台默认 degraded 路径。
 *
 * @since V2.1（dispatcher 接力收尾）
 */
import { BizError } from '@storepilot/shared-contracts';

import type { MysqlStoragePool } from '../mastra/storage/sql.js';

import type {
  PlatformStrategyRow,
  StrategyLoader,
  StrategyRow,
} from './strategy-engine.js';

const PLATFORM_DEFAULT_MERCHANT_ID = '__PLATFORM_DEFAULT__';

interface StrategyJsonRow extends Record<string, unknown> {
  strategy_json: unknown;
  version: string;
}

/**
 * 把 mysql2 row 的 `strategy_json`（可能是 string 或 object）规整为 `Record<string, unknown>`。
 * - JSON 列在 mysql2 默认配置下回 object；某些连接配置（如禁用 typeCast）会回 string。
 */
function parseStrategyJson(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      // fallthrough
    }
  }
  return {};
}

export function createMysqlStrategyLoader(pool: MysqlStoragePool): StrategyLoader {
  return {
    async loadPlatformDefault(): Promise<PlatformStrategyRow> {
      const [rows] = await pool.query<StrategyJsonRow>(
        `SELECT strategy_json, version
           FROM agent_merchant_strategy
          WHERE merchant_id = ? AND status = 'enabled'
          ORDER BY id DESC
          LIMIT 1`,
        [PLATFORM_DEFAULT_MERCHANT_ID],
      );
      const row = rows[0];
      if (!row) {
        throw new BizError(
          'INTERNAL_ERROR',
          '平台默认策略缺失：agent_merchant_strategy 中找不到 __PLATFORM_DEFAULT__ 行（请跑 migration 007）',
        );
      }
      return {
        strategyJson: parseStrategyJson(row.strategy_json),
        version: row.version,
      };
    },

    async loadMerchantStrategy(merchantId: string): Promise<StrategyRow | null> {
      const [rows] = await pool.query<StrategyJsonRow>(
        `SELECT strategy_json, version
           FROM agent_merchant_strategy
          WHERE merchant_id = ? AND status = 'enabled'
          ORDER BY id DESC
          LIMIT 1`,
        [merchantId],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        strategyJson: parseStrategyJson(row.strategy_json),
        version: row.version,
      };
    },

    async loadStoreStrategy(
      merchantId: string,
      storeId: string,
    ): Promise<StrategyRow | null> {
      const [rows] = await pool.query<StrategyJsonRow>(
        `SELECT strategy_json, version
           FROM agent_store_strategy
          WHERE merchant_id = ? AND store_id = ? AND status = 'enabled'
          ORDER BY id DESC
          LIMIT 1`,
        [merchantId, storeId],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        strategyJson: parseStrategyJson(row.strategy_json),
        version: row.version,
      };
    },
  };
}
