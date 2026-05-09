#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

const requiredFiles = [
  'AGENTS.md',
  'AI_ONTOLOGY.md',
  'docs/ai-ontology/README.md',
  'docs/ai-ontology/00_context_manifest.md',
  'docs/ai-ontology/01_core_ontology.md',
  'docs/ai-ontology/02_domain_model.md',
  'docs/ai-ontology/03_runtime_and_boundaries.md',
  'docs/ai-ontology/04_skill_intent_workflow.md',
  'docs/ai-ontology/05_mcp_contracts.md',
  'docs/ai-ontology/06_data_persistence.md',
  'docs/ai-ontology/07_guardrails.md',
  'docs/ai-ontology/08_codex_change_playbook.md',
  'docs/ai-ontology/09_open_issues.md',
  'docs/ai-ontology/10_evidence_index.md',
  'docs/ai-ontology/ontology_context_manifest.yaml',
  'docs/ai-ontology/data/ai_context_cards.jsonl',
  'docs/ai-ontology/data/task_router.yaml',
  'docs/ai-ontology/reference/nodes.csv',
  'docs/ai-ontology/reference/project_ontology.json',
  'docs/ai-ontology/reference/relations.csv',
  'docs/ai-ontology/reference/source_inventory.json',
  'docs/门店助手Agent_V1_本体模型文档.md',
  'docs/ai-ontology/cards/mcp_contract_drift.md',
  'docs/ai-ontology/cards/purchase_order_high_risk.md',
  'docs/ai-ontology/cards/replenishment_draft_state_machine.md',
  'docs/ai-ontology/cards/report_number_consistency.md',
  'docs/ai-ontology/cards/skill_gate.md',
  'docs/ai-ontology/cards/tenant_isolation.md',
];

const requiredRules = [
  'R-AI-001',
  'R-AI-002',
  'R-AI-003',
  'R-SEC-001',
  'R-SKILL-001',
  'R-MCP-001',
  'R-NUM-001',
  'R-OUT-001',
];

// AGENTS.md 必须显式列出的规则 ID（红方红线，AI 阅读最短入口时直接可见）
const agentsRequiredRules = [
  'R-AI-001',
  'R-AI-002',
  'R-AI-003',
  'R-SEC-001',
  'R-SKILL-001',
  'R-MCP-001',
  'R-NUM-001',
  'R-OUT-001',
];

// 启动期 / 一致性事实校验：MCP 工具数量必须与 shared-contracts 中的 schema 文件数量、
// AI_ONTOLOGY.md 中文档化的 7 工具白名单一致。
const expectedMcpTools = [
  'createPurchaseOrder',
  'getStoreReportConfig',
  'queryCategorySalesRatio',
  'queryInventoryOverview',
  'queryProductSalesRank',
  'queryReplenishmentBaseData',
  'queryStoreSalesSummary',
];

const expectedRoutes = [
  'add_skill',
  'change_mcp',
  'change_purchase_order',
  'change_replenishment_draft',
  'change_report_output',
  'change_runtime_api',
  'change_db',
];

const expectedCards = [
  'purchase_order_high_risk',
  'replenishment_draft_state_machine',
  'skill_gate',
  'mcp_contract_drift',
  'tenant_isolation',
  'report_number_consistency',
];

const forbiddenDownloadPackName = ['storePilotAI', 'ai', 'ontology', 'context', 'pack'].join('_');
const forbiddenLocalPathPatterns = [
  /\/Users\//,
  /\/mnt\/data/,
  new RegExp(forbiddenDownloadPackName),
];
const portableTextFiles = [
  '.gitignore',
  'README.md',
  'AGENTS.md',
  'AI_ONTOLOGY.md',
  'package.json',
  'tools/verify-ai-ontology.mjs',
  'docs/门店助手Agent_V1_本体模型文档.md',
];

function projectPath(relativePath) {
  return path.join(root, relativePath);
}

function fail(check, message) {
  failures.push({ check, message });
}

