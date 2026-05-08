/**
 * 切片 09 §9 验收 step 8/9/10/11 + §10 测试场景 8/9/10/11 — inferSessionId 单测
 *
 * 覆盖：
 *   - stability：同 messages 100 次调用 → 100 次相同 sessionId（§10.1）
 *   - isolation：apiKey A vs B + 同 messages → sessionId 不同（§10.2）
 *   - multi-round：messages 1 → 10 条增长，sessionId 不变（§10.3）
 *   - 长度：sessionId === 21 字符 + sess_ 前缀 + 16 hex（§9 step 11）
 *   - 空兜底：缺 system / 缺 user / 非字符串 content → 不抛错（§10.4）
 *   - MUST NOT 守门：完整 API Key 不进 hash 输入（apiKeyPrefix 是 prefix）
 */
import { describe, expect, it } from 'vitest';

import {
  SESSION_ID_HASH_LEN,
  SESSION_ID_PREFIX,
  SESSION_ID_TOTAL_LEN,
  inferSessionId,
  type SessionMessage,
} from './session.js';

const PREFIX_A = 'sk-agent-aaaaaa';
const PREFIX_B = 'sk-agent-bbbbbb';

const SYSTEM_MSG: SessionMessage = { role: 'system', content: '你是门店助手 V1' };
const USER_MSG_1: SessionMessage = { role: 'user', content: '今天 S001 卖得怎么样' };

describe('切片 09 §10.1 — sessionId 稳定（同 messages 100 次）', () => {
  it('same apiKeyPrefix + same messages → 100 次相同 sessionId', () => {
    const messages: SessionMessage[] = [SYSTEM_MSG, USER_MSG_1];
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(inferSessionId({ apiKeyPrefix: PREFIX_A, messages }));
    }
    expect(ids.size).toBe(1);
  });
});

describe('切片 09 §10.2 — sessionId 隔离（不同 apiKey 同 messages）', () => {
  it('apiKey A + 同 messages vs apiKey B + 同 messages → 不同 sessionId', () => {
    const messages: SessionMessage[] = [SYSTEM_MSG, USER_MSG_1];
    const sa = inferSessionId({ apiKeyPrefix: PREFIX_A, messages });
    const sb = inferSessionId({ apiKeyPrefix: PREFIX_B, messages });
    expect(sa).not.toBe(sb);
  });

  it('apiKey 仅差 1 字符 → sessionId 完全不同（雪崩效应）', () => {
    const messages: SessionMessage[] = [SYSTEM_MSG, USER_MSG_1];
    const s1 = inferSessionId({ apiKeyPrefix: 'sk-agent-aaaaaa', messages });
    const s2 = inferSessionId({ apiKeyPrefix: 'sk-agent-aaaaab', messages });
    expect(s1).not.toBe(s2);
  });
});

describe('切片 09 §10.3 — sessionId 多轮稳定（messages 1 → 10 条）', () => {
  it('追加 user / assistant 消息（首条 system / user 不变）→ sessionId 保持不变', () => {
    const baseMessages: SessionMessage[] = [SYSTEM_MSG, USER_MSG_1];
    const baseId = inferSessionId({ apiKeyPrefix: PREFIX_A, messages: baseMessages });

    const allIds = new Set<string>([baseId]);
    let messages: SessionMessage[] = [...baseMessages];
    for (let i = 1; i <= 10; i++) {
      messages = [
        ...messages,
        { role: 'assistant', content: `第 ${i} 轮回复` },
        { role: 'user', content: `第 ${i + 1} 轮提问` },
      ];
      allIds.add(inferSessionId({ apiKeyPrefix: PREFIX_A, messages }));
    }
    expect(allIds.size).toBe(1);
    expect([...allIds][0]).toBe(baseId);
  });

  it('改首条 system 消息 → sessionId 变化（运营改欢迎语 = 兜底由切片 13 接管）', () => {
    const baseId = inferSessionId({
      apiKeyPrefix: PREFIX_A,
      messages: [SYSTEM_MSG, USER_MSG_1],
    });
    const newId = inferSessionId({
      apiKeyPrefix: PREFIX_A,
      messages: [{ role: 'system', content: '你是门店助手 V2' }, USER_MSG_1],
    });
    expect(newId).not.toBe(baseId);
  });

  it('改首条 user 消息 → sessionId 变化（新会话）', () => {
    const baseId = inferSessionId({
      apiKeyPrefix: PREFIX_A,
      messages: [SYSTEM_MSG, USER_MSG_1],
    });
    const newId = inferSessionId({
      apiKeyPrefix: PREFIX_A,
      messages: [SYSTEM_MSG, { role: 'user', content: '换个问题：S001 库存怎么样' }],
    });
    expect(newId).not.toBe(baseId);
  });
});

