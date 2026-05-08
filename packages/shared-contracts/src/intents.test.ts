/**
 * 切片 04 — Intent 单测
 * 行为断言:
 *   - 11 个 IntentCode 全部 parse 成功
 *   - 漂移值(如 'DAILY_REPORT')parse 失败
 *   - IntentRouterOutput 边界(confidence 0..1, reason ≤ 200)
 */
import { describe, expect, it } from 'vitest';

import { Intent, IntentEnum, IntentRouterOutput } from './intents.js';

describe('Intent 11 枚举', () => {
  it('Object.keys(Intent).length === 11', () => {
    expect(Object.keys(Intent)).toHaveLength(11);
  });

  it('IntentEnum.options 列出全部 11 项且与 Intent 一致', () => {
    expect(IntentEnum.options).toHaveLength(11);
    expect(new Set(IntentEnum.options)).toEqual(new Set(Object.values(Intent)));
  });

  it.each(Object.values(Intent))('IntentEnum.parse 接受 %s', (code) => {
    expect(IntentEnum.parse(code)).toBe(code);
  });

  it('IntentEnum.parse 拒绝漂移值 DAILY_REPORT', () => {
    expect(() => IntentEnum.parse('DAILY_REPORT')).toThrow();
  });

  it('IntentEnum.parse 拒绝小写形态', () => {
    expect(() => IntentEnum.parse('business_daily_report')).toThrow();
  });
});

describe('IntentRouterOutput 边界', () => {
  it('happy: 合法 intent + 0..1 confidence + ≤200 reason', () => {
    const out = IntentRouterOutput.parse({
      intent: 'BUSINESS_DAILY_REPORT',
      confidence: 0.92,
      reason: '识别为日报',
    });
    expect(out.intent).toBe('BUSINESS_DAILY_REPORT');
  });

  it('confidence 越界拒绝(>1)', () => {
    expect(() =>
      IntentRouterOutput.parse({ intent: 'GENERAL_QA', confidence: 1.1, reason: 'x' }),
    ).toThrow();
  });

  it('confidence 越界拒绝(<0)', () => {
    expect(() =>
      IntentRouterOutput.parse({ intent: 'GENERAL_QA', confidence: -0.1, reason: 'x' }),
    ).toThrow();
  });

  it('reason 超 200 字拒绝', () => {
    expect(() =>
      IntentRouterOutput.parse({
        intent: 'GENERAL_QA',
        confidence: 0.5,
        reason: 'a'.repeat(201),
      }),
    ).toThrow();
  });
});
