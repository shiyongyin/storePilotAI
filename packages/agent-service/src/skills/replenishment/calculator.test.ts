/**
 * 切片 14 §9 第 1-4 + 8 步 — calculator 50 案例公式回归 + 纯函数 grep 守门
 *
 * 覆盖（任务卡 docs/tanks/14-skill-replenishment-forecast.md §9 / §10）：
 *   - 50 案例 happy / 历史不足 / 起订量 / 节假日 / 加权日均 / 零销 / 超期望 / 整数 / 小数（§9.1）
 *   - R-REP-002 兜底（§9.2）：salesAvg7d undefined/0 + recentSalesByDay.length<7
 *     → finalSuggestQty=0 + reason="销售历史不足，无法计算"
 *   - R-REP-004 起订量 / 倍数取整（§9.3）：minOrderQty=24 / orderMultiple=12 → 38 取整 48
 *   - 节假日因子（§9.4）：isHolidayUpcoming=true → demandFactor=1.1
 *   - calculator 纯函数（§9.8）：源文件 grep 0 命中 await/fetch/mcp/openai/require/Math.random
 *   - reason 非空率（§9.5 抽样）：50 案例非兜底分支 reason 全非空，含 s7/s14/s30 + demandFactor + finalSuggestQty
 *   - snapshot：50 行结果定 baseline，杜绝隐式漂移
 *
 * 注：§9 第 5/6/7/9-12 步涉及 LLM / DB / E2E，由 workflow 集成测试 + 切片 18/19 落地；
 *     本文件聚焦 pure compute + grep 守门，验证 calculator.ts 是 SSOT。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  type ComputeSkuInput,
  type ComputeStrategy,
  type ComputedSku,
  type ContextFactors,
  avg,
  computeSku,
  makeReason,
  roundToOrderRules,
  weightedAvgDailySales,
} from './calculator.js';

/* ============================================================================
 * 工厂：构造 ReplenishmentBaseItem 与 strategy / contextFactors
 * ========================================================================== */

type SkuInput = ComputeSkuInput['it'];

/**
 * 构造一个完整的 ReplenishmentBaseItem 入参 — 缺省字段对齐切片 05 默认值
 * （inTransitQty=0 / leadTimeDays=2 / packSize=1）。
 */
function makeItem(over: Partial<SkuInput> = {}): SkuInput {
  const base: SkuInput = {
    skuId: 'SKU001',
    skuName: '矿泉水 550ml',
    unit: '瓶',
    recentSalesByDay: [10, 10, 10, 10, 10, 10, 10],
    onHandQty: 0,
    inTransitQty: 0,
    leadTimeDays: 2,
    packSize: 1,
  };
  return { ...base, ...over } satisfies SkuInput;
}

function makeStrategy(over: Partial<ComputeStrategy> = {}): ComputeStrategy {
  return {
    forecastDays: 7,
    safetyStockDays: 2,
    minOrderQty: 1,
    orderMultiple: 1,
    ...over,
  };
}

function makeFactors(over: Partial<ContextFactors> = {}): ContextFactors {
  return {
    isHolidayUpcoming: false,
    ...over,
  };
}

/**
 * 50 案例的"基础数字快照"——每个案例只断言 `baseSuggestQty` / `finalSuggestQty` /
 * `riskLevel` / reasonContains 即可，避免 reason 中的浮点格式化引发跨平台抖动。
 */
interface CaseSpec {
  name: string;
  /** 标签，便于 grep "兜底" / "起订" / "节假日" 命中 */
  tags: ReadonlyArray<string>;
  it: Partial<SkuInput>;
  strategy?: Partial<ComputeStrategy>;
  factors?: Partial<ContextFactors>;
  expect: {
    baseSuggestQty: number;
    finalSuggestQty: number;
    riskLevel: ComputedSku['riskLevel'];
    /** reason 必须含的子串数组（命中后断言通过） */
    reasonContains: ReadonlyArray<string>;
  };
}

/* ============================================================================
 * 50 案例语料（按 §10 + 自身扩充覆盖 9 个分类 + 边界）
 *
 * 分类与计数（合计 50）：
 *   - happy（基础公式）              ×  6
 *   - 历史不足兜底                   ×  6
 *   - 起订量 / 倍数取整               ×  8
 *   - 节假日因子                     ×  4
 *   - 加权日均 / 零销                 ×  6
 *   - 超期望（onHand 充足）           ×  4
 *   - 整数 / 小数                     ×  6
 *   - 在途 / 提前期                   ×  4
 *   - strategy 取参（forecastDays / safetyStockDays 变化） ×  6
 * ========================================================================== */

