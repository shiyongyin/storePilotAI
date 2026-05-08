/**
 * 切片 05 — MCP ToolContracts barrel(SSOT)
 *
 * 强约束(任务卡 §7 MUST DO §4-5):
 *   - TOOL_NAMES 必须按字典序排序(启动期白名单 JSON.stringify 比对依赖)
 *   - TOOL_NAMES.length === 7
 *   - ToolContracts 顺序与 TOOL_NAMES 一致(便于 grep / diff)
 *
 * 任意下游切片(08 启动校验 / 12-17 调用方)新增/重命名工具必须先回填本文件。
 */
export {
  PurchaseOrderItem,
  PurchaseOrderResult,
  createPurchaseOrder,
} from './createPurchaseOrder.js';
export { ReportCardConfig, StoreReportConfig, getStoreReportConfig } from './getStoreReportConfig.js';
export {
  CategorySalesRatio,
  CategorySalesRatioItem,
  queryCategorySalesRatio,
} from './queryCategorySalesRatio.js';
export { InventoryOverview, queryInventoryOverview } from './queryInventoryOverview.js';
export { ProductRankItem, ProductSalesRank, queryProductSalesRank } from './queryProductSalesRank.js';
export {
  ReplenishmentBaseData,
  ReplenishmentBaseItem,
  queryReplenishmentBaseData,
} from './queryReplenishmentBaseData.js';
export { DailySalesPoint, StoreSalesSummary, queryStoreSalesSummary } from './queryStoreSalesSummary.js';

import { createPurchaseOrder } from './createPurchaseOrder.js';
import { getStoreReportConfig } from './getStoreReportConfig.js';
import { queryCategorySalesRatio } from './queryCategorySalesRatio.js';
import { queryInventoryOverview } from './queryInventoryOverview.js';
import { queryProductSalesRank } from './queryProductSalesRank.js';
import { queryReplenishmentBaseData } from './queryReplenishmentBaseData.js';
import { queryStoreSalesSummary } from './queryStoreSalesSummary.js';

/**
 * ToolContracts(字典序):
 * createPurchaseOrder / getStoreReportConfig / queryCategorySalesRatio /
 * queryInventoryOverview / queryProductSalesRank /
 * queryReplenishmentBaseData / queryStoreSalesSummary
 */
export const ToolContracts = {
  createPurchaseOrder,
  getStoreReportConfig,
  queryCategorySalesRatio,
  queryInventoryOverview,
  queryProductSalesRank,
  queryReplenishmentBaseData,
  queryStoreSalesSummary,
} as const;

export type ToolContractName = keyof typeof ToolContracts;

/** 字典序的工具名数组(7 项),启动期白名单严格相等比对依据 */
export const TOOL_NAMES = (Object.keys(ToolContracts) as ToolContractName[]).sort() as ReadonlyArray<ToolContractName>;