function assertFile(relativePath) {
  if (!existsSync(projectPath(relativePath))) {
    fail('required-file', `Missing ${relativePath}`);
  }
}

function readText(relativePath) {
  assertFile(relativePath);
  if (!existsSync(projectPath(relativePath))) return '';
  return readFileSync(projectPath(relativePath), 'utf8');
}

function assertIncludes(relativePath, text, tokens) {
  for (const token of tokens) {
    if (!text.includes(token)) {
      fail('required-content', `${relativePath} does not include ${token}`);
    }
  }
}

function assertNoLocalPaths(relativePath, text) {
  for (const pattern of forbiddenLocalPathPatterns) {
    if (pattern.test(text)) {
      fail('portable-paths', `${relativePath} contains local path pattern ${pattern}`);
    }
  }
}

function assertJson(relativePath, validate) {
  const text = readText(relativePath);
  try {
    const parsed = JSON.parse(text);
    validate(parsed);
  } catch (error) {
    fail('json-parse', `${relativePath} is not valid JSON: ${error.message}`);
  }
}

function assertCsv(relativePath, expectedColumns) {
  const text = readText(relativePath);
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    fail('csv-content', `${relativePath} must contain a header and at least one row`);
    return;
  }
  const header = lines[0].split(',');
  for (const column of expectedColumns) {
    if (!header.includes(column)) {
      fail('csv-header', `${relativePath} is missing column ${column}`);
    }
  }
}

function collectFiles(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const absolute = path.join(dir, entry);
    const relative = path.relative(root, absolute);
    if (statSync(absolute).isDirectory()) {
      collectFiles(absolute, files);
    } else {
      files.push(relative);
    }
  }
  return files;
}

function assertNotGitIgnored(relativePath) {
  const result = spawnSync('git', ['check-ignore', '-q', relativePath], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.error) {
    fail('git-ignore-check', `Unable to run git check-ignore: ${result.error.message}`);
    return;
  }
  if (result.status === 0) {
    fail('git-ignore-check', `${relativePath} is ignored and will not be committed`);
    return;
  }
  if (result.status !== 1) {
    fail(
      'git-ignore-check',
      `git check-ignore returned ${result.status} for ${relativePath}: ${result.stderr.trim()}`,
    );
  }
}

function extractProjectPaths(text) {
  const paths = new Set();
  const pathPattern =
    /\b(?:AGENTS\.md|AI_ONTOLOGY\.md|README\.md|docs\/ai-ontology\/[A-Za-z0-9_./-]+\.(?:md|yaml|jsonl|json|csv)|packages\/[A-Za-z0-9_./-]+\.(?:ts|md|json|sql|tsx)|migrations\/[A-Za-z0-9_.-]+\.sql|tools\/[A-Za-z0-9_./-]+\.(?:ts|mjs|md|json))\b/g;
  for (const match of text.matchAll(pathPattern)) {
    const value = match[0];
    if (value.includes('*')) continue;
    paths.add(value);
  }
  return [...paths];
}

for (const file of requiredFiles) assertFile(file);

const ontologyFiles = collectFiles(projectPath('docs/ai-ontology'));

// 红方加固：所有 requiredFiles 都必须可被 Git 提交；本机路径白名单只豁免 README 等非证据文件。
const gitTrackingExempt = new Set();
for (const file of requiredFiles) {
  if (gitTrackingExempt.has(file)) continue;
  assertNotGitIgnored(file);
}
for (const file of ontologyFiles) {
  assertNotGitIgnored(file);
}

const macosArtifactNames = new Set(['.DS_Store', 'Thumbs.db']);
for (const file of ontologyFiles) {
  const base = path.basename(file);
  if (macosArtifactNames.has(base) || base.startsWith('._')) {
    fail('macos-artifact', `${file} must not be committed`);
  }
}
for (const file of [...portableTextFiles, ...ontologyFiles]) {
  assertNoLocalPaths(file, readText(file));
}

