#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import argon2 from 'argon2';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { BizError } from '../../shared-contracts/dist/index.js';
import {
  API_KEY_PREFIX_LENGTH,
  resetAuthPoolForTest,
  setAuthPool,
} from '../dist/bridge/auth.js';
import {
  _resetHeartbeatIntervalForTest,
  _setHeartbeatIntervalForTest,
  chatCompletionsRouter,
  resetDispatcherForTest,
  setDispatcher,
} from '../dist/api/chat-completions.js';

const TEST_API_KEY_HASH_SALT = 'unit-test-salt-32chars-xxxxxxxxxx';
const PLAINTEXT_API_KEY = 'sk-agent-test1234567890abcdefghijklmnopqrstuvwxyz0';
const VALID_AUTH_HEADER = `Bearer ${PLAINTEXT_API_KEY}`;

const DEFAULT_BODY_VALID = {
  model: 'store-agent-v1',
  stream: true,
  messages: [{ role: 'user', content: '今天 S001 卖得怎么样' }],
};

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const PORT = Number(process.env.SLICE10_VERIFY_PORT ?? 17110);

class FakeAuthPool {
  rows = new Map();

  insert(row) {
    this.rows.set(row.id, row);
  }

  query(sql, params) {
    const norm = sql.replace(/\s+/g, ' ').trim();
    if (!/FROM agent_api_key WHERE api_key_prefix = \? AND status = 'ENABLED'/i.test(norm)) {
      throw new Error(`FakeAuthPool: unexpected query SQL: ${norm}`);
    }
    const prefix = params[0];
    const rows = [...this.rows.values()].filter(
      (row) => row.api_key_prefix === prefix && row.status === 'ENABLED',
    );
    return Promise.resolve([rows, undefined]);
  }

  execute() {
    return Promise.resolve([{ affectedRows: 0 }, undefined]);
  }
}

function setEnv() {
  Object.assign(process.env, {
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
    AGENT_API_KEY_HASH_SALT: TEST_API_KEY_HASH_SALT,
    AGENT_API_KEY_PREFIX: 'sk-agent-',
    CORS_ALLOWED_ORIGINS: 'http://localhost:3210',
  });
}

async function seedAuth() {
  const pool = new FakeAuthPool();
  const hash = await argon2.hash(PLAINTEXT_API_KEY, {
    type: argon2.argon2id,
    secret: Buffer.from(TEST_API_KEY_HASH_SALT),
  });
  pool.insert({
    id: 1,
    api_key_hash: hash,
    api_key_prefix: PLAINTEXT_API_KEY.slice(0, API_KEY_PREFIX_LENGTH),
    merchant_id: 'M001',
    store_id: 'S001',
    user_id: 'boss-001',
    status: 'ENABLED',
    expires_at: null,
  });
  setAuthPool(pool);
}

