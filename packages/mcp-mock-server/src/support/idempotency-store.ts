/**
 * 切片 05 — createPurchaseOrder 内存 Map 幂等存储
 * 行为:同 idempotencyKey 调 N 次 → 返回相同 PO 号(R-PO-002)
 *
 * 注:V1 仅内存,进程重启清空。生产 ERP 真实端会有数据库幂等;
 * 本 Mock 仅用于契约对账与开发环境冒烟。
 */
import type { PurchaseOrderResult } from '@storepilot/shared-contracts/mcp';

const store = new Map<string, PurchaseOrderResult>();

export const idempotencyStore = {
  has(key: string): boolean {
    return store.has(key);
  },
  get(key: string): PurchaseOrderResult | undefined {
    return store.get(key);
  },
  set(key: string, value: PurchaseOrderResult): void {
    store.set(key, value);
  },
  /** 仅用于测试 */
  clear(): void {
    store.clear();
  },
  size(): number {
    return store.size;
  },
};