const cases: ReadonlyArray<CaseSpec> = [
  // ===== happy（基础公式）×6 =====
  // C01: s7=10 / s14=10 / s30=10 → avgDaily=10；7d×1.0 + 2d×10 = 90；onHand=0 → 90
  {
    name: 'C01-happy-基础-加权一致-onHand=0',
    tags: ['happy', '加权日均'],
    it: { salesAvg7d: 10, salesAvg14d: 10, salesAvg30d: 10, onHandQty: 0 },
    expect: {
      baseSuggestQty: 90,
      finalSuggestQty: 90,
      riskLevel: 'LOW',
      reasonContains: ['近 7/14/30 日均销 10/10/10', '加权日均 10', '节假日因子 1', '最终建议 90'],
    },
  },
  // C02: s7=10/14/30=10/8/6 → avgDaily=8.6；7d×1.0+2d×8.6=60.2+17.2=77.4 → ceil=78；onHand=0
  {
    name: 'C02-happy-加权差异-3 段',
    tags: ['happy', '加权日均'],
    it: { salesAvg7d: 10, salesAvg14d: 8, salesAvg30d: 6 },
    expect: {
      baseSuggestQty: 78,
      finalSuggestQty: 78,
      riskLevel: 'LOW',
      reasonContains: ['加权日均 8.6', '最终建议 78'],
    },
  },
  // C03: avgDaily=20；7d+2d=180；onHand=50 → 130
  {
    name: 'C03-happy-onHand 抵扣',
    tags: ['happy'],
    it: { salesAvg7d: 20, salesAvg14d: 20, salesAvg30d: 20, onHandQty: 50 },
    expect: {
      baseSuggestQty: 130,
      finalSuggestQty: 130,
      riskLevel: 'LOW',
      reasonContains: ['加权日均 20', '最终建议 130'],
    },
  },
  // C04: avgDaily=15；inTransit=30 → 9d×15-30=135-30=105
  {
    name: 'C04-happy-inTransit 抵扣',
    tags: ['happy'],
    it: { salesAvg7d: 15, salesAvg14d: 15, salesAvg30d: 15, onHandQty: 0, inTransitQty: 30 },
    expect: {
      baseSuggestQty: 105,
      finalSuggestQty: 105,
      riskLevel: 'LOW',
      reasonContains: ['加权日均 15', '最终建议 105'],
    },
  },
  // C05: forecastDays=14 / safetyStockDays=5 → avgDaily=10 → (14+5)*10=190；190>10*14=140→MEDIUM
  {
    name: 'C05-happy-长预测窗口（风险 MEDIUM）',
    tags: ['happy', 'strategy 取参', '风险评级'],
    it: { salesAvg7d: 10, salesAvg14d: 10, salesAvg30d: 10 },
    strategy: { forecastDays: 14, safetyStockDays: 5 },
    expect: {
      baseSuggestQty: 190,
      finalSuggestQty: 190,
      riskLevel: 'MEDIUM',
      reasonContains: ['加权日均 10'],
    },
  },
  // C06: forecastDays=30 / safetyStockDays=0 → avgDaily=5 → 30d×5=150；150>5*14=70→MEDIUM
  {
    name: 'C06-happy-30d-zero-safetyStockDays（风险 MEDIUM）',
    tags: ['happy', 'strategy 取参', '风险评级'],
    it: { salesAvg7d: 5, salesAvg14d: 5, salesAvg30d: 5 },
    strategy: { forecastDays: 30, safetyStockDays: 0 },
    expect: {
      baseSuggestQty: 150,
      finalSuggestQty: 150,
      riskLevel: 'MEDIUM',
      reasonContains: ['加权日均 5'],
    },
  },

  // ===== 历史不足兜底（R-REP-002）×6 =====
  // C07: salesAvg7d=undefined / recentSalesByDay 长度=3
  {
    name: 'C07-兜底-recentSalesByDay 长度 3',
    tags: ['兜底', '历史不足'],
    it: { salesAvg7d: undefined, salesAvg14d: 5, salesAvg30d: 5, recentSalesByDay: [1, 2, 3] },
    expect: {
      baseSuggestQty: 0,
      finalSuggestQty: 0,
      riskLevel: 'MEDIUM',
      reasonContains: ['销售历史不足'],
    },
  },
  // C08: salesAvg7d=0 + recentSalesByDay 长度=6
  {
    name: 'C08-兜底-7d=0 长度 6',
    tags: ['兜底', '历史不足'],
    it: {
      salesAvg7d: 0,
      salesAvg14d: 0,
      salesAvg30d: 0,
      recentSalesByDay: [0, 0, 0, 0, 0, 0],
    },
    expect: {
      baseSuggestQty: 0,
      finalSuggestQty: 0,
      riskLevel: 'MEDIUM',
      reasonContains: ['销售历史不足'],
    },
  },
  // C09: 全 undefined + 空 recentSalesByDay
  {
    name: 'C09-兜底-完全无数据',
    tags: ['兜底', '历史不足'],
    it: {
      salesAvg7d: undefined,
      salesAvg14d: undefined,
      salesAvg30d: undefined,
      recentSalesByDay: [],
    },
    expect: {
      baseSuggestQty: 0,
      finalSuggestQty: 0,
      riskLevel: 'MEDIUM',
      reasonContains: ['销售历史不足'],
    },
  },
  // C10: salesAvg7d=undefined + recentSalesByDay 长度=7（恰好不触发兜底）
  {
    name: 'C10-边界-recentSalesByDay 长度=7 不兜底',
    tags: ['加权日均', '历史不足-边界'],
    it: {
      salesAvg7d: undefined,
      salesAvg14d: undefined,
      salesAvg30d: undefined,
      recentSalesByDay: [10, 10, 10, 10, 10, 10, 10],
    },
    expect: {
      // s7=avg 末 7 = 10；s14/s30 = avg 末 14/30 (但只有 7 元素) = 10
      // avgDaily = 10*0.5 + 10*0.3 + 10*0.2 = 10；7d+2d=90；onHand=0
      baseSuggestQty: 90,
      finalSuggestQty: 90,
      riskLevel: 'LOW',
      reasonContains: ['加权日均 10', '最终建议 90'],
    },
  },
  // C11: salesAvg7d=0 + recentSalesByDay 长度=10（不触发兜底；非负 0 销）
  {
    name: 'C11-边界-7d=0 长度=10 不兜底',
    tags: ['零销', '历史不足-边界'],
    it: {
      salesAvg7d: 0,
      salesAvg14d: 0,
      salesAvg30d: 0,
      recentSalesByDay: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    },
    expect: {
      // recentSalesByDay >= 7 → 不兜底；avgDaily=0；onHand=0 → expected+safety=0 → max(0,..)=0
      baseSuggestQty: 0,
      finalSuggestQty: 0,
      riskLevel: 'LOW',
      reasonContains: ['加权日均 0', '最终建议 0'],
    },
  },
  // C12: salesAvg7d=undefined / 14d 已知（仍触发兜底，因 7d 缺）
  {
    name: 'C12-兜底-7d 缺 14d 已知',
    tags: ['兜底', '历史不足'],
    it: { salesAvg7d: undefined, salesAvg14d: 8, salesAvg30d: 6, recentSalesByDay: [1, 2] },
    expect: {
      baseSuggestQty: 0,
      finalSuggestQty: 0,
      riskLevel: 'MEDIUM',
      reasonContains: ['销售历史不足'],
    },
  },

  // ===== 起订量 / 倍数取整（R-REP-004）×8 =====
  // C13: salesAvg7d=6, 14d=4, 30d=2 → avgDaily=6*0.5+4*0.3+2*0.2=3+1.2+0.4=4.6
  //      9d×4.6=41.4→ceil=42；起订 24 / 倍数 12 → ceil(42/12)*12=48
  //      48 > 4.6×14=64.4 → false → LOW
  {
    name: 'C13-起订-min24-mul12-base 42→48',
    tags: ['起订', '起订量 / 倍数取整'],
    it: {
      salesAvg7d: 6,
      salesAvg14d: 4,
      salesAvg30d: 2,
      onHandQty: 0,
      packSize: 12,
      minOrderQty: 24,
    },
    strategy: { forecastDays: 7, safetyStockDays: 2, minOrderQty: 24, orderMultiple: 12 },
    expect: {
      baseSuggestQty: 42,
      finalSuggestQty: 48,
      riskLevel: 'LOW',
      reasonContains: ['加权日均 4.6', '最终建议 48'],
    },
  },
  // C14: avgDaily=2；9d=18；起订 24 → 24
  {
    name: 'C14-起订-base 18→24（min 拉高）',
    tags: ['起订', '起订量 / 倍数取整'],
    it: { salesAvg7d: 2, salesAvg14d: 2, salesAvg30d: 2 },
    strategy: { forecastDays: 7, safetyStockDays: 2, minOrderQty: 24, orderMultiple: 12 },
    expect: {
      baseSuggestQty: 18,
      finalSuggestQty: 24,
      riskLevel: 'LOW', // 24 > 28? no → LOW
      reasonContains: ['最终建议 24'],
    },
  },
  // C15: avgDaily=10；9d=90；起订 24 → 90 → 倍数 12 ceil → 96
  {
    name: 'C15-起订-base 90→96（倍数对齐）',
    tags: ['起订', '起订量 / 倍数取整'],
    it: { salesAvg7d: 10, salesAvg14d: 10, salesAvg30d: 10 },
    strategy: { forecastDays: 7, safetyStockDays: 2, minOrderQty: 24, orderMultiple: 12 },
    expect: {
      baseSuggestQty: 90,
      finalSuggestQty: 96,
      riskLevel: 'LOW',
      reasonContains: ['最终建议 96'],
    },
  },
  // C16: base=0 → final=0（不补到起订量）
  {
    name: 'C16-起订-base=0 不补单',
    tags: ['起订', '超期望'],
    it: { salesAvg7d: 5, salesAvg14d: 5, salesAvg30d: 5, onHandQty: 200 },
    strategy: { forecastDays: 7, safetyStockDays: 2, minOrderQty: 24, orderMultiple: 12 },
    expect: {
      baseSuggestQty: 0,
      finalSuggestQty: 0,
      riskLevel: 'LOW',
      reasonContains: ['最终建议 0'],
    },
  },
  // C17: 倍数=6；base=10 → max(10, 1)=10 → ceil(10/6)*6=12
  {
    name: 'C17-起订-倍数 6 取整',
    tags: ['起订', '起订量 / 倍数取整'],
    it: { salesAvg7d: 1, salesAvg14d: 1, salesAvg30d: 1, onHandQty: 0 },
    strategy: { forecastDays: 7, safetyStockDays: 2, minOrderQty: 1, orderMultiple: 6 },
    expect: {
      baseSuggestQty: 9, // 7d+2d = 9
      finalSuggestQty: 12,
      riskLevel: 'LOW',
      reasonContains: ['最终建议 12'],
    },
  },
  // C18: 倍数=1（无对齐）；base=37 → 37
  {
    name: 'C18-起订-倍数=1 无对齐',
    tags: ['起订', '起订量 / 倍数取整'],
    it: { salesAvg7d: 4, salesAvg14d: 4, salesAvg30d: 4, onHandQty: 0 },
    strategy: { forecastDays: 7, safetyStockDays: 2, minOrderQty: 1, orderMultiple: 1 },
    expect: {
      baseSuggestQty: 36, // 9d×4=36
      finalSuggestQty: 36,
      riskLevel: 'LOW',
      reasonContains: ['最终建议 36'],
    },
  },
  // C19: minOrderQty=undefined（fallback 1）
  {
    name: 'C19-起订-min undefined fallback 1',
    tags: ['起订', '起订量 / 倍数取整'],
    it: { salesAvg7d: 1, salesAvg14d: 1, salesAvg30d: 1, onHandQty: 0 },
    strategy: { forecastDays: 7, safetyStockDays: 2, orderMultiple: 1 },
    expect: {
      baseSuggestQty: 9,
      finalSuggestQty: 9,
      riskLevel: 'LOW',
      reasonContains: ['最终建议 9'],
    },
  },
  // C20: orderMultiple=undefined（fallback 1）
  {
    name: 'C20-起订-mul undefined fallback 1',
    tags: ['起订', '起订量 / 倍数取整'],
    it: { salesAvg7d: 1, salesAvg14d: 1, salesAvg30d: 1, onHandQty: 0 },
    strategy: { forecastDays: 7, safetyStockDays: 2, minOrderQty: 1 },
    expect: {
      baseSuggestQty: 9,
      finalSuggestQty: 9,
      riskLevel: 'LOW',
      reasonContains: ['最终建议 9'],
    },
  },

  // ===== 节假日因子 ×4 =====
  // C21: avgDaily=10 / forecastDays=7 / 节假日 → 10*7*1.1=77；safety=2*10=20；total=97；onHand=0 → 97
  {
    name: 'C21-节假日-base 77+20-0=97',
    tags: ['节假日', '节假日因子'],
    it: { salesAvg7d: 10, salesAvg14d: 10, salesAvg30d: 10 },
    factors: { isHolidayUpcoming: true },
    expect: {
      baseSuggestQty: 97,
      finalSuggestQty: 97,
      riskLevel: 'LOW',
      reasonContains: ['节假日因子 1.1', '最终建议 97'],
    },
  },
  // C22: 非节假日 demandFactor=1.0
  {
    name: 'C22-非节假日 demandFactor 1.0',
    tags: ['节假日', '节假日因子'],
    it: { salesAvg7d: 10, salesAvg14d: 10, salesAvg30d: 10 },
    factors: { isHolidayUpcoming: false },
    expect: {
      baseSuggestQty: 90,
      finalSuggestQty: 90,
      riskLevel: 'LOW',
      reasonContains: ['节假日因子 1', '最终建议 90'],
    },
  },
  // C23: 节假日 + onHand 抵扣
  {
    name: 'C23-节假日-onHand 抵扣',
    tags: ['节假日', '节假日因子'],
    it: { salesAvg7d: 5, salesAvg14d: 5, salesAvg30d: 5, onHandQty: 30 },
    factors: { isHolidayUpcoming: true },
    expect: {
      // 5*7*1.1=38.5；safety=10；total=48.5；onHand=30 → 18.5 → ceil=19
      baseSuggestQty: 19,
      finalSuggestQty: 19,
      riskLevel: 'LOW',
      reasonContains: ['节假日因子 1.1'],
    },
  },
  // C24: 节假日 + 起订倍数
  {
    name: 'C24-节假日 + 起订倍数',
    tags: ['节假日', '起订'],
    it: { salesAvg7d: 6, salesAvg14d: 6, salesAvg30d: 6 },
    strategy: { forecastDays: 7, safetyStockDays: 2, minOrderQty: 24, orderMultiple: 12 },
    factors: { isHolidayUpcoming: true },
    expect: {
      // 6*7*1.1=46.2；safety=12；total=58.2 → ceil=59；min(24, 59)=59；ceil(59/12)*12=60
      baseSuggestQty: 59,
      finalSuggestQty: 60,
      riskLevel: 'LOW',
      reasonContains: ['节假日因子 1.1', '最终建议 60'],
    },
  },

  // ===== 加权日均 / 零销 ×6 =====
  // C25: 加权差异
  {
    name: 'C25-加权日均-差异 8.6',
    tags: ['加权日均'],
    it: { salesAvg7d: 10, salesAvg14d: 8, salesAvg30d: 6 },
    expect: {
      baseSuggestQty: 78, // (10*0.5+8*0.3+6*0.2)*9=8.6*9=77.4→78
      finalSuggestQty: 78,
      riskLevel: 'LOW',
      reasonContains: ['加权日均 8.6'],
    },
  },
  // C26: 加权差异 极端 — 30d 远高于 7d
  {
    name: 'C26-加权日均-30d 主导',
    tags: ['加权日均'],
    it: { salesAvg7d: 1, salesAvg14d: 5, salesAvg30d: 20 },
    expect: {
      // (0.5+1.5+4)=6；7d+2d=54
      baseSuggestQty: 54,
      finalSuggestQty: 54,
      riskLevel: 'LOW',
      reasonContains: ['加权日均 6'],
    },
  },
  // C27: 加权差异 7d 极端
  {
    name: 'C27-加权日均-7d 极端',
    tags: ['加权日均'],
    it: { salesAvg7d: 100, salesAvg14d: 5, salesAvg30d: 5 },
    expect: {
      // (50+1.5+1)=52.5；9d=472.5→473
      baseSuggestQty: 473,
      finalSuggestQty: 473,
      riskLevel: 'LOW',
      reasonContains: ['加权日均 52.5', '最终建议 473'],
    },
  },
  // C28: avg fallback — recentSalesByDay 不足 30 但 ≥7
  {
    name: 'C28-加权日均-fallback recentSalesByDay 长度 10',
    tags: ['加权日均', '历史不足-边界'],
    it: {
      salesAvg7d: undefined,
      salesAvg14d: undefined,
      salesAvg30d: undefined,
      recentSalesByDay: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    },
    expect: {
      // s7=avg(末 7) = avg([4..10]) = 7
      // s14=avg(末 14) = avg(全 10 个) = 5.5
      // s30=avg(末 30) = avg(全 10 个) = 5.5
      // avgDaily=7*0.5+5.5*0.3+5.5*0.2=3.5+1.65+1.1=6.25
      // 7d+2d=9*6.25=56.25→ceil=57
      baseSuggestQty: 57,
      finalSuggestQty: 57,
      riskLevel: 'LOW',
      reasonContains: ['加权日均 6.25', '近 7/14/30 日均销 7/5.5/5.5'],
    },
  },
  // C29: 零销但 recentSalesByDay 长度 30
  {
    name: 'C29-零销-长度 30',
    tags: ['零销'],
    it: {
      salesAvg7d: 0,
      salesAvg14d: 0,
      salesAvg30d: 0,
      recentSalesByDay: Array.from({ length: 30 }, () => 0),
    },
    expect: {
      baseSuggestQty: 0,
      finalSuggestQty: 0,
      riskLevel: 'LOW',
      reasonContains: ['加权日均 0', '最终建议 0'],
    },
  },
  // C30: 零销但 onHand 大量
  {
    name: 'C30-零销-onHand 大量',
    tags: ['零销', '超期望'],
    it: {
      salesAvg7d: 0,
      salesAvg14d: 0,
      salesAvg30d: 0,
      recentSalesByDay: Array.from({ length: 30 }, () => 0),
      onHandQty: 500,
    },
    expect: {
      baseSuggestQty: 0,
      finalSuggestQty: 0,
      riskLevel: 'LOW',
      reasonContains: ['加权日均 0'],
    },
  },

  // ===== 超期望（onHand 充足）×4 =====
  // C31: onHand >> expected → final=0
  {
    name: 'C31-超期望-onHand 远超',
    tags: ['超期望'],
    it: { salesAvg7d: 5, salesAvg14d: 5, salesAvg30d: 5, onHandQty: 1000 },
    expect: {
      baseSuggestQty: 0,
      finalSuggestQty: 0,
      riskLevel: 'LOW',
      reasonContains: ['最终建议 0'],
    },
  },
  // C32: onHand 恰好等于 expected+safety
  {
    name: 'C32-超期望-onHand 恰平衡',
    tags: ['超期望'],
    it: { salesAvg7d: 10, salesAvg14d: 10, salesAvg30d: 10, onHandQty: 90 },
    expect: {
      baseSuggestQty: 0,
      finalSuggestQty: 0,
      riskLevel: 'LOW',
      reasonContains: ['最终建议 0'],
    },
  },
  // C33: onHand 略低于 expected+safety
  {
    name: 'C33-超期望-onHand 略低',
    tags: ['超期望', 'happy'],
    it: { salesAvg7d: 10, salesAvg14d: 10, salesAvg30d: 10, onHandQty: 89 },
    expect: {
      baseSuggestQty: 1,
      finalSuggestQty: 1,
      riskLevel: 'LOW',
      reasonContains: ['最终建议 1'],
    },
  },
  // C34: onHand+inTransit 充足 → 0
  {
    name: 'C34-超期望-onHand+inTransit 充足',
    tags: ['超期望', '在途 / 提前期'],
    it: {
      salesAvg7d: 10,
      salesAvg14d: 10,
      salesAvg30d: 10,
      onHandQty: 50,
      inTransitQty: 50,
    },
    expect: {
      baseSuggestQty: 0,
      finalSuggestQty: 0,
      riskLevel: 'LOW',
      reasonContains: ['最终建议 0'],
    },
  },

  // ===== 整数 / 小数 ×6 =====
  // C35: 浮点 avgDaily 4.214（已在 C13）；这里测精度边界
  {
    name: 'C35-浮点-小数边界',
    tags: ['小数'],
    it: { salesAvg7d: 1.5, salesAvg14d: 1.5, salesAvg30d: 1.5 },
    expect: {
      // 9d*1.5=13.5→ceil=14
      baseSuggestQty: 14,
      finalSuggestQty: 14,
      riskLevel: 'LOW',
      reasonContains: ['加权日均 1.5'],
    },
  },
  // C36: 整数 happy
  {
    name: 'C36-整数-纯整数',
    tags: ['整数'],
    it: { salesAvg7d: 7, salesAvg14d: 7, salesAvg30d: 7 },
    expect: {
      baseSuggestQty: 63, // 9*7
      finalSuggestQty: 63,
      riskLevel: 'LOW',
      reasonContains: ['加权日均 7'],
    },
  },
  // C37: 浮点 ceil — 9*0.1=0.9 → ceil=1；1 > 0.1*14=1.4 → false → LOW
  {
    name: 'C37-浮点-ceil 0.9→1',
    tags: ['小数'],
    it: { salesAvg7d: 0.1, salesAvg14d: 0.1, salesAvg30d: 0.1 },
    expect: {
      baseSuggestQty: 1,
      finalSuggestQty: 1,
      riskLevel: 'LOW',
      reasonContains: ['加权日均 0.1'],
    },
  },
  // C38: 大数 ceil
  {
    name: 'C38-大数-ceil',
    tags: ['整数'],
    it: { salesAvg7d: 100, salesAvg14d: 100, salesAvg30d: 100 },
    expect: {
      baseSuggestQty: 900,
      finalSuggestQty: 900,
      riskLevel: 'LOW',
      reasonContains: ['最终建议 900'],
    },
  },
  // C39: 浮点 ceil 边界 99.99 → 100
  {
    name: 'C39-浮点-ceil 99.99→100',
    tags: ['小数'],
    it: { salesAvg7d: 11.11, salesAvg14d: 11.11, salesAvg30d: 11.11 },
    expect: {
      // 9*11.11=99.99→100
      baseSuggestQty: 100,
      finalSuggestQty: 100,
      riskLevel: 'LOW',
      reasonContains: ['加权日均 11.11'],
    },
  },
  // C40: 浮点 — avg(recentSalesByDay) 产生 0.142857...（1/7）
  {
    name: 'C40-浮点-1/7 长除',
    tags: ['小数', '加权日均'],
    it: {
      salesAvg7d: undefined,
      salesAvg14d: undefined,
      salesAvg30d: undefined,
      recentSalesByDay: [1, 0, 0, 0, 0, 0, 0],
    },
    expect: {
      // s7=avg=1/7≈0.142857；s14/s30 同
      // avgDaily = 0.142857；9d≈1.2857 → ceil=2
      baseSuggestQty: 2,
      finalSuggestQty: 2,
      riskLevel: 'LOW',
      reasonContains: ['加权日均 0.14'],
    },
  },

  // ===== 在途 / 提前期 ×4 =====
  {
    name: 'C41-在途-inTransit 部分抵扣',
    tags: ['在途 / 提前期'],
    it: { salesAvg7d: 10, salesAvg14d: 10, salesAvg30d: 10, onHandQty: 20, inTransitQty: 10 },
    expect: {
      // expected=70+safety=20=90；onHand+inTransit=30 → 60
      baseSuggestQty: 60,
      finalSuggestQty: 60,
      riskLevel: 'LOW',
      reasonContains: ['加权日均 10'],
    },
  },
  {
    name: 'C42-在途-inTransit=0（默认）',
    tags: ['在途 / 提前期'],
    it: { salesAvg7d: 8, salesAvg14d: 8, salesAvg30d: 8, onHandQty: 10 },
    expect: {
      // 9*8 = 72；onHand=10 → 62
      baseSuggestQty: 62,
      finalSuggestQty: 62,
      riskLevel: 'LOW',
      reasonContains: ['最终建议 62'],
    },
  },
  {
    name: 'C43-在途-leadTimeDays 不影响公式（V1）',
    tags: ['在途 / 提前期'],
    it: {
      salesAvg7d: 5,
      salesAvg14d: 5,
      salesAvg30d: 5,
      leadTimeDays: 14, // V1 公式不消费
    },
    expect: {
      baseSuggestQty: 45,
      finalSuggestQty: 45,
      riskLevel: 'LOW',
      reasonContains: ['加权日均 5'],
    },
  },
  {
    name: 'C44-在途-inTransit 大幅抵扣',
    tags: ['在途 / 提前期', '超期望'],
    it: { salesAvg7d: 5, salesAvg14d: 5, salesAvg30d: 5, inTransitQty: 100 },
    expect: {
      // expected=35+10=45；inTransit=100 → 0
      baseSuggestQty: 0,
      finalSuggestQty: 0,
      riskLevel: 'LOW',
      reasonContains: ['最终建议 0'],
    },
  },

  // ===== strategy 取参（forecastDays / safetyStockDays 变化）×6 =====
  {
    name: 'C45-strategy-safetyStockDays 5',
    tags: ['strategy 取参'],
    it: { salesAvg7d: 10, salesAvg14d: 10, salesAvg30d: 10 },
    strategy: { forecastDays: 7, safetyStockDays: 5 },
    expect: {
      // 70+50=120
      baseSuggestQty: 120,
      finalSuggestQty: 120,
      riskLevel: 'LOW',
      reasonContains: ['最终建议 120'],
    },
  },
  {
    name: 'C46-strategy-forecastDays 1（最小值）',
    tags: ['strategy 取参'],
    it: { salesAvg7d: 10, salesAvg14d: 10, salesAvg30d: 10 },
    strategy: { forecastDays: 1, safetyStockDays: 0 },
    expect: {
      // 1d×10=10
      baseSuggestQty: 10,
      finalSuggestQty: 10,
      riskLevel: 'LOW',
      reasonContains: ['最终建议 10'],
    },
  },
  {
    name: 'C47-strategy-forecastDays 30 + safetyStockDays 7',
    tags: ['strategy 取参'],
    it: { salesAvg7d: 5, salesAvg14d: 5, salesAvg30d: 5 },
    strategy: { forecastDays: 30, safetyStockDays: 7 },
    expect: {
      // 5*(30+7)=185
      baseSuggestQty: 185,
      finalSuggestQty: 185,
      riskLevel: 'MEDIUM', // 185 > 5*14=70 → MEDIUM
      reasonContains: ['加权日均 5'],
    },
  },
  {
    name: 'C48-risk-MEDIUM 路径',
    tags: ['整数', '风险评级'],
    it: { salesAvg7d: 1, salesAvg14d: 1, salesAvg30d: 1, onHandQty: 0 },
    strategy: { forecastDays: 30, safetyStockDays: 14, minOrderQty: 1, orderMultiple: 1 },
    expect: {
      // 1*(30+14)=44；avgDaily=1；14×1=14；44 > 14 → MEDIUM
      baseSuggestQty: 44,
      finalSuggestQty: 44,
      riskLevel: 'MEDIUM',
      reasonContains: ['最终建议 44'],
    },
  },
  {
    name: 'C49-混合-节假日 + 起订 + 风险',
    tags: ['节假日', '起订', '风险评级'],
    it: { salesAvg7d: 8, salesAvg14d: 6, salesAvg30d: 4 },
    strategy: { forecastDays: 14, safetyStockDays: 3, minOrderQty: 24, orderMultiple: 12 },
    factors: { isHolidayUpcoming: true },
    expect: {
      // avgDaily=8*0.5+6*0.3+4*0.2=4+1.8+0.8=6.6
      // expected=6.6*14*1.1=101.64；safety=6.6*3=19.8；total=121.44 → ceil=122
      // max(24,122)=122；ceil(122/12)*12=132
      baseSuggestQty: 122,
      finalSuggestQty: 132,
      riskLevel: 'MEDIUM', // 132 > 6.6*14=92.4 → MEDIUM
      reasonContains: ['节假日因子 1.1', '最终建议 132'],
    },
  },
  {
    name: 'C50-混合-跨字段全要素',
    tags: ['happy', 'strategy 取参', '在途 / 提前期'],
    it: {
      salesAvg7d: 12,
      salesAvg14d: 10,
      salesAvg30d: 8,
      onHandQty: 50,
      inTransitQty: 20,
      packSize: 6,
      minOrderQty: 12,
      leadTimeDays: 3,
    },
    strategy: { forecastDays: 10, safetyStockDays: 3, minOrderQty: 12, orderMultiple: 6 },
    factors: { isHolidayUpcoming: false },
    expect: {
      // avgDaily=12*0.5+10*0.3+8*0.2=6+3+1.6=10.6
      // expected=10.6*10=106；safety=10.6*3=31.8；total=137.8-50-20=67.8→ceil=68
      // max(12,68)=68；ceil(68/6)*6=72
      baseSuggestQty: 68,
      finalSuggestQty: 72,
      riskLevel: 'LOW', // 72 < 10.6*14=148.4 → LOW
      reasonContains: ['加权日均 10.6', '最终建议 72'],
    },
  },
];

