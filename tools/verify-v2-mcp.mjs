#!/usr/bin/env node
/**
 * Slice 21 V2 MCP dry-run gate.
 *
 * This script intentionally requires explicit external endpoints. The local
 * slice-19 E2E suite uses in-process fixtures, so treating it as a real V2 ERP
 * cutover would be a false green.
 */

const EXPECTED_TOOLS = [
  'createPurchaseOrder',
  'getStoreReportConfig',
  'queryCategorySalesRatio',
  'queryInventoryOverview',
  'queryProductSalesRank',
  'queryReplenishmentBaseData',
  'queryStoreSalesSummary',
];

const args = new Set(process.argv.slice(2));
if (args.has('--help') || args.has('-h')) {
  console.log(`Usage:
  V2_MCP_URL=http://erp-mcp-staging:8080/mcp \\
  V2_AGENT_BASE_URL=http://localhost:7100 \\
  MCP_TENANT_SHARED_SECRET=<secret> \\
  pnpm test:e2e:v2

Checks:
  1. V2 MCP tools/list returns exactly the 7 shared-contract tools.
  2. Every listed tool exposes non-empty input/output schemas.
  3. With --require-agent-health, V2_AGENT_BASE_URL /health/mcp is UP and returns 7 tools.
`);
  process.exit(0);
}

const requireAgentHealth = args.has('--require-agent-health');
const v2McpUrl = process.env.V2_MCP_URL;
const agentBaseUrl = process.env.V2_AGENT_BASE_URL;
const tenantSecret = process.env.MCP_TENANT_SHARED_SECRET;
const protocolVersion = process.env.MCP_PROTOCOL_VERSION ?? '2025-06-18';

const checks = [];

function pass(name, detail = '') {
  checks.push({ name, ok: true, detail });
  console.log(`PASS ${name}${detail ? ` - ${detail}` : ''}`);
}

function fail(name, detail) {
  checks.push({ name, ok: false, detail });
  console.error(`FAIL ${name} - ${detail}`);
}

function requireEnv(name, value) {
  if (typeof value === 'string' && value.length > 0) return true;
  fail(`env ${name}`, `${name} is required`);
  return false;
}

function assertCheck(name, condition, detail = '') {
  if (condition) pass(name, detail);
  else fail(name, detail || 'assertion failed');
}

async function postJsonRpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Key': tenantSecret,
      'X-Mcp-Protocol-Version': protocolVersion,
      'User-Agent': 'storepilot-slice21-v2-dry-run',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new Error(`Invalid JSON response: ${text.slice(0, 500)}`, { cause });
  }
}

function extractTools(payload) {
  const result = payload?.result;
  if (Array.isArray(result?.tools)) return result.tools;
  if (result?.toolsets && typeof result.toolsets === 'object') {
    return Object.values(result.toolsets).flatMap((toolset) =>
      toolset && typeof toolset === 'object' ? Object.values(toolset) : [],
    );
  }
  if (result && typeof result === 'object') {
    const values = Object.values(result);
    if (values.every((value) => value && typeof value === 'object' && 'name' in value)) {
      return values;
    }
  }
  return [];
}

function toolName(tool) {
  if (typeof tool?.name === 'string') return tool.name;
  if (typeof tool?.id === 'string') return tool.id;
  return null;
}

function hasSchema(tool, key) {
  const schema = tool?.[key] ?? tool?.[key.replace('Schema', '_schema')];
  return Boolean(schema && typeof schema === 'object' && Object.keys(schema).length > 0);
}

async function checkToolsList() {
  const payload = await postJsonRpc(v2McpUrl, 'tools/list');
  if (payload?.error) {
    throw new Error(`JSON-RPC error: ${JSON.stringify(payload.error)}`);
  }
  const tools = extractTools(payload);
  const names = tools.map(toolName).filter((name) => typeof name === 'string').sort();
  assertCheck(
    'V2 tools/list exactly matches 7-tool whitelist',
    JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS),
    `found=${JSON.stringify(names)}`,
  );

  const missingSchemas = tools
    .filter((tool) => EXPECTED_TOOLS.includes(toolName(tool)))
    .filter((tool) => !hasSchema(tool, 'inputSchema') || !hasSchema(tool, 'outputSchema'))
    .map(toolName)
    .sort();
  assertCheck(
    'V2 tools expose input/output schemas',
    missingSchemas.length === 0,
    missingSchemas.length === 0 ? 'all schemas present' : `missing=${missingSchemas.join(',')}`,
  );
}

async function checkAgentHealth() {
  if (!requireAgentHealth) {
    pass('agent /health/mcp check skipped', 'pass --require-agent-health to enforce');
    return;
  }
  if (!requireEnv('V2_AGENT_BASE_URL', agentBaseUrl)) return;
  const url = new URL('/health/mcp', agentBaseUrl).toString();
  const res = await fetch(url);
  const body = await res.json().catch(() => null);
  assertCheck('agent /health/mcp HTTP 200', res.ok, `status=${res.status}`);
  assertCheck('agent /health/mcp status UP', body?.status === 'UP', JSON.stringify(body));
  const names = Array.isArray(body?.tools) ? [...body.tools].sort() : [];
  assertCheck(
    'agent /health/mcp exposes 7 tools',
    JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS),
    `tools=${JSON.stringify(names)}`,
  );
}

async function main() {
  const envOk =
    requireEnv('V2_MCP_URL', v2McpUrl) &&
    requireEnv('MCP_TENANT_SHARED_SECRET', tenantSecret);
  if (!envOk) {
    console.error('V2 dry-run is intentionally not runnable without explicit external endpoints.');
    process.exit(1);
  }

  try {
    await checkToolsList();
    await checkAgentHealth();
  } catch (error) {
    fail('V2 dry-run request', error instanceof Error ? error.message : String(error));
  }

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    console.error(`slice 21 V2 dry-run failed: ${failed.length}/${checks.length} checks failed`);
    process.exit(1);
  }
  console.log(`slice 21 V2 dry-run passed: ${checks.length}/${checks.length} checks passed`);
}

await main();
