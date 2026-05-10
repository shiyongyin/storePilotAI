/**
 * 切片 06 §9.3 — RuntimeContext 透传单测
 * 验证 7 字段 set/get 完整一致；不实际启动 Mastra workflow（属切片 12+）。
 */
import { describe, expect, it } from 'vitest';

import { buildRuntimeContext, type AgentRuntime } from './runtime-context.js';

const sample: AgentRuntime = {
  traceId: 'trace_01HXYZ012345ABCDEFGHIJK01',
  sessionId: 'sess_M001_S001_boss-001',
  merchantId: 'M001',
  storeId: 'S001',
  userId: 'boss-001',
  apiKeyPrefix: 'sk-agent-abcd',
  requestStartedAt: 1715073600000,
};

describe('切片 06 — RuntimeContext / AgentRuntime 7 字段', () => {
  it('buildRuntimeContext 应当把 7 字段全部 set 进 RequestContext', () => {
    const ctx = buildRuntimeContext(sample);
    expect(ctx.get('traceId')).toBe(sample.traceId);
    expect(ctx.get('sessionId')).toBe(sample.sessionId);
    expect(ctx.get('merchantId')).toBe(sample.merchantId);
    expect(ctx.get('storeId')).toBe(sample.storeId);
    expect(ctx.get('userId')).toBe(sample.userId);
    expect(ctx.get('apiKeyPrefix')).toBe(sample.apiKeyPrefix);
    expect(ctx.get('requestStartedAt')).toBe(sample.requestStartedAt);
  });

  it('step1 set traceId → step2 read 一致（任务卡 §9.3 行为断言）', () => {
    const ctx = buildRuntimeContext({ ...sample, traceId: 'trace_step1AAAAAAAAAAAAAAAAAAAA00' });
    // 模拟 step1 set 后，step2 仍能 get 到（同一引用）
    const step2View = ctx;
    expect(step2View.get('traceId')).toBe('trace_step1AAAAAAAAAAAAAAAAAAAA00');
  });

  it('修改原 input 对象不应影响已构造的 context（拷贝语义）', () => {
    const input: AgentRuntime = { ...sample };
    const ctx = buildRuntimeContext(input);
    input.merchantId = 'M999';
    expect(ctx.get('merchantId')).toBe('M001');
  });

  it('buildRuntimeContext 应跳过 undefined optional 字段', () => {
    const ctx = buildRuntimeContext({
      ...sample,
      agentId: undefined,
    } as unknown as AgentRuntime);

    expect(ctx.get('agentId')).toBeUndefined();
    expect(ctx.get('merchantId')).toBe('M001');
  });
});