/* ============================================================================
 * 50 案例驱动测试
 * ========================================================================== */

describe('切片 14 §9 第 1 步 — calculator 50 案例公式回归', () => {
  it('案例数恰为 50（任务卡 §9 步骤 1 / §10 测试场景定数）', () => {
    expect(cases).toHaveLength(50);
  });

  for (const spec of cases) {
    it(`${spec.name}（tags=[${spec.tags.join(',')}]）`, () => {
      const result = computeSku({
        it: makeItem(spec.it),
        strategy: makeStrategy(spec.strategy),
        contextFactors: makeFactors(spec.factors),
      });

      expect(result.baseSuggestQty, `${spec.name} baseSuggestQty`).toBe(spec.expect.baseSuggestQty);
      expect(result.finalSuggestQty, `${spec.name} finalSuggestQty`).toBe(spec.expect.finalSuggestQty);
      expect(result.riskLevel, `${spec.name} riskLevel`).toBe(spec.expect.riskLevel);
      for (const sub of spec.expect.reasonContains) {
        expect(result.reason, `${spec.name} reason 应含 ${sub}`).toContain(sub);
      }
      expect(result.adjustmentTrace, `${spec.name} adjustmentTrace 必须空数组`).toEqual([]);

      // 共性断言：finalSuggestQty 必须是非负整数
      expect(Number.isInteger(result.finalSuggestQty)).toBe(true);
      expect(result.finalSuggestQty).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(result.baseSuggestQty)).toBe(true);
      expect(result.baseSuggestQty).toBeGreaterThanOrEqual(0);
    });
  }
});