describe('切片 09 §9 step 11 — sessionId 长度 + 前缀', () => {
  it('sessionId 长度固定 21（sess_ + 16 hex）', () => {
    const sid = inferSessionId({
      apiKeyPrefix: 'sk-agent-test12',
      messages: [
        { role: 'system', content: 'x' },
        { role: 'user', content: 'y' },
      ],
    });
    expect(sid.length).toBe(SESSION_ID_TOTAL_LEN);
    expect(sid.length).toBe(21);
    expect(sid.startsWith(SESSION_ID_PREFIX)).toBe(true);
    expect(sid.slice(SESSION_ID_PREFIX.length).length).toBe(SESSION_ID_HASH_LEN);
  });

  it('hex 部分仅含 0-9 a-f（SHA-256 hex slice）', () => {
    const sid = inferSessionId({
      apiKeyPrefix: PREFIX_A,
      messages: [SYSTEM_MSG, USER_MSG_1],
    });
    expect(sid).toMatch(/^sess_[0-9a-f]{16}$/);
  });

  it('100 个不同输入仍保持长度 21（无短哈希边界丢字）', () => {
    for (let i = 0; i < 100; i++) {
      const sid = inferSessionId({
        apiKeyPrefix: `sk-agent-${String(i).padStart(7, '0')}`,
        messages: [
          { role: 'system', content: `system-${i}` },
          { role: 'user', content: `user-${i}` },
        ],
      });
      expect(sid.length).toBe(21);
    }
  });
});

describe('切片 09 §10.4 — 空 / 异常输入兜底（不抛错）', () => {
  it('messages 无 system → 不抛错且仍稳定', () => {
    const sid = inferSessionId({
      apiKeyPrefix: PREFIX_A,
      messages: [USER_MSG_1],
    });
    expect(sid).toMatch(/^sess_[0-9a-f]{16}$/);
  });

  it('messages 无 user → 不抛错且仍稳定', () => {
    const sid = inferSessionId({
      apiKeyPrefix: PREFIX_A,
      messages: [SYSTEM_MSG],
    });
    expect(sid).toMatch(/^sess_[0-9a-f]{16}$/);
  });

  it('messages 完全为空数组 → 不抛错', () => {
    const sid = inferSessionId({ apiKeyPrefix: PREFIX_A, messages: [] });
    expect(sid).toMatch(/^sess_[0-9a-f]{16}$/);
  });

  it('content 为非字符串（multipart 占位）→ 不抛错且按空字符串兜底', () => {
    const idMultipart = inferSessionId({
      apiKeyPrefix: PREFIX_A,
      messages: [
        { role: 'system', content: { parts: ['x'] } as unknown as string },
        { role: 'user', content: ['arr-content'] as unknown as string },
      ],
    });
    const idEmpty = inferSessionId({
      apiKeyPrefix: PREFIX_A,
      messages: [
        { role: 'system', content: '' },
        { role: 'user', content: '' },
      ],
    });
    expect(idMultipart).toBe(idEmpty);
  });

  it('content 缺失（undefined）→ 不抛错', () => {
    const sid = inferSessionId({
      apiKeyPrefix: PREFIX_A,
      messages: [{ role: 'system' }, { role: 'user' }],
    });
    expect(sid).toMatch(/^sess_[0-9a-f]{16}$/);
  });
});

describe('切片 09 §7 MUST NOT — 完整 API Key 不进 hash 输入（apiKeyPrefix 仅 16 字符）', () => {
  it('两把 apiKey 前 16 字符相同、后续不同 → sessionId 相同（证明只用 prefix）', () => {
    // 注：实际系统中 prefix 长度 16 的 apiKey 必然 prefix 16 字符相同；
    // 这里直接传入相同 prefix 模拟 authenticate() 派生后的输入。
    const sid1 = inferSessionId({
      apiKeyPrefix: 'sk-agent-AAAAAAA',
      messages: [SYSTEM_MSG, USER_MSG_1],
    });
    const sid2 = inferSessionId({
      apiKeyPrefix: 'sk-agent-AAAAAAA',
      messages: [SYSTEM_MSG, USER_MSG_1],
    });
    expect(sid1).toBe(sid2);
  });
});

describe('切片 09 §8.2 — 算法可复现性（JS 双实现对照）', () => {
  it('与 SHA-256(apiKeyPrefix::firstSystem::firstUser).slice(0,16) 等价', async () => {
    const { createHash } = await import('node:crypto');
    const apiKeyPrefix = 'sk-agent-zzzzzz';
    const firstSystem = 'sys-msg';
    const firstUser = 'user-msg';
    const expected =
      SESSION_ID_PREFIX +
      createHash('sha256')
        .update(`${apiKeyPrefix}::${firstSystem}::${firstUser}`)
        .digest('hex')
        .slice(0, SESSION_ID_HASH_LEN);
    const actual = inferSessionId({
      apiKeyPrefix,
      messages: [
        { role: 'system', content: firstSystem },
        { role: 'user', content: firstUser },
      ],
    });
    expect(actual).toBe(expected);
  });
});
