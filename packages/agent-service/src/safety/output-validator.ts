/**
 * 切片 11 — Skill 输出双重校验(safety/output-validator)
 *
 * 职责:
 *   - validateOutput({ schema, output, allowedNumbers }):
 *       1) Zod parse(schema 失败 → ZodError;由上游包装为 BizError(SCHEMA_FAIL))。
 *       2) 若 parsed.summaryMarkdown 存在且数字一致性启用,做数字一致性检查。
 *       3) 通过返回 parsed,失败抛 BizError(NUMBER_INCONSISTENT)。
 *
 * 数字一致性流程:
 *   1. strip 日期 \d{4}-\d{2}-\d{2} 与时间 \d{1,2}:\d{2}(避免 2026-05-07 当数字)。
 *   2. 解析 ## 数据来源 派生白名单(<lhs> = <rhs>;rhs 全合法 → lhs 入白名单)。
 *   3. 对 markdown 中所有 5 类形态数字(普通 / 千分位 / 百分比 / 万亿)逐一校验。
 *
 * 引用:
 *   - 任务卡 docs/tanks/11-safety-strategy-validator.md §8.3 §8.5
 *   - F-业务安全层.md §T-SAFETY-04.5
 *
 * MUST(违反即拒收):
 *   - 必须先 Zod parse 再数字一致性(schema 失败优先级更高)。
 *   - 不得在校验失败时返回部分输出(必须抛错让 Skill 重试)。
 *   - 不得用 LLM 评估数字(本文件全部算法校验)。
 */
import { BizError } from '@storepilot/shared-contracts';
import type { z } from 'zod';

import { canonical, isAllowlistedConst, normalizeNumber } from './numbers.js';

const ROUTE_PROTOCOL_TAG_RE = /<\s*\/?(ASK|FALLBACK)\s*>/i;

/**
 * 单个 markdown 数字字面量的匹配正则(用于 String.prototype.match 的全局扫描)。
 *
 * 三个 alternative 的顺序对结果有影响,**必须按 千分位 → 万亿 → 百分比/普通 的优先级排列**:
 *   1) 千分位:        [+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?
 *   2) 万亿(允许空格): [+-]?\d+(?:\.\d+)?\s*(?:万|亿)
 *   3) 百分比 / 普通:  [+-]?\d+(?:\.\d+)?%?
 */