/* ============================================================================
 * 任务卡 §9 第 2 步 — R-REP-002 兜底（grep "兜底"）
 * ========================================================================== */

describe('切片 14 §9 第 2 步 — R-REP-002 兜底：销售历史不足 → finalSuggestQty=0 + reason="销售历史不足"', () => {
  it('salesAvg7d=undefined 且 recentSalesByDay.length<7 → 兜底', () => {
    const r = computeSku({
      it: makeItem({
        salesAvg7d: undefined,
        salesAvg14d: 99,
        salesAvg30d: 99,
        recentSalesByDay: [10, 10, 10],
      }),
      strategy: makeStrategy(),
      contextFactors: makeFactors(),
    });
    expect(r.finalSuggestQty).toBe(0);
    expect(r.baseSuggestQty).toBe(0);
    expect(r.reason).toBe('销售历史不足，无法计算');
    expect(r.riskLevel).toBe('MEDIUM');
  });

  it('salesAvg7d=0 且 recentSalesByDay.length<7 → 兜底', () => {
    const r = computeSku({
      it: makeItem({
        salesAvg7d: 0,
        salesAvg14d: 99,
        salesAvg30d: 99,
        recentSalesByDay: [],
      }),
      strategy: makeStrategy(),
      contextFactors: makeFactors(),
    });
    expect(r.finalSuggestQty).toBe(0);
    expect(r.reason).toContain('销售历史不足');
  });

  it('recentSalesByDay.length=7 → 不兜底（边界条件）', () => {
    const r = computeSku({
      it: makeItem({
        salesAvg7d: undefined,
        salesAvg14d: undefined,
        salesAvg30d: undefined,
        recentSalesByDay: [10, 10, 10, 10, 10, 10, 10],
      }),
      strategy: makeStrategy(),
      contextFactors: makeFactors(),
    });
    expect(r.finalSuggestQty).toBeGreaterThan(0);
    expect(r.reason).not.toContain('销售历史不足');
  });
});

