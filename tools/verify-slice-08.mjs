#!/usr/bin/env node
import { spawn } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const args = new Set(process.argv.slice(2));
const runRuntime = args.has('--runtime') || args.has('--all');
const runStatic = args.has('--static') || args.has('--all') || !runRuntime;

const secret = 'slice08-tenant-secret-32-chars-ok';
const databaseUrl =
  process.env.SLICE08_DATABASE_URL ??
  'mysql://root:rootpw@127.0.0.1:3306/store_pilot?timezone=Z&dateStrings=true';

const checks = [];
const processes = new Set();

function record(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  const marker = ok ? 'PASS' : 'FAIL';
  console.log(`[${marker}] ${name}${detail ? ` - ${detail}` : ''}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (options.live) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (options.live) process.stderr.write(chunk);
    });
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function managed(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  processes.add(child);
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
    if (options.live) process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
    if (options.live) process.stderr.write(chunk);
  });
  const exit = new Promise((resolve) => {
    child.on('close', (code, signal) => {
      processes.delete(child);
      resolve({ code, signal, output });
    });
  });
  return {
    child,
    get output() {
      return output;
    },
    exit,
  };
}

async function waitFor(predicate, label, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function waitForHttp(url, label, timeoutMs = 15_000) {
  await waitFor(async () => {
    try {
      const res = await fetch(url);
      return res.ok;
    } catch {
      return false;
    }
  }, label, timeoutMs);
}

async function waitForExit(proc, label, timeoutMs = 15_000) {
  return await Promise.race([
    proc.exit,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout waiting for ${label} exit`)), timeoutMs),
    ),
  ]);
}

function mcpEnv(port, overrides = {}) {
  return {
    NODE_ENV: 'test',
    PORT: String(port),
    MCP_PROTOCOL_VERSION: '2025-06-18',
    MCP_TOOL_TIMEOUT_MS: '15000',
    MCP_ENABLE_WRITE_TOOLS: 'true',
    FIXTURE_PROFILE: 'happy-path',
    MCP_TENANT_SHARED_SECRET: secret,
    MCP_ALLOWED_HOSTS: `localhost:${port},127.0.0.1:${port}`,
    MCP_CORS_ORIGIN: '*',
    ...overrides,
  };
}

function agentEnv(port, mcpPort, overrides = {}) {
  return {
    NODE_ENV: 'test',
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    MODEL_PROVIDER: 'openai-compatible',
    MODEL_BASE_URL: 'http://localhost:7100/llm',
    MODEL_API_KEY: 'sk-test-1234567890',
    MODEL_NAME: 'gpt-test',
    ERP_MCP_SERVER_URL: `http://127.0.0.1:${mcpPort}/mcp`,
    MCP_TENANT_SHARED_SECRET: secret,
    MCP_PROTOCOL_VERSION: '2025-06-18',
    AGENT_API_KEY_HASH_SALT: 'salt-abcdef-1234',
    AGENT_API_KEY_PREFIX: 'sk-agent-',
    CORS_ALLOWED_ORIGINS: 'http://localhost:3210',
    ...overrides,
  };
}

async function runCmdCheck(name, command, cmdArgs) {
  const result = await run(command, cmdArgs);
  const ok = result.code === 0;
  record(name, ok, ok ? '' : result.stderr || result.stdout);
  if (!ok) throw new Error(`${name} failed`);
}

async function runNoMatchCheck(name, pattern, path) {
  const result = await run('rg', ['-n', pattern, path]);
  const ok = result.code === 1 && result.stdout.trim() === '';
  record(name, ok, ok ? '0 matches' : result.stdout || result.stderr);
  if (!ok) throw new Error(`${name} failed`);
}

async function runStaticChecks() {
  await runCmdCheck('agent-service MCP client unit tests', 'pnpm', [
    '--filter',
    '@storepilot/agent-service',
    'test',
    '--',
    'src/mastra/mcp/client.test.ts',
  ]);
  await runCmdCheck('shared-contracts MCP index unit tests', 'pnpm', [
    '--filter',
    '@storepilot/shared-contracts',
    'test',
    '--',
    'src/mcp/index.test.ts',
  ]);
  await runCmdCheck('mcp-mock-server app/server tests', 'pnpm', [
    '--filter',
    '@storepilot/mcp-mock-server',
    'test',
    '--',
    'src/app.test.ts',
    'src/mcp-server.test.ts',
  ]);
  await runCmdCheck('agent-service slice 08 lint', 'pnpm', [
    '--filter',
    '@storepilot/agent-service',
    'exec',
    'eslint',
    'src/mastra/mcp/client.ts',
    'src/server.ts',
    'src/api/health.ts',
  ]);
  await runCmdCheck('mcp-mock-server slice 08 lint', 'pnpm', [
    '--filter',
    '@storepilot/mcp-mock-server',
    'exec',
    'eslint',
    'src/app.ts',
    'src/app.test.ts',
    'src/mcp-server.ts',
    'src/mcp-server.test.ts',
  ]);
  await runCmdCheck('mcp-mock-server typecheck', 'pnpm', [
    '--filter',
    '@storepilot/mcp-mock-server',
    'typecheck',
  ]);
  await runNoMatchCheck(
    'redline experimental_createMCPClient',
    'experimental_createMCPClient',
    'packages/agent-service/src',
  );
}

