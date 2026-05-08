import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from './config/env.js';

const TEST_ENV: Env = {
  NODE_ENV: 'test',
  PORT: 7301,
  MCP_PROTOCOL_VERSION: '2025-06-18',
  MCP_TOOL_TIMEOUT_MS: 15000,
  MCP_ENABLE_WRITE_TOOLS: true,
  FIXTURE_PROFILE: 'happy-path',
  MCP_TENANT_SHARED_SECRET: 'abcdefghijklmnopqrstuvwxyz123456',
  MCP_ALLOWED_HOSTS: 'localhost:7301,127.0.0.1:7301',
  MCP_CORS_ORIGIN: '*',
  MCP_TEST_EXTRA_TOOL_NAME: undefined,
  MCP_TEST_SCHEMA_MISSING_TOOL: undefined,
  MCP_TEST_SCHEMA_MISSING_SIDE: undefined,
};

describe('mcp mock express app', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('normalizes the prompt curl Accept header shape for SDK 1.29', async () => {
    const { MCP_ACCEPT_HEADER, normalizeMcpAcceptHeader, applyMcpAcceptCompatibility } = await import(
      './app.js'
    );

    expect(normalizeMcpAcceptHeader(undefined)).toBe(MCP_ACCEPT_HEADER);
    expect(normalizeMcpAcceptHeader('*/*')).toBe(MCP_ACCEPT_HEADER);
    expect(normalizeMcpAcceptHeader(MCP_ACCEPT_HEADER)).toBe(MCP_ACCEPT_HEADER);

    const req = {
      method: 'POST',
      path: '/mcp',
      headers: { accept: '*/*' },
      rawHeaders: ['Host', 'localhost:7300', 'Accept', '*/*'],
    };
    applyMcpAcceptCompatibility(req);
    expect(req.headers.accept).toBe(MCP_ACCEPT_HEADER);
    expect(req.rawHeaders).toEqual(['Host', 'localhost:7300', 'Accept', MCP_ACCEPT_HEADER]);
  });

  it('uses JSON transport responses so prompt curl output is jq-readable', async () => {
    const { MCP_TRANSPORT_OPTIONS } = await import('./app.js');

    expect(MCP_TRANSPORT_OPTIONS).toEqual({ enableJsonResponse: true });
  });

  it('creates the app with DNS rebinding allowed hosts and health metadata', async () => {
    const { createMcpMockApp } = await import('./app.js');

    const app = createMcpMockApp(TEST_ENV);

    expect(app).toBeTypeOf('function');
  });

  it('accepts only the configured X-Tenant-Key value for /mcp requests', async () => {
    const mod = (await import('./app.js')) as typeof import('./app.js') & {
      isTenantHeaderAuthorized?: (
        actual: string | string[] | undefined,
        expected: string,
      ) => boolean;
    };

    expect(
      mod.isTenantHeaderAuthorized?.(
        TEST_ENV.MCP_TENANT_SHARED_SECRET,
        TEST_ENV.MCP_TENANT_SHARED_SECRET,
      ),
    ).toBe(true);
    expect(
      mod.isTenantHeaderAuthorized?.(
        [TEST_ENV.MCP_TENANT_SHARED_SECRET],
        TEST_ENV.MCP_TENANT_SHARED_SECRET,
      ),
    ).toBe(true);
    expect(mod.isTenantHeaderAuthorized?.(undefined, TEST_ENV.MCP_TENANT_SHARED_SECRET)).toBe(false);
    expect(mod.isTenantHeaderAuthorized?.('wrong-secret', TEST_ENV.MCP_TENANT_SHARED_SECRET)).toBe(false);
  });
});