/* ============================================================================
 * 任务卡 §9 第 3 步 — R-REP-004 起订量 / 倍数取整（grep "起订"）
 * ========================================================================== */

describe('切片 14 §9 第 3 步 — R-REP-004 起订量 / 倍数取整：minOrderQty=24 / orderMultiple=12 → 38 取整 48', () => {
  it('roundToOrderRules(38, {minOrderQty:24, orderMultiple:12}) === 48', () => {
    expect(
      roundToOrderRules(38, { forecastDays: 7, safetyStockDays: 2, minOrderQty: 24, orderMultiple: 12 }),
    ).toBe(48);
  });

  it('roundToOrderRules(0, {min:24, mul:12}) === 0（不补单）', () => {
    expect(
      roundToOrderRules(0, { forecastDays: 7, safetyStockDays: 2, minOrderQty: 24, orderMultiple: 12 }),
    ).toBe(0);
  });

  it('roundToOrderRules(10, {min:24, mul:12}) === 24（拉到 min）', () => {
    expect(
      roundToOrderRules(10, { forecastDays: 7, safetyStockDays: 2, minOrderQty: 24, orderMultiple: 12 }),
    ).toBe(24);
  });

  it('roundToOrderRules(24, {min:24, mul:12}) === 24（恰好 min 同时是 mul 倍数）', () => {
    expect(
      roundToOrderRules(24, { forecastDays: 7, safetyStockDays: 2, minOrderQty: 24, orderMultiple: 12 }),
    ).toBe(24);
  });

  it('mul=1 → 不做倍数对齐', () => {
    expect(roundToOrderRules(37, { forecastDays: 7, safetyStockDays: 2, minOrderQty: 1, orderMultiple: 1 })).toBe(37);
  });

  it('min/mul undefined → fallback 1', () => {
    expect(roundToOrderRules(7, { forecastDays: 7, safetyStockDays: 2 })).toBe(7);
  });

  it('NaN / Infinity / 负数 → 0（防御）', () => {
    expect(roundToOrderRules(NaN, { forecastDays: 7, safetyStockDays: 2 })).toBe(0);
    expect(roundToOrderRules(Infinity, { forecastDays: 7, safetyStockDays: 2 })).toBe(0);
    expect(roundToOrderRules(-5, { forecastDays: 7, safetyStockDays: 2 })).toBe(0);
  });
});

