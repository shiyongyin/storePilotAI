/**
 * 切片 09 — sessionId 服务端推断（T-BRIDGE-02）
 *
 * 严格按 docs/tanks/09-bridge-auth-session.md §8.2 + 任务卡 C-桥接层.md §T-BRIDGE-02 落地。
 *
 * 设计要点（任务卡 §6 MUST DO）：
 *   1. SHA-256 + 取前 16 字符 hex + `sess_` 前缀（共 21 字符）。
 *   2. 输入仅用 `apiKeyPrefix`（**不**用完整 API Key），避免敏感信息进 hash 链。
 *   3. `firstSystem` / `firstUser` 缺失时用空字符串兜底（不抛错）。
 *
 * 设计要点（任务卡 §7 MUST NOT）：
 *   1. 不依赖客户端传入的 sessionId（LobeChat 不传 metadata）。
 *   2. 不 hash 全部 messages（每条新消息都会变 sessionId → HITL 草稿丢失）。
 *   3. 不把完整 API Key 放进 hash 输入。
 *   4. 不在本切片实现 sessionId 漂移兜底（属切片 13 DraftManager.findRecentDraft）。
 *
 * 性能：SHA-256 + 字符串拼接，O(n) on first system + first user 长度，远低于 1ms。
 * 与切片 13 的兜底索引（按 merchantId/storeId/userId 取最近 5 分钟未提交草稿）配合，
 * 即便 system 欢迎语变化导致 sessionId 漂移，老板仍能找回草稿。
 */
import { createHash } from 'node:crypto';

/** sessionId 前缀（任务卡 §6 MUST DO §1） */
export const SESSION_ID_PREFIX = 'sess_';

/** SHA-256 取前 16 字符 hex（与 sess_ 拼接后共 21 字符；任务卡 §8 验收 step 11） */
export const SESSION_ID_HASH_LEN = 16;

/** 完整 sessionId 长度（5 字符前缀 + 16 字符 hex） */
export const SESSION_ID_TOTAL_LEN = SESSION_ID_PREFIX.length + SESSION_ID_HASH_LEN;

/**
 * 单条 chat message 的最小约束（不复用 OpenAI 完整 schema —— 本函数只读 role / content）。
 *
 * - `role`：通常为 `'system' | 'user' | 'assistant' | 'tool'`，本函数仅识别 `system` / `user`。
 * - `content`：字符串内容；非字符串（如 vision multipart）一律按空字符串兜底，避免抛错。
 */
export interface SessionMessage {
  role: string;
  content?: unknown;
}

export interface InferSessionIdArgs {
  /** API Key 前 16 字符（由 authenticate() 派生；**不传完整 key**） */
  apiKeyPrefix: string;
  /** LobeChat 重传的完整 messages 数组（首条 system / 首条 user 不变即 sessionId 稳定） */
  messages: ReadonlyArray<SessionMessage>;
}

/**
 * 服务端推断 sessionId（任务卡 §8.2 / §T-BRIDGE-02 §5）。
 *
 * 算法：`sess_` + SHA-256(apiKeyPrefix::firstSystem::firstUser).slice(0, 16)
 *
 * 稳定性：
 *   - 同 apiKey + 同首条 system + 同首条 user → 100 次相同 sessionId（任务卡 §10.1）。
 *   - 多轮对话（追加 user / assistant 消息）→ sessionId 不变（首条不动）（任务卡 §10.3）。
 *   - 同 messages + 不同 apiKey → 不同 sessionId（任务卡 §10.2）。
 *
 * 兜底：
 *   - 缺 system / 缺 user → 用空字符串（不抛错；任务卡 §6 MUST DO §3）。
 *   - 非字符串 content（如 multipart）→ 也按空字符串处理，保证函数永不抛错。
 *
 * @param args 见 {@link InferSessionIdArgs}
 * @returns 21 字符固定长度（5 字符前缀 + 16 字符 hex）的 sessionId
 */
export function inferSessionId(args: InferSessionIdArgs): string {
  const firstSystem = pickFirstStringContent(args.messages, 'system');
  const firstUser = pickFirstStringContent(args.messages, 'user');
  const raw = `${args.apiKeyPrefix}::${firstSystem}::${firstUser}`;
  const hex = createHash('sha256').update(raw).digest('hex').slice(0, SESSION_ID_HASH_LEN);
  return `${SESSION_ID_PREFIX}${hex}`;
}

/**
 * 取首条指定 role 的字符串 content；缺失或非字符串一律返回空串（兜底，不抛错）。
 */
function pickFirstStringContent(messages: ReadonlyArray<SessionMessage>, role: string): string {
  for (const m of messages) {
    if (m.role !== role) continue;
    return typeof m.content === 'string' ? m.content : '';
  }
  return '';
}
