/**
 * 切片 05 — MCP IO 共享原子 schema(SSOT)
 * 仅供 mcp/*.ts 内部 import,不导出到 ToolContracts(命名加 _ 前缀)。
 */
import { z } from 'zod';

export const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式必须 YYYY-MM-DD');

export const DateRange = z.object({
  startDate: DateStr,
  endDate: DateStr,
});

export type DateStr = z.infer<typeof DateStr>;
export type DateRange = z.infer<typeof DateRange>;

/** 多租户基础(任意工具的 input/output 都必须含) */
export const TenantScope = z.object({
  merchantId: z.string().min(1),
  storeId: z.string().min(1),
});

export type TenantScope = z.infer<typeof TenantScope>;