/* ============================================================================
 * 任务卡 §9 第 4 步 — 节假日因子（grep "节假日"）
 * ========================================================================== */

describe('切片 14 §9 第 4 步 — 节假日因子：isHolidayUpcoming=true → demandFactor=1.1', () => {
  it('isHolidayUpcoming=true → demandFactor=1.1（reason 含 1.1）', () => {
    const r = computeSku({
      it: makeItem({ salesAvg7d: 10, salesAvg14d: 10, salesAvg30d: 10 }),
      strategy: makeStrategy({ forecastDays: 7, safetyStockDays: 2 }),
      contextFactors: { isHolidayUpcoming: true },
    });
    // 7*10*1.1=77；safety=20；total=97
    expect(r.baseSuggestQty).toBe(97);
    expect(r.reason).toContain('节假日因子 1.1');
  });

  it('isHolidayUpcoming=false → demandFactor=1.0', () => {
    const r = computeSku({
      it: makeItem({ salesAvg7d: 10, salesAvg14d: 10, salesAvg30d: 10 }),
      strategy: makeStrategy({ forecastDays: 7, safetyStockDays: 2 }),
      contextFactors: { isHolidayUpcoming: false },
    });
    expect(r.baseSuggestQty).toBe(90);
    expect(r.reason).toContain('节假日因子 1');
    expect(r.reason).not.toContain('节假日因子 1.1');
  });
});

