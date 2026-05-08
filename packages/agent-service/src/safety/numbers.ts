/**
 * 切片 11 — 数字规范化与提取(safety/numbers)
 *
 * 职责:
 *   - canonical(n): 把 number 统一为规范化字符串(尾差容忍 = 8 位有效小数四舍五入)。
 *   - normalizeNumber(raw): 把 markdown 中的数字字面量(普通 / 千分位 / 百分比 / 万 / 亿)
 *     归一为 canonical 字符串,与工具返回的 canonical 集合做等值比较。
 *   - extractNumbersFrom(payloads): 从工具返回 payload 树中 deep-walk 提取所有数字,
 *     并加入 *100 / /100 / round 的派生 canonical(容忍单位换算 / 元↔分 / 整数四舍)。
 *   - isAllowlistedConst(n): 8 个常量白名单 {0,1,7,14,30,60,90,100},不得新增第 9 个。
 *
 * 引用:
 *   - 任务卡 docs/tanks/11-safety-strategy-validator.md §8.4 §8.5
 *   - F-业务安全层.md §T-SAFETY-04.5
 *   - 设计指南 §9 + §28 + 技术研究报告 §4.9
 *
 * V1 红线:
 *   - 仅覆盖 5 类形态(普通整数 / 普通小数 / 千分位 / 百分比 / 万亿);CJK 大写 / 罗马数字属 V2。
 *   - 常量白名单固定 8 个,不得新增。
 *   - 日期 / 时间不参与数字校验(由 output-validator strip)。
 */

/**
 * 把 JS number 规范化为字符串。
 *
 * 规范化策略(尾差容忍):
 *   1. 用 toFixed(8) 截断浮点尾差(如 0.1 + 0.2 → 0.3)。
 *   2. 通过 Number 再 String 去掉无意义的尾随 0(如 12.50000000 → 12.5)。
 *   3. 整数走快路径直接 String(n)。
 *
 * 注意:
 *   - 极小数 (|n| < 5e-9) 会被四舍为 "0",这是 V1 容忍范围内的有意行为。
 *   - 不接受 NaN / Infinity(调用方需先校验 Number.isFinite)。
 *
 * @param n 任意有限数(payload 中的数字值或 normalize 后的解析结果)
 * @returns 规范化后的字符串(用作 Set 的 key)
 */
export function canonical(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  // toFixed(8) 把浮点尾差(0.1 + 0.2 = 0.30000000000000004)统一截断到 8 位
  // Number(...).toString() 再去掉无意义尾随 0("12.50000000" → "12.5")
  return Number(n.toFixed(8)).toString();
}

/**
 * 把 markdown 中的数字字面量规范化为 canonical 字符串。
 *
 * 支持 5 类形态:
 *   - 普通整数:        "12345"          → "12345"
 *   - 普通小数:        "12.5"           → "12.5"
 *   - 千分位:          "1,234,567"      → "1234567"
 *   - 百分比:          "12.5%"          → "0.125"
 *   - 万亿:            "3 万" / "3万"   → "30000"
 *                      "1.5 亿"         → "150000000"
 *
 * 规则:
 *   - 自动 strip 千分位逗号 / 内部空白 / 前导符号(本切片不区分正负)。
 *   - 解析失败(NaN)返回 "NaN",由调用方自行处理(通常是匹配不到 allowed 触发 NUMBER_INCONSISTENT)。
 *
 * @param raw 来自 markdown 的原始数字字面量(已通过 matches 正则截取)
 * @returns canonical 字符串
 */
export function normalizeNumber(raw: string): string {
  // strip 内部空白(允许 "3 万")、千分位逗号、前导正负号
  const s = raw.replace(/\s+/g, '').replace(/,/g, '').replace(/^[+-]/, '');
  if (s.endsWith('%')) return canonical(Number(s.slice(0, -1)) / 100);
  if (s.endsWith('万')) return canonical(Number(s.slice(0, -1)) * 10_000);
  if (s.endsWith('亿')) return canonical(Number(s.slice(0, -1)) * 100_000_000);
  return canonical(Number(s));
}

/**
 * 从工具返回 payload 树中 deep-walk 提取所有数字,生成 canonical 字符串集合。
 *
 * 派生策略(尾差容忍):
 *   - 对每个原始数字 x,额外加入 x*100 / x/100 / round(x) 的 canonical。
 *   - 对应场景:元↔分 单位换算 / 整数四舍 / 小数取整。
 *
 * 边界:
 *   - 仅识别 number 类型与"严格数字串"(/^-?\d+(\.\d+)?$/),不识别千分位 / 百分比 / 万亿
 *     字符串(那些是 markdown 形态,不是工具返回形态)。
 *   - 不识别 BigInt / Date / Symbol;数组与对象递归走入。
 *
 * @param payloads 多个 MCP 工具返回的 raw payload(可任意嵌套)
 * @returns canonical 字符串集合(用作 allowed)
 */
export function extractNumbersFrom(payloads: unknown[]): Set<string> {
  const out = new Set<string>();

  const walk = (v: unknown): void => {
    if (typeof v === 'number' && Number.isFinite(v)) {
      out.add(canonical(v));
      return;
    }
    if (typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v)) {
      const n = Number(v);
      if (Number.isFinite(n)) out.add(canonical(n));
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (v && typeof v === 'object') {
      Object.values(v as Record<string, unknown>).forEach(walk);
    }
  };

  payloads.forEach(walk);

  // 派生:*100 / /100 / round 三类容忍尾差(元↔分、整数四舍)
  for (const n of [...out]) {
    const x = Number(n);
    if (!Number.isFinite(x)) continue;
    out.add(canonical(x * 100));
    out.add(canonical(x / 100));
    out.add(canonical(Math.round(x)));
  }

  return out;
}

/**
 * V1 固定 8 个豁免常量(违反 MUST NOT §57:不得豁免常量超过 8 个)。
 *
 * 设计原因:
 *   - 0 / 1 / 100:   通用边界(下限 / 单位 / 百分比基底)
 *   - 7 / 14 / 30:   常见预测窗口(周 / 半月 / 月)
 *   - 60 / 90:       常见保质期窗口(60 天 / 季度)
 *
 * 任何尝试加入第 9 个常量的修改都视为违规,需走任务卡修订流程。
 *
 * @param n canonical 字符串
 * @returns 是否在固定豁免集合中
 */
const ALLOWLIST_CONST: ReadonlySet<string> = new Set([
  '0',
  '1',
  '7',
  '14',
  '30',
  '60',
  '90',
  '100',
]);

export function isAllowlistedConst(n: string): boolean {
  return ALLOWLIST_CONST.has(n);
}