function parseSse(raw) {
  return raw
    .split(/\r?\n\r?\n/)
    .map((block) => block.trimEnd())
    .filter(Boolean)
    .map((block) => {
      let event = null;
      const data = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
        if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
      }
      return { event, data: data.join('\n') };
    });
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function curl(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('curl', ['--max-time', '5', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`curl failed (${code}): ${stderr || stdout}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function curlSse(baseUrl, body) {
  const raw = await curl([
    '-sS',
    '-N',
    '-H',
    `Authorization: ${VALID_AUTH_HEADER}`,
    '-H',
    'Content-Type: application/json',
    '-d',
    JSON.stringify(body),
    `${baseUrl}/v1/chat/completions`,
  ]);
  return parseSse(raw);
}

function dataChunks(events) {
  return events
    .filter((event) => event.event === null && event.data.startsWith('{'))
    .map((event) => JSON.parse(event.data));
}

async function main() {
  setEnv();
  await seedAuth();

  const app = new Hono();
  app.get('/__ping', (c) => c.text('ok'));
  app.route('/v1', chatCompletionsRouter);

  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: PORT });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const baseUrl = `http://127.0.0.1:${PORT}`;

  try {
    expect((await curl(['-sS', `${baseUrl}/__ping`])) === 'ok', 'local verifier server did not answer ping');
    console.log('PASS local server ping');

    setDispatcher(() => Promise.resolve({ finalText: 'alpha'.repeat(80) }));
    const happy = await curlSse(baseUrl, DEFAULT_BODY_VALID);
    const happyChunks = dataChunks(happy);
    expect(happyChunks.length >= 3, 'happy path should return data chunks plus finish chunk');
    expect(happyChunks[0]?.object === 'chat.completion.chunk', 'chunk object mismatch');
    expect(happy.at(-1)?.data === '[DONE]', 'last SSE data must be [DONE]');
    expect(
      happyChunks.at(-1)?.choices[0]?.finish_reason === 'stop',
      'finish_reason=stop chunk must precede [DONE]',
    );
    console.log('PASS happy chunk/object/termination');

    const headers = await curl([
      '-sS',
      '-N',
      '-D',
      '-',
      '-o',
      '/dev/null',
      '-H',
      `Authorization: ${VALID_AUTH_HEADER}`,
      '-H',
      'Content-Type: application/json',
      '-d',
      JSON.stringify(DEFAULT_BODY_VALID),
      `${baseUrl}/v1/chat/completions`,
    ]);
    expect(/x-accel-buffering:\s*no/i.test(headers), 'missing X-Accel-Buffering: no');
    expect(/cache-control:\s*no-cache, no-transform/i.test(headers), 'missing Cache-Control');
    expect(/connection:\s*keep-alive/i.test(headers), 'missing Connection: keep-alive');
    console.log('PASS SSE headers');

    _setHeartbeatIntervalForTest(50);
    setDispatcher(async () => {
      await new Promise((resolve) => setTimeout(resolve, 260));
      return { finalText: 'after heartbeat' };
    });
    const heartbeat = await curlSse(baseUrl, DEFAULT_BODY_VALID);
    expect(heartbeat.filter((event) => event.event === 'ping').length >= 4, 'expected at least 4 ping events');
    _resetHeartbeatIntervalForTest();
    console.log('PASS heartbeat ping');

    setDispatcher(async () => {
      throw new BizError('MCP_TIMEOUT', 'upstream timeout');
    });
    const midStreamError = await curlSse(baseUrl, DEFAULT_BODY_VALID);
    const midStreamRaw = JSON.stringify(midStreamError);
    expect(!midStreamRaw.includes('"error":{'), 'mid-stream error must not be OpenAI JSON error body');
    expect(midStreamRaw.includes('ERP'), 'mid-stream error should use friendlyMessage content');
    expect(midStreamError.at(-1)?.data === '[DONE]', 'mid-stream error must end with [DONE]');
    console.log('PASS mid-stream friendly error');

    setDispatcher(() => Promise.resolve({ finalText: 'blocked tool_calls payload must not pass' }));
    const leak = await curlSse(baseUrl, DEFAULT_BODY_VALID);
    const leakChunks = dataChunks(leak);
    const leakContent = leakChunks.map((chunk) => chunk.choices[0]?.delta.content ?? '').join('');
    expect(!leakContent.includes('blocked tool_calls payload'), 'leaked finalText must not be emitted');
    expect(leakContent.includes('正常方式'), 'TOOL_CALLS_LEAK should be wrapped as friendly message');
    console.log('PASS tool_calls blocked before emission');

    const invalid = await curl([
      '-sS',
      '-o',
      '-',
      '-w',
      '\nHTTP_STATUS:%{http_code}',
      '-H',
      `Authorization: ${VALID_AUTH_HEADER}`,
      '-H',
      'Content-Type: application/json',
      '-d',
      JSON.stringify({
        ...DEFAULT_BODY_VALID,
        tools: [{ type: 'function', function: { name: 'calc' } }],
      }),
      `${baseUrl}/v1/chat/completions`,
    ]);
    expect(invalid.includes('"code":"INVALID_REQUEST"'), 'tools request should return INVALID_REQUEST');
    expect(invalid.includes('HTTP_STATUS:400'), 'tools request should return HTTP 400');
    console.log('PASS tools rejected with 400');

    const rg = spawnSync('rg', ['toTextStreamResponse', 'packages/agent-service/src'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(rg.status === 1 && rg.stdout.length === 0, 'toTextStreamResponse grep should have zero matches');
    console.log('PASS redline grep');
  } finally {
    resetDispatcherForTest();
    _resetHeartbeatIntervalForTest();
    resetAuthPoolForTest();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
