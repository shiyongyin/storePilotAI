/**
 * 切片 04 — AgentSkillDef + RiskLevel 单测
 */
import { describe, expect, it } from 'vitest';

import { AgentSkillDef, RiskLevel } from './skills.js';

describe('RiskLevel', () => {
  it('LOW / MEDIUM / HIGH 三项', () => {
    expect(RiskLevel.options).toHaveLength(3);
    expect(new Set(RiskLevel.options)).toEqual(new Set(['LOW', 'MEDIUM', 'HIGH']));
  });
});

describe('AgentSkillDef', () => {
  const happy = {
    skillCode: 'business_daily_report',
    version: '1.0.0',
    allowedIntents: ['BUSINESS_DAILY_REPORT'],
    requiredTools: [],
    riskLevel: 'LOW' as const,
    status: 'enabled' as const,
  };

  it('happy', () => {
    expect(AgentSkillDef.parse(happy)).toBeDefined();
  });

  it('skillCode 必须 lower_snake_case(拒绝 PascalCase)', () => {
    expect(() => AgentSkillDef.parse({ ...happy, skillCode: 'BusinessDailyReport' })).toThrow();
  });

  it('skillCode 拒绝包含连字符', () => {
    expect(() => AgentSkillDef.parse({ ...happy, skillCode: 'business-daily-report' })).toThrow();
  });

  it('version 必须 SemVer(拒绝 1.0)', () => {
    expect(() => AgentSkillDef.parse({ ...happy, version: '1.0' })).toThrow();
  });

  it('allowedIntents 至少 1 项', () => {
    expect(() => AgentSkillDef.parse({ ...happy, allowedIntents: [] })).toThrow();
  });

  it('allowedIntents 必须是合法 IntentCode', () => {
    expect(() => AgentSkillDef.parse({ ...happy, allowedIntents: ['INVALID'] })).toThrow();
  });

  it('status 仅 enabled / disabled / gray', () => {
    expect(() => AgentSkillDef.parse({ ...happy, status: 'pending' })).toThrow();
  });
});