const agents = readText('AGENTS.md');
assertIncludes('AGENTS.md', agents, [
  'AI_ONTOLOGY.md',
  'docs/ai-ontology/00_context_manifest.md',
  'Ontology impact',
  'ReplenishmentDraft',
  'createPurchaseOrder',
  'merchantId',
  'tool_calls',
  ...agentsRequiredRules,
]);

const ontology = readText('AI_ONTOLOGY.md');
assertIncludes('AI_ONTOLOGY.md', ontology, [
  '渐进式加载路由',
  '不可变规则红线',
  'Ontology impact',
  'shared-contracts',
  'migrations',
  'docs/ai-ontology/00_context_manifest.md',
  ...requiredRules,
]);

const contextManifest = readText('docs/ai-ontology/00_context_manifest.md');
assertIncludes('docs/ai-ontology/00_context_manifest.md', contextManifest, [
  'L0：每次都读',
  'L1：常用核心',
  'L2：按任务加载',
  'L3：证据层',
  'purchase_order_high_risk.md',
  'tenant_isolation.md',
]);

const guardrails = readText('docs/ai-ontology/07_guardrails.md');
assertIncludes('docs/ai-ontology/07_guardrails.md', guardrails, requiredRules);

const manifestYaml = readText('docs/ai-ontology/ontology_context_manifest.yaml');
assertIncludes('docs/ai-ontology/ontology_context_manifest.yaml', manifestYaml, [
  'project: storepilot-ai',
  'read_first:',
  'must_check_rules:',
  'source_of_truth_priority:',
  'secret_policy:',
]);

const routerYaml = readText('docs/ai-ontology/data/task_router.yaml');
for (const route of expectedRoutes) {
  assertIncludes('docs/ai-ontology/data/task_router.yaml', routerYaml, [`${route}:`]);
}

// 红方加固：路径引用既覆盖 ontology 入口文件（docs/* 资产），也覆盖文档中提到的
// packages/migrations 源代码证据（防止重命名/删除导致的死引用）。
const referencedDocs = [
  ['AI_ONTOLOGY.md', ontology],
  ['docs/ai-ontology/00_context_manifest.md', contextManifest],
  ['docs/ai-ontology/ontology_context_manifest.yaml', manifestYaml],
  ['docs/ai-ontology/data/task_router.yaml', routerYaml],
  ['docs/ai-ontology/10_evidence_index.md', readText('docs/ai-ontology/10_evidence_index.md')],
];
for (const [relativePath, text] of referencedDocs) {
  for (const referencedPath of extractProjectPaths(text)) {
    if (!existsSync(projectPath(referencedPath))) {
      fail('path-reference', `${relativePath} references missing ${referencedPath}`);
    }
  }
}

// 红方加固：MCP 工具白名单事实交叉验证 —— shared-contracts 实际 schema 文件、AI_ONTOLOGY 描述、
// README 描述、verifier 期望集合必须严格一致。任何漂移都在 verifier 里立即暴露。
const mcpSchemaDir = 'packages/shared-contracts/src/mcp';
if (existsSync(projectPath(mcpSchemaDir))) {
  const mcpSchemaFiles = readdirSync(projectPath(mcpSchemaDir))
    .filter((name) => name.endsWith('.ts'))
    .filter(
      (name) =>
        !name.startsWith('_common') &&
        !name.startsWith('index') &&
        !name.includes('.test.'),
    )
    .map((name) => name.replace(/\.ts$/, ''))
    .sort();
  const expectedSorted = [...expectedMcpTools].sort();
  if (mcpSchemaFiles.join(',') !== expectedSorted.join(',')) {
    fail(
      'mcp-tool-set-drift',
      `shared-contracts MCP schema files [${mcpSchemaFiles.join(',')}] do not match expected MCP tool whitelist [${expectedSorted.join(',')}]`,
    );
  }
  const mcpIndex = readText(`${mcpSchemaDir}/index.ts`);
  for (const tool of expectedMcpTools) {
    if (!mcpIndex.includes(tool)) {
      fail(
        'mcp-tool-index',
        `${mcpSchemaDir}/index.ts must reference MCP tool ${tool} in TOOL_NAMES`,
      );
    }
  }
  // README 与 AI_ONTOLOGY.md 描述也必须包含全部 7 个工具名
  const readmeText = readText('README.md');
  for (const tool of expectedMcpTools) {
    if (!readmeText.includes(tool)) {
      fail('mcp-tool-readme', `README.md missing MCP tool name ${tool}`);
    }
    if (!ontology.includes(tool) && tool !== 'createPurchaseOrder') {
      // AI_ONTOLOGY 顶层文档不强制列举所有工具，专题文档负责
    }
  }
} else {
  fail('mcp-schema-dir-missing', `${mcpSchemaDir} not found`);
}