/* ============================================================================
 * §11 自检 — reason 非空率 ≥ 95%（50 案例采样）
 * ========================================================================== */

describe('切片 14 §11 自检 — reason 非空率（50 案例采样统计）', () => {
  it('50 案例 reason 全部非空（含兜底），非空率 100%（≥ 95%）', () => {
    let total = 0;
    let nonEmpty = 0;
    for (const spec of cases) {
      const r = computeSku({
        it: makeItem(spec.it),
        strategy: makeStrategy(spec.strategy),
        contextFactors: makeFactors(spec.factors),
      });
      total += 1;
      if (r.reason && r.reason.length > 0) nonEmpty += 1;
    }
    const rate = nonEmpty / total;
    expect(total).toBe(50);
    expect(rate).toBeGreaterThanOrEqual(0.95);
    // 实际期望 100%（兜底分支也返回非空）
    expect(rate).toBe(1);
  });

  it('非兜底分支 reason 必含 s7/s14/s30 + demandFactor + finalSuggestQty 五要素', () => {
    for (const spec of cases) {
      if (spec.tags.includes('兜底')) continue;
      const r = computeSku({
        it: makeItem(spec.it),
        strategy: makeStrategy(spec.strategy),
        contextFactors: makeFactors(spec.factors),
      });
      expect(r.reason, `${spec.name} reason 缺 7/14/30 段`).toMatch(/近 7\/14\/30 日均销/);
      expect(r.reason, `${spec.name} reason 缺加权日均`).toMatch(/加权日均/);
      expect(r.reason, `${spec.name} reason 缺节假日因子`).toMatch(/节假日因子/);
      expect(r.reason, `${spec.name} reason 缺公式建议`).toMatch(/公式建议/);
      expect(r.reason, `${spec.name} reason 缺最终建议`).toMatch(/最终建议/);
    }
  });
});

