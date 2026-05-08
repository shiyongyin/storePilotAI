/**
 * 切片 18 §8.6 — output-validator 派生白名单边界分支补充覆盖率
 *
 * 目标：覆盖 expandDerivedAllowlist 内 5 条防御性 continue 分支：
 *   - 134：lhs/rhs undefined（regex 缺组兜底；理论不可达，断言不抛即可）
 *   - 137：lhs canonical === 'NaN'（lhs 是只含逗号 / 万 / 亿 的非数字字面量）
 *   - 139：rhs 全无数字 token（match 返回 null → ?? []）
 *   - 140：rhsTokens.length === 0（rhs 是纯文本）
 *   - 143：rhsCanonicals 全是 NaN（rhs 数字均无法 normalize）
 */
import { describe, expect, it } from 'vitest';

import { checkNumberConsistency } from './output-validator.js';

describe('checkNumberConsistency — ## 数据来源 派生白名单防御分支', () => {
  it('没有 ## 数据来源 小节 → 不做派生解析，仅按主扫描白名单通过', () => {
    expect(() => checkNumberConsistency('# 报告\n本月销售 1500 元', new Set(['1500']))).not.toThrow();
  });

  it('数据来源小节中的非派生行 → continue，不影响其它合法数字', () => {
    const md = ['# 报告', '本月销售 1500 元', '## 数据来源', '- 数据来自 ERP 日结表'].join(
      '\n',
    );
    expect(() => checkNumberConsistency(md, new Set(['1500']))).not.toThrow();
  });

  it('lhs canonical 为 NaN（如 "万亿亿 = 100"）→ continue，主扫描照常', () => {
    const md = ['# 报告', '不会派生这一行', '## 数据来源', '万亿 = 100'].join('\n');
    // 100 不在 allowed → 触发主扫描的 NUMBER_INCONSISTENT；这里只验证派生分支不抛 / 不污染。
    expect(() => checkNumberConsistency(md, new Set(['100']))).not.toThrow();
  });

  it('rhs 全是非数字文本 → rhsTokens 空 → continue', () => {
    const md = [
      '# 报告',
      '本月销售 1500 元',
      '## 数据来源',
      '1500 = 来源说明'
    ].join('\n');
    // 1500 必须在 allowed；rhs 没有数字 → 派生分支 continue；不抛
    expect(() => checkNumberConsistency(md, new Set(['1500']))).not.toThrow();
  });

  it('rhs 全是异常数字（normalize 全为 NaN）→ rhsCanonicals 空 → continue', () => {
    const md = [
      '# 报告',
      '本月销售 1500 元',
      '## 数据来源',
      // 数字 token 形态合法但 normalize 为 NaN（用千分位错位 + 万亿混搭）
      '1500 = ,,, '
    ].join('\n');
    expect(() => checkNumberConsistency(md, new Set(['1500']))).not.toThrow();
  });

  it('rhs 数字全部不在 allowed → allValid=false → lhs 不入白名单（主扫描会拦截 lhs）', () => {
    const md = [
      '# 报告',
      '环比 12.5%',
      '## 数据来源',
      // rhs 数字 1100 / 1250 不在 allowed → 派生失败 → 12.5% 不入白名单
      '12.5% = (1250 - 1100) / 1100',
    ].join('\n');
    // 注意 12.5% 不在 allowed → 应该抛 NUMBER_INCONSISTENT
    expect(() =>
      checkNumberConsistency(md, new Set(['12.5'])),
    ).toThrow(/NUMBER_INCONSISTENT|未在工具返回中出现/);
  });

  it('成功派生：rhs 全合法 → lhs 进白名单 → 主扫描通过', () => {
    const md = [
      '# 报告',
      '环比 12.5%',
      '## 数据来源',
      '12.5% = (1250 - 1100) / 1100',
    ].join('\n');
    // rhs 数字 1250 / 1100 都在 allowed → 12.5 派生入白名单 → 通过
    expect(() =>
      checkNumberConsistency(md, new Set(['1250', '1100'])),
    ).not.toThrow();
  });
});
