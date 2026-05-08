/**
 * 切片 06 §9.4-§9.5 — 3 个 Agent 的 instructions 红线检查（不实际调 LLM）
 *
 * 验证:
 *   - intentRouter instructions 必须含 11 IntentEnum + JSON 输出格式
 *   - generalQa instructions 必须含"数字必须来自工具返回 / 不得编造"
 *   - requirementCollector V1 红线：含"不写任何数据库表 / 不可声称已落库"
 *   - 三个 Agent 都不得在 instructions 中泄漏 tool_calls / function_call
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { Intent } from '@storepilot/shared-contracts';

type AgentUnderTest = {
  id: string;
  name: string;
};

const ENV_FIXTURE: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '7100',
  DATABASE_URL: 'mysql://test:test@localhost:3306/test',
  MODEL_PROVIDER: 'openai-compatible',
  MODEL_BASE_URL: 'http://localhost:7100/llm',
  MODEL_API_KEY: 'sk-test-1234567890',
  MODEL_NAME: 'gpt-test',
  ERP_MCP_SERVER_URL: 'http://localhost:7300/mcp',
  MCP_TENANT_SHARED_SECRET: 'a'.repeat(32),
  MCP_PROTOCOL_VERSION: '2025-06-18',
  AGENT_API_KEY_HASH_SALT: 'salt-abcdef-1234',
  AGENT_API_KEY_PREFIX: 'sk-agent-',
  CORS_ALLOWED_ORIGINS: 'http://localhost:3210',
};

let intentRouter: AgentUnderTest;
let generalQa: AgentUnderTest;
let requirementCollector: AgentUnderTest;

beforeAll(async () => {
  for (const [key, value] of Object.entries(ENV_FIXTURE)) vi.stubEnv(key, value);
  ({ intentRouter } = await import('./intent-router.js'));
  ({ generalQa } = await import('./general-qa.js'));
  ({ requirementCollector } = await import('./requirement-collector.js'));
});

afterAll(() => {
  vi.unstubAllEnvs();
});

/** 取 Agent 的运行期 instructions（mastra 1.0 内部 DynamicAgentInstructions；用 getInstructions() 解析）。
 *  Agent.getInstructions 真实返回 SystemMessage（含 string / 数组 / 对象 union），
 *  本切片所有 Agent 都用静态字符串 instructions，运行期等价于直接 string。 */
async function readInstructions(agent: AgentUnderTest): Promise<string> {
  const fn = (agent as { getInstructions?: unknown }).getInstructions;
  if (typeof fn !== 'function') {
    throw new Error('agent.getInstructions 不是函数');
  }
  // 0 参调用：mastra 1.0 兼容 undefined RequestContext
  const value = await Promise.resolve((fn as (this: AgentUnderTest) => unknown).call(agent));
  if (typeof value !== 'string') {
    throw new Error(
      `getInstructions() 未返回字符串（本切片所有 Agent 都应是静态字符串），实际类型: ${typeof value}`,
    );
  }
  return value;
}

describe('切片 06 — intentRouter Agent', () => {
  it('id 与 name 都应为 "intentRouter"', () => {
    expect(intentRouter.id).toBe('intentRouter');
    expect(intentRouter.name).toBe('intentRouter');
  });

  it('instructions 必须包含 11 个 IntentCode 全部', async () => {
    const text = await readInstructions(intentRouter);
    for (const code of Object.values(Intent)) {
      expect(text, `instructions 缺少 IntentCode ${code}`).toContain(code);
    }
  });

  it('instructions 必须含严格 JSON 输出格式（intent / confidence / reason）', async () => {
    const text = await readInstructions(intentRouter);
    expect(text).toMatch(/严格的\s*JSON|JSON/);
    expect(text).toContain('"intent"');
    expect(text).toContain('"confidence"');
    expect(text).toContain('"reason"');
  });

  it('instructions 必须明确"不得泄漏 tool_calls / function_call / response_format"（红线）', async () => {
    const text = await readInstructions(intentRouter);
    expect(text).toMatch(/不得泄漏.*tool_calls|tool_calls.*function_call/);
  });
});

describe('切片 06 — generalQa Agent', () => {
  it('id / name 应为 "generalQa"', () => {
    expect(generalQa.id).toBe('generalQa');
    expect(generalQa.name).toBe('generalQa');
  });

  it('instructions 必须含"数字必须来自工具返回"（任务卡 §7 MUST DO §5）', async () => {
    const text = await readInstructions(generalQa);
    expect(text).toMatch(/数字必须来自工具返回/);
  });

  it('instructions 必须明确禁编造销售额 / 库存 / SKU', async () => {
    const text = await readInstructions(generalQa);
    expect(text).toContain('禁止编造');
    expect(text).toMatch(/销售额|库存|SKU/);
  });
});

describe('切片 06 — requirementCollector Agent（V1 红线）', () => {
  it('id / name 应为 "requirementCollector"', () => {
    expect(requirementCollector.id).toBe('requirementCollector');
    expect(requirementCollector.name).toBe('requirementCollector');
  });

  it('instructions 必须明确"不写任何数据库表"（任务卡 §7 MUST DO §6）', async () => {
    const text = await readInstructions(requirementCollector);
    expect(text).toContain('不写任何数据库表');
  });

  it('instructions 必须明确"绝不可声称已落库 / 已分配 / 已排期"', async () => {
    const text = await readInstructions(requirementCollector);
    expect(text).toMatch(/不可声称.*已落库|已落库.*已分配.*已排期/);
  });

  it('V1 不得提及 requirement_inbox 表名', async () => {
    const text = await readInstructions(requirementCollector);
    expect(text).not.toMatch(/requirement_inbox/);
  });
});