const NUMBER_TOKEN_RE =
  /[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[+-]?\d+(?:\.\d+)?\s*(?:万|亿)|[+-]?\d+(?:\.\d+)?%?/g;

/**
 * ## 数据来源 派生白名单的行级正则:
 *   - 允许行首 -/* 列表标记
 *   - lhs 必须以数字字面量开头
 *   - 中间用 = 分隔
 *   - rhs 是任意表达式(再用 NUMBER_TOKEN_RE 提取其中数字)
 */
const DERIVED_LINE_RE = /^\s*[-*]?\s*([+-]?\d[\d.,%万亿\s]*)\s*=\s*(.+)$/;

/** ## 数据来源 小节的截取(从标题到 EOF 或下一个 ## 标题前) */
const DATA_SOURCE_SECTION_RE = /##\s*数据来源[\s\S]*?(?=\n##\s|\n###\s|$)/;

/**
 * Skill 输出双重校验主入口。
 *
 * @param args.schema         Skill 的 Zod 输出 schema(切片 04 / 12-17)
 * @param args.output         LLM 原始输出 / Workflow step 返回值(unknown)
 * @param args.allowedNumbers 工具返回派生的 canonical 数字白名单(extractNumbersFrom 产出)
 * @param args.enforceNumberConsistency 数字一致性开关;默认启用,验证阶段可由 workflow 显式关闭
 * @returns Zod 解析后的强类型对象(透传上游)
 * @throws ZodError                 schema 不通过(由调用方包装为 BizError(SCHEMA_FAIL))
 * @throws BizError(NUMBER_INCONSISTENT)  markdown 中存在工具未返回的数字
 */
export function validateOutput<T>(args: {
  schema: z.ZodType<T>;
  output: unknown;
  allowedNumbers: Set<string>;
  enforceNumberConsistency?: boolean;
}): T {
  // 1) schema 失败优先级更高(MUST §44 §54)
  const parsed = args.schema.parse(args.output);

  // 2) 仅当输出含 summaryMarkdown 时做数字一致性检查
  const md = (parsed as { summaryMarkdown?: unknown })?.summaryMarkdown;
  if (args.enforceNumberConsistency !== false && typeof md === 'string' && md.length > 0) {
    checkNumberConsistency(md, args.allowedNumbers);
  }
  return parsed;
}

/**
 * Markdown 数字一致性核心算法(导出供单测直接覆盖 50 条样本)。
 *
 * 副作用:会把 ## 数据来源 中合法派生的 lhs canonical 加入到 allowed Set 中。
 * 调用方如不希望污染原 Set,请先 clone(`new Set(allowed)`)。
 *
 * @param md      已校验过 schema 的 summaryMarkdown 字符串
 * @param allowed 工具返回派生的 canonical 白名单(本函数会 mutate)
 * @throws BizError(NUMBER_INCONSISTENT) 命中第一个非法数字立即抛出
 */
export function checkNumberConsistency(md: string, allowed: Set<string>): void {
  // 1) strip 日期 / 时间(MUST §49: 日期不当数字校验)
  const stripped = md
    .replace(/\d{4}-\d{2}-\d{2}/g, '<DATE>')
    .replace(/\d{1,2}:\d{2}/g, '<TIME>');

  if (ROUTE_PROTOCOL_TAG_RE.test(stripped)) {
    throw new BizError('PROMPT_INJECTION', 'Agent 输出包含伪造路由协议标签', {
      meta: { fallbackReason: 'AGENT_OUTPUT_FORGED_TAG' },
      httpStatus: 502,
    });
  }

  // 2) 派生白名单解析(MUST §46: ## 数据来源 派生白名单)
  expandDerivedAllowlist(stripped, allowed);

  // 3) 全文数字扫描 + 逐一校验
  const matches = stripped.match(NUMBER_TOKEN_RE) ?? [];
  for (const raw of matches) {
    const norm = normalizeNumber(raw);
    if (norm === 'NaN') continue;
    if (isAllowlistedConst(norm) || allowed.has(norm)) continue;
    // 失败抛 BizError(MUST §48): 由 Skill 内重试 1 次(切片 12 / 14 实现重试)
    throw new BizError('NUMBER_INCONSISTENT', `数字 ${raw} 未在工具返回中出现`);
  }
}

/**
 * 解析 ## 数据来源 小节的派生表达式,把合法的 lhs 加入白名单。
 *
 * 行格式:`<lhs> = <rhs1> [<op> <rhs2> ...]`
 *   例:`12.5% = (1250 - 1100) / 1100`
 *
 * 加入条件:rhs 中所有数字字面量(同 NUMBER_TOKEN_RE)的 canonical 必须全部满足
 *   `allowed.has(...)` 或 `isAllowlistedConst(...)`,缺一不得加入。
 *
 * 不解析表达式是否数学正确,只做"溯源合法性"检查。
 *
 * @param md      已 strip 日期 / 时间的 markdown
 * @param allowed 工具返回派生的 canonical 白名单(本函数会 mutate)
 */
function expandDerivedAllowlist(md: string, allowed: Set<string>): void {
  const section = md.match(DATA_SOURCE_SECTION_RE)?.[0];
  if (!section) return;

  for (const line of section.split('\n')) {
    const m = line.match(DERIVED_LINE_RE);
    if (!m) continue;
    // m[1] / m[2] 在正则带分组时一定存在,显式断言以满足 noUncheckedIndexedAccess
    const lhsRaw = m[1];
    const rhsRaw = m[2];
    if (lhsRaw === undefined || rhsRaw === undefined) continue;

    const lhs = normalizeNumber(lhsRaw);
    if (lhs === 'NaN') continue;

    const rhsTokens = rhsRaw.match(NUMBER_TOKEN_RE) ?? [];
    if (rhsTokens.length === 0) continue;

    const rhsCanonicals = rhsTokens.map(normalizeNumber).filter((n) => n !== 'NaN');
    if (rhsCanonicals.length === 0) continue;

    const allValid = rhsCanonicals.every((n) => allowed.has(n) || isAllowlistedConst(n));
    if (allValid) allowed.add(lhs);
  }
}

/** 仅用于单测桥接:暴露 token 正则给数字形态边界用例 */
export const __test_only__ = {
  NUMBER_TOKEN_RE,
  DATA_SOURCE_SECTION_RE,
  DERIVED_LINE_RE,
  canonical,
};
