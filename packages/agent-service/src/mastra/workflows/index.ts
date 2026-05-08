/**
 * 切片 06 — workflows/ barrel 占位
 *
 * 5 个 Workflow 由各自切片完整化:
 *   - business_daily_report   → 切片 12
 *   - business_monthly_report → 切片 12
 *   - replenishment_forecast  → 切片 14
 *   - replenishment_adjustment → 切片 15
 *   - purchase_order_create   → 切片 17（HITL）
 *
 * 本切片仅占位，让 createMastra() 中 `import * as workflows from './workflows/index.js'` 不报错。
 * 各下游切片在自己的文件里 `export const xxx = createWorkflow(...)` 加导出，本文件不再修改。
 *
 * !! 切片 17 — 采购单 HITL workflow 注册键约束 !!
 *   ConfirmManager（切片 16）调用 `mastra.getWorkflow('purchase_order_create').resume(...)`，
 *   所以注册键必须是 `purchase_order_create`（snake_case），不能是 `purchaseOrderCreate`。
 *   本 barrel 同时导出原始驼峰名（直接 import 用）+ snake_case 别名（createMastra 注册键用）。
 */
export { businessDailyReport } from './business-daily-report.js';
export { businessMonthlyReport } from './business-monthly-report.js';
export { replenishmentForecast } from './replenishment-forecast.js';
export { replenishmentAdjustment } from './replenishment-adjustment.js';
export {
  purchaseOrderCreate,
  purchaseOrderCreate as purchase_order_create,
} from './purchase-order-create.js';
