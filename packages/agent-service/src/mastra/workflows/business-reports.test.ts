/**
 * 切片 12 §9 / §11 自检 — 业务日报 + 业务月报 Workflow 单测（无 LLM / MCP）
 *
 * 覆盖范围（任务卡 docs/tanks/12-skill-business-reports.md §9）：
 *   - 第 9 步：grep `createPurchaseOrder` 在两个 Workflow 源文件 0 命中（不暴露 WRITE 工具）
 *   - 第 10 步：月末日期推断（2 月平/闰、4 月、12 月跨年）由
 *               {@link computeMonthlyDateRanges} 单独验证
 *   - §11 自检：日报/月报 Prompt 必须包含 §8.2 §8.3 列出的全部强约束句段，
 *               避免 prompt 漂移导致 §9 验收降级
 *
 * 关于 §9 第 1-8/11/12 步（happy SSE / 50 样本一致性 / 数字伪造拦截 / schema 重试 /
 * 并行时延 / 全失败 MCP_UNAVAILABLE / 派生表达式）必须连通真实 LLM + mcp-mock-server +
 * fixture 才能稳定断言；本切片仅做骨架代码 + 静态契约层守门，端到端集成测试由切片 18 / 19 / 21
 * 在拉起 docker-compose / mcp-mock 后落地。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { dailyReportPrompt } from '../../prompts/daily-report.prompt.js';
import { monthlyReportPrompt } from '../../prompts/monthly-report.prompt.js';
import { computeMonthlyDateRanges } from './business-monthly-report.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAILY_FILE = resolve(__dirname, 'business-daily-report.ts');
const MONTHLY_FILE = resolve(__dirname, 'business-monthly-report.ts');

const COMMON_STRONG_CONSTRAINTS = [
  /数字必须来自输入\s*JSON|数字必须来自工具\s*JSON|数字必须来自输入/,
  /禁止编造/,
  /该指标暂无数据/,
  /约\/大概\/差不多/,
  /## 数据来源/,
  /tool_calls/,
  /function_call/,
  /tool_call_id/,
  /createPurchaseOrder/,
  /markdown\/cards\/abnormal/,
];

describe('切片 12 §9 第 9 步 — Workflow 源文件不得引用 WRITE 工具 createPurchaseOrder', () => {
  it('business-daily-report.ts 不得出现 createPurchaseOrder', () => {
    const text = readFileSync(DAILY_FILE, 'utf8');
    expect(text).not.toMatch(/createPurchaseOrder/);
  });

  it('business-monthly-report.ts 不得出现 createPurchaseOrder', () => {
    const text = readFileSync(MONTHLY_FILE, 'utf8');
    expect(text).not.toMatch(/createPurchaseOrder/);
  });
});

describe('切片 12 §9 第 10 步 — computeMonthlyDateRanges 月末边界', () => {
  it('2 月平年（2026-02）：endDate=2026-02-28；上月跨年回退到 2026-01', () => {
    const r = computeMonthlyDateRanges('2026-02');
    expect(r.startDate).toBe('2026-02-01');
    expect(r.endDate).toBe('2026-02-28');
    expect(r.prevStartDate).toBe('2026-01-01');
    expect(r.prevEndDate).toBe('2026-01-31');
  });

  it('2 月闰年（2024-02）：endDate=2024-02-29', () => {
    const r = computeMonthlyDateRanges('2024-02');
    expect(r.endDate).toBe('2024-02-29');
  });

  it('4 月（2026-04）：endDate=2026-04-30；上月 2026-03-31', () => {
    const r = computeMonthlyDateRanges('2026-04');
    expect(r.startDate).toBe('2026-04-01');
    expect(r.endDate).toBe('2026-04-30');
    expect(r.prevStartDate).toBe('2026-03-01');
    expect(r.prevEndDate).toBe('2026-03-31');
  });

  it('12 月（2026-12）：endDate=2026-12-31；上月 2026-11', () => {
    const r = computeMonthlyDateRanges('2026-12');
    expect(r.startDate).toBe('2026-12-01');
    expect(r.endDate).toBe('2026-12-31');
    expect(r.prevStartDate).toBe('2026-11-01');
    expect(r.prevEndDate).toBe('2026-11-30');
  });

  it('1 月（2026-01）：上月跨年回退至 2025-12', () => {
    const r = computeMonthlyDateRanges('2026-01');
    expect(r.startDate).toBe('2026-01-01');
    expect(r.endDate).toBe('2026-01-31');
    expect(r.prevStartDate).toBe('2025-12-01');
    expect(r.prevEndDate).toBe('2025-12-31');
  });
});

describe('切片 12 §11 自检 — 日报 / 月报 Prompt 必须含全部强约束句段', () => {
  it('dailyReportPrompt 含 §8.2 列出的全部强约束', () => {
    const text = dailyReportPrompt({
      reportDate: '2026-05-07',
      maxSummaryChars: 800,
      maxCards: 10,
    });
    for (const re of COMMON_STRONG_CONSTRAINTS) {
      expect(text, `dailyReportPrompt 缺少强约束 ${re}`).toMatch(re);
    }
    expect(text, '日报 prompt 必须强制 ## 数据来源 小节').toMatch(/## 数据来源/);
    expect(text, '日报 prompt 必须包含报告日期占位').toContain('2026-05-07');
  });

  it('monthlyReportPrompt 含 §8.3 列出的全部强约束 + 月报结构要点', () => {
    const text = monthlyReportPrompt({
      month: '2026-05',
      maxSummaryChars: 5000,
      maxCards: 12,
    });
    for (const re of COMMON_STRONG_CONSTRAINTS) {
      expect(text, `monthlyReportPrompt 缺少强约束 ${re}`).toMatch(re);
    }
    for (const required of ['本月概览', '环比', '滞销', '下月建议', '库存风险']) {
      expect(text, `monthlyReportPrompt 缺少结构要求：${required}`).toContain(required);
    }
    expect(text).toContain('2026-05');
  });

  it('Prompt 在 retry=true 时必须显式提示重试语义（避免 §9 第 6 步 schema 重试时模型不知情）', () => {
    expect(dailyReportPrompt({ reportDate: '2026-05-07', maxSummaryChars: 100, maxCards: 5, retry: true }))
      .toContain('重试');
    expect(monthlyReportPrompt({ month: '2026-05', maxSummaryChars: 100, maxCards: 5, retry: true }))
      .toContain('重试');
  });

  it('Prompt 必须把 reportPolicy 上限注入文本（验证 §7 MUST DO §1 reportPolicy 透传）', () => {
    const daily = dailyReportPrompt({ reportDate: '2026-05-07', maxSummaryChars: 1234, maxCards: 7 });
    expect(daily).toContain('1234');
    expect(daily).toContain('最多 7');
    const monthly = monthlyReportPrompt({ month: '2026-05', maxSummaryChars: 4321, maxCards: 9 });
    expect(monthly).toContain('4321');
    expect(monthly).toContain('最多 9');
  });
});