async function startMcp(port, overrides = {}) {
  const proc = managed('pnpm', ['--filter', '@storepilot/mcp-mock-server', 'dev'], {
    env: mcpEnv(port, overrides),
  });
  await waitForHttp(`http://127.0.0.1:${port}/health`, `mcp mock ${port}`);
  return proc;
}

async function startAgent(port, mcpPort, overrides = {}) {
  const proc = managed('pnpm', ['--filter', '@storepilot/agent-service', 'dev'], {
    env: agentEnv(port, mcpPort, overrides),
  });
  await waitForHttp(`http://127.0.0.1:${port}/health`, `agent ${port}`);
  return proc;
}

async function stop(proc, signal = 'SIGTERM') {
  if (!proc || proc.child.exitCode !== null) return await proc.exit;
  proc.child.kill(signal);
  return await waitForExit(proc, `${proc.child.pid}`, 10_000);
}

async function expectAgentFails(name, mcpOverrides, expectedPatterns) {
  const mcpPort = 7390 + checks.length;
  const agentPort = 7190 + checks.length;
  const mcp = await startMcp(mcpPort, mcpOverrides);
  try {
    const agent = managed('pnpm', ['--filter', '@storepilot/agent-service', 'dev'], {
      env: agentEnv(agentPort, mcpPort),
    });
    const exit = await waitForExit(agent, name, 15_000);
    const output = agent.output;
    const ok =
      exit.code === 1 && expectedPatterns.every((pattern) => output.includes(pattern));
    record(name, ok, ok ? 'exit 1 with expected error' : output);
    if (!ok) throw new Error(`${name} failed`);
  } finally {
    await stop(mcp).catch(() => undefined);
  }
}

async function runRuntimeChecks() {
  const mcp = await startMcp(7391);
  let agent;
  try {
    agent = await startAgent(7191, 7391);
    const health = await fetch('http://127.0.0.1:7191/health/mcp').then((res) => res.json());
    record('/health/mcp exposes 7 tools', Array.isArray(health.tools) && health.tools.length === 7);
    record(
      'startup fourth line mcp-tools-verified',
      agent.output.includes('[startup] mcp-tools-verified'),
    );
    record(
      'X-Tenant-Key accepted by mock without secret leak',
      mcp.output.includes('[mcp-mock] tenant header verified') &&
        mcp.output.includes('"tenantHeader":"[REDACTED]"') &&
        !mcp.output.includes(secret) &&
        !agent.output.includes(secret),
    );
    const exit = await stop(agent);
    record(
      'SIGTERM disposes MCP client and exits 0',
      exit.code === 0 && agent.output.includes('[shutdown] disposeMcpClient ok'),
    );
  } finally {
    await stop(agent).catch(() => undefined);
    await stop(mcp).catch(() => undefined);
  }

  await expectAgentFails('missing tool fails startup', { MCP_ENABLE_WRITE_TOOLS: 'false' }, [
    'missing=',
    'createPurchaseOrder',
  ]);
  await expectAgentFails(
    'extra tool fails startup',
    { MCP_TEST_EXTRA_TOOL_NAME: 'executeSql' },
    ['extra=', 'executeSql'],
  );

  const started = Date.now();
  const failFast = managed('pnpm', ['--filter', '@storepilot/agent-service', 'dev'], {
    env: agentEnv(7199, 9999, {
      ERP_MCP_SERVER_URL: 'http://nowhere:9999/mcp',
    }),
  });
  const exit = await waitForExit(failFast, 'fail-fast', 8_000);
  const elapsed = Date.now() - started;
  record('unreachable MCP fails fast', exit.code === 1 && elapsed < 5_000, `${elapsed}ms`);
}

async function main() {
  try {
    if (runStatic) await runStaticChecks();
    if (runRuntime) await runRuntimeChecks();
  } finally {
    await Promise.all(
      Array.from(processes).map(
        (child) =>
          new Promise((resolve) => {
            child.once('close', resolve);
            child.kill('SIGTERM');
            setTimeout(resolve, 1_000);
          }),
      ),
    );
  }

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    console.error(`slice 08 verification failed: ${failed.length}/${checks.length} checks failed`);
    process.exit(1);
  }
  console.log(`slice 08 verification passed: ${checks.length}/${checks.length} checks passed`);
}

await main();