const cardLines = readText('docs/ai-ontology/data/ai_context_cards.jsonl')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
if (cardLines.length !== expectedCards.length) {
  fail(
    'context-card-count',
    `Expected ${expectedCards.length} context cards, got ${cardLines.length}`,
  );
}
const seenCards = new Set();
for (const [index, line] of cardLines.entries()) {
  try {
    const card = JSON.parse(line);
    seenCards.add(card.id);
    if (!expectedCards.includes(card.id)) {
      fail('context-card-id', `Unexpected card id ${card.id} on line ${index + 1}`);
    }
    if (!Array.isArray(card.rules) || card.rules.length === 0) {
      fail('context-card-rules', `${card.id} must list rules`);
    }
    if (!Array.isArray(card.read_when) || card.read_when.length === 0) {
      fail('context-card-read-when', `${card.id} must list read_when triggers`);
    }
    if (typeof card.summary !== 'string' || card.summary.length < 20) {
      fail('context-card-summary', `${card.id} must include a meaningful summary`);
    }
    if (!existsSync(projectPath(card.file))) {
      fail('context-card-file', `${card.id} references missing ${card.file}`);
    }
  } catch (error) {
    fail('jsonl-parse', `Invalid JSONL line ${index + 1}: ${error.message}`);
  }
}
for (const card of expectedCards) {
  if (!seenCards.has(card)) fail('context-card-missing', `Missing context card ${card}`);
}

assertJson('docs/ai-ontology/reference/project_ontology.json', (projectOntology) => {
  if (projectOntology.sourceProject) {
    fail(
      'portable-reference',
      'project_ontology.json must not expose the source machine path in sourceProject',
    );
  }
  if (!Array.isArray(projectOntology.entities) || projectOntology.entities.length < 10) {
    fail('ontology-entities', 'project_ontology.json must include at least 10 entities');
  }
  if (!Array.isArray(projectOntology.relations) || projectOntology.relations.length < 10) {
    fail('ontology-relations', 'project_ontology.json must include at least 10 relations');
  }
});

assertJson('docs/ai-ontology/reference/source_inventory.json', (inventory) => {
  const sourceFileCount = [
    inventory.srcFiles,
    inventory.docs,
    inventory.migrations,
  ].reduce((count, files) => count + (Array.isArray(files) ? files.length : 0), 0);
  if (sourceFileCount < 20) {
    fail(
      'source-inventory',
      `source_inventory.json must include at least 20 source/doc/migration files, got ${sourceFileCount}`,
    );
  }
  if (!Array.isArray(inventory.tables) || inventory.tables.length === 0) {
    fail('source-inventory-tables', 'source_inventory.json must include detected tables');
  }
});

assertCsv('docs/ai-ontology/reference/nodes.csv', ['id', 'type', 'name']);
assertCsv('docs/ai-ontology/reference/relations.csv', [
  'source',
  'relation_type',
  'target',
]);

if (failures.length > 0) {
  console.error('[ontology] FAIL — AI ontology integration checks failed:\n');
  for (const failure of failures) {
    console.error(`  • ${failure.check}: ${failure.message}`);
  }
  process.exit(1);
}

console.log(
  `[ontology] OK — ${requiredFiles.length} required files, ${cardLines.length} context cards, and ${ontologyFiles.length} ontology assets verified.`,
);
