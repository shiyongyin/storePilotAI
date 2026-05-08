/**
 * 切片 07 — JSON 写入前清理 undefined 字段（任务卡 §7 MUST DO §3 / §8.4）。
 *
 * 背景：
 *   - {@link JSON.stringify} 在嵌套对象遇到 `undefined` 字段时**会丢字段**（不是写 null）。
 *     若 Mastra workflow snapshot / event payload / suspend payload 含嵌套 undefined，
 *     入库后再读出会导致字段消失，破坏后续 resume / 审计。
 *   - 本函数在 `JSON.stringify(...)` 之前递归剥离 `undefined`，保证序列化结果与对象树一致。
 *
 * 行为约定：
 *   - `undefined`              → 跳过（数组中也跳过；与 JSON.stringify 行为一致但提前剥离）
 *   - `null`                   → 保留（与 undefined 区分；业务可能依赖 null 语义）
 *   - 数组                      → 元素递归 + 过滤 undefined
 *   - 普通对象（plain object） → 递归各字段；非可枚举字段忽略（{@link Object.entries}）
 *   - Date / Buffer / Map / Set / 类实例 → 原样返回（保留运行时形状，由序列化层决定如何处理）
 *
 * 与切片 13 的 `safety/draft-manager.ts#stripUndefinedDeep` 同语义、同实现要点。
 * 两份实现暂时**保留两份**（避免跨切片紧耦合）；后续若提取到 shared utils 再合并。
 *
 * @param v 任意值
 * @returns 剥离 undefined 后的同结构值（保留 null / 原型 / Date 等）
 */
export function stripUndefinedDeep<T>(v: T): T {
  return stripInner(v) as T;
}

function stripInner(v: unknown): unknown {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const item of v) {
      const stripped = stripInner(item);
      if (stripped !== undefined) out.push(stripped);
    }
    return out;
  }
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const stripped = stripInner(x);
      if (stripped !== undefined) out[k] = stripped;
    }
    return out;
  }
  return v;
}
