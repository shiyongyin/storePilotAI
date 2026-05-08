/**
 * 切片 05 — getStoreReportConfig(SSOT,日 / 月报模板配置)
 * 主调用方:切片 12(business-reports)
 *
 * 注:任务卡只列出工具名 + IO 形式,具体字段属"按设计指南 §23.3 同形式落地"。
 * 本切片基于工具名 + 主调用方业务目的 + 任务卡精度约束(金额 nonnegative / 数量 int)
 * 设计字段;若与设计指南实际有偏,Residual 登记。
 */
import { z } from 'zod';

import { TenantScope } from './_common.js';

export const ReportCardConfig = z.object({
  cardCode: z.string().regex(/^[a-z][a-z0-9_]*$/, '卡片 code 必须 lower_snake_case'),
  enabled: z.boolean(),
  /** 触发该卡片预警的阈值(可选,各卡片语义不同) */
  threshold: z.number().nonnegative().optional(),
});

export type ReportCardConfig = z.infer<typeof ReportCardConfig>;

export const StoreReportConfig = TenantScope.extend({
  /** 货币代码(ISO 4217),如 CNY / USD */
  currency: z.string().regex(/^[A-Z]{3}$/),
  locale: z.string().min(2),
  /** 日报启用的卡片配置 */
  dailyCards: z.array(ReportCardConfig).max(50),
  /** 月报启用的卡片配置 */
  monthlyCards: z.array(ReportCardConfig).max(50),
  /** 时区(IANA),如 Asia/Shanghai */
  timezone: z.string().min(1),
});

export type StoreReportConfig = z.infer<typeof StoreReportConfig>;

export const getStoreReportConfig = {
  input: TenantScope,
  output: StoreReportConfig,
} as const;
