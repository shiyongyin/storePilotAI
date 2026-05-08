/**
 * 切片 18 §8.6 — replenishment-forecast 纯函数 / 边界分支单测（补充覆盖率）
 *
 * 复杂的 step 主路径已由切片 14 集成测试 + business-reports-runtime 覆盖；本文件聚焦：
 *   - resolveForecastDays：用户取 min / 策略越界 / 最终越界三类异常
 *   - 公开导出的 helper 边界
 */
import { BizError } from '@storepilot/shared-contracts';
import { describe, expect, it } from 'vitest';

import { resolveForecastDays } from './replenishment-forecast.js';

describe('resolveForecastDays — 用户与策略上限合并 + 越界守门', () => {
  it('用户未传 → 用 strategy.forecastDays', () => {
    expect(resolveForecastDays({ strategyForecastDays: 7 })).toBe(7);
  });

  it('用户传入 → 取 min(user, strategy)', () => {
    expect(resolveForecastDays({ userForecastDays: 3, strategyForecastDays: 7 })).toBe(3);
    expect(resolveForecastDays({ userForecastDays: 14, strategyForecastDays: 7 })).toBe(7);
    expect(resolveForecastDays({ userForecastDays: 7, strategyForecastDays: 7 })).toBe(7);
  });

  it('strategyForecastDays 越界（0 / 31 / 非整数） → SCHEMA_FAIL', () => {
    expect(() => resolveForecastDays({ strategyForecastDays: 0 })).toThrow(BizError);
    expect(() => resolveForecastDays({ strategyForecastDays: 31 })).toThrow(BizError);
    expect(() => resolveForecastDays({ strategyForecastDays: 7.5 })).toThrow(BizError);
  });

  it('user=0 / NaN / 非整数 → effective 越界 → SCHEMA_FAIL', () => {
    expect(() =>
      resolveForecastDays({ userForecastDays: 0, strategyForecastDays: 7 }),
    ).toThrow(BizError);
    expect(() =>
      resolveForecastDays({ userForecastDays: Number.NaN, strategyForecastDays: 7 }),
    ).toThrow(BizError);
    expect(() =>
      resolveForecastDays({ userForecastDays: 3.5, strategyForecastDays: 7 }),
    ).toThrow(BizError);
  });

  it('strategy=1 边界 OK / strategy=30 边界 OK', () => {
    expect(resolveForecastDays({ strategyForecastDays: 1 })).toBe(1);
    expect(resolveForecastDays({ strategyForecastDays: 30 })).toBe(30);
  });
});