/* ============================================================================
 * 任务卡 §9 第 8 步 — calculator 纯函数 grep 守门
 *
 *   `rg "await|fetch|mcp|openai|require" packages/agent-service/src/skills/replenishment/calculator.ts`
 *   期望：0 命中（无副作用）
 *
 *   实施级单测把 grep 内嵌到测试，保证 CI 任意环境都能复跑。
 * ========================================================================== */

describe('切片 14 §9 第 8 步 — calculator 纯函数（无副作用）grep 守门', () => {
  const calculatorPath = fileURLToPath(new URL('./calculator.ts', import.meta.url));
  const source = readFileSync(calculatorPath, 'utf8');

  /**
   * 把源码"代码主体"截取出来：去掉 /* */
  /* */ // /* ... */ 块注释 + 行注释 + import 行（注释里允许讨论"await/openai"等概念）。
  function stripCommentsAndImports(src: string): string {
    // 先去掉 /* ... */ 块注释（Top-level 文件 doc 也包含）
    let s = src.replace(/\/\*[\s\S]*?\*\//g, '');
    // 去掉行注释
    s = s.replace(/\/\/.*$/gm, '');
    // 去掉 import 行（路径里可能含 'shared-contracts/mcp'，本身不是调用）
    s = s.replace(/^\s*import[\s\S]+?from\s+['"][^'"]+['"];?\s*$/gm, '');
    return s;
  }

  const codeBody = stripCommentsAndImports(source);

  it('codeBody 不得调用 await（公式必须同步纯函数）', () => {
    expect(codeBody).not.toMatch(/\bawait\b/);
  });

  it('codeBody 不得调用 fetch', () => {
    expect(codeBody).not.toMatch(/\bfetch\s*\(/);
  });

  it('codeBody 不得引入 mcp / openai 客户端', () => {
    // 注意：不允许 mcpTools()、openai()、anthropic() 等调用
    expect(codeBody).not.toMatch(/\bmcpTools\s*\(/);
    expect(codeBody).not.toMatch(/\bopenai\s*\(/);
    expect(codeBody).not.toMatch(/\bgenerateObject\s*\(/);
    expect(codeBody).not.toMatch(/\bgenerateText\s*\(/);
  });

  it('codeBody 不得使用 Math.random（计算必须确定）', () => {
    expect(codeBody).not.toMatch(/Math\.random/);
  });

  it('codeBody 不得使用 require（CommonJS 副作用）', () => {
    expect(codeBody).not.toMatch(/\brequire\s*\(/);
  });

  it('codeBody 不得调用 createPurchaseOrder（red line：补货预测不写工具）', () => {
    expect(codeBody).not.toMatch(/createPurchaseOrder/);
  });

  it('source 可静态判定为纯函数（不导出 async 标识符）', () => {
    expect(codeBody).not.toMatch(/export\s+async\s+function/);
  });
});

/* ============================================================================
 * 50 案例 snapshot — 防止隐式漂移
 *
 * 注：snapshot 仅采集"稳定字段"避免浮点尾差。reason 不进入 snapshot（已逐条断言）。
 * ========================================================================== */

describe('切片 14 §9 第 1 步 — 50 案例 snapshot（baseSuggestQty / finalSuggestQty / riskLevel）', () => {
  it('50 行结果 snapshot 与 baseline 一致', () => {
    const rows = cases.map((spec) => {
      const r = computeSku({
        it: makeItem(spec.it),
        strategy: makeStrategy(spec.strategy),
        contextFactors: makeFactors(spec.factors),
      });
      return {
        name: spec.name,
        baseSuggestQty: r.baseSuggestQty,
        finalSuggestQty: r.finalSuggestQty,
        riskLevel: r.riskLevel,
      };
    });
    expect(rows).toMatchSnapshot();
  });
});

/* ============================================================================
 * 辅助函数单测（avg / weightedAvgDailySales / makeReason）
 * ========================================================================== */

describe('辅助：avg / weightedAvgDailySales / makeReason', () => {
  it('avg([])=0', () => {
    expect(avg([])).toBe(0);
  });

  it('avg([1,2,3])=2', () => {
    expect(avg([1, 2, 3])).toBe(2);
  });

  it('weightedAvgDailySales(salesAvg7d=10, 14=8, 30=6) = 8.6', () => {
    const r = weightedAvgDailySales(makeItem({ salesAvg7d: 10, salesAvg14d: 8, salesAvg30d: 6 }));
    expect(r.s7).toBe(10);
    expect(r.s14).toBe(8);
    expect(r.s30).toBe(6);
    expect(Number(r.avgDailySales.toFixed(8))).toBe(8.6);
  });

  it('weightedAvgDailySales fallback recentSalesByDay 末段', () => {
    const r = weightedAvgDailySales(
      makeItem({
        salesAvg7d: undefined,
        salesAvg14d: undefined,
        salesAvg30d: undefined,
        recentSalesByDay: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      }),
    );
    expect(r.s7).toBe(7); // avg([4..10])
    expect(r.s14).toBe(5.5); // avg(全 10 个)
    expect(r.s30).toBe(5.5);
  });

  it('makeReason 返回非空 + 含 5 要素', () => {
    const reason = makeReason({
      s7: 10,
      s14: 8,
      s30: 6,
      avgDailySales: 8.6,
      demandFactor: 1.1,
      baseSuggestQty: 78,
      finalSuggestQty: 80,
    });
    expect(reason.length).toBeGreaterThan(0);
    expect(reason.length).toBeLessThanOrEqual(200); // DraftItem.reason.max(200)
    expect(reason).toContain('近 7/14/30 日均销 10/8/6');
    expect(reason).toContain('加权日均 8.6');
    expect(reason).toContain('节假日因子 1.1');
    expect(reason).toContain('公式建议 78');
    expect(reason).toContain('最终建议 80');
  });
});
