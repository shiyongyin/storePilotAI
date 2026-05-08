#!/usr/bin/env node
/**
 * 切片 18 — 覆盖率门禁（3 档）
 *
 * 严格按 docs/tanks/18-test-unit-integration.md §8.5 + 任务卡 H-测试 §T-TEST-01.5 §5 落地。
 *
 * 3 档门禁（前缀匹配；branches / functions / lines 均按"前缀范围内汇总后的占比"计算）：
 *   - src/bridge/             ≥ 95%（API key + SSE + OutputGuard 等高风险，必须最严）
 *   - src/safety/             ≥ 90%（DraftManager / ConfirmManager / Strategy / OutputValidator）
 *   - src/mastra/workflows/   ≥ 80%（业务 workflow，含部分集成路径）
 *
 * 数据源：默认读取 root `coverage/coverage-final.json`（`pnpm test:cov` 的全量 workspace 产物）。
 *
 * 设计决策：
 *   1. 聚合口径 — pct = sum(covered) / sum(total)；这与 vitest 在终端输出的"分类汇总"一致，
 *      避免单个 1-2 行的小文件因边界分支未覆盖把整组拉红。
 *   2. 同时输出每个文件的明细（仅日志）；便于开发者定位具体短板。
 *   3. 无文件匹配前缀 → 视为 fail（防止 typo 让门禁悄悄空跑）。
 *
 * 用法：
 *   node tools/cov-check.mjs [--summary path/to/coverage-summary-or-final.json] [--strict]
 *
 *   --strict     额外加上"任一文件任一指标 < 门禁"的严格断言（用于本地排查覆盖率塌方）。
 */
import fs from 'node:fs';
import path from 'node:path';

/* ============================================================================
 * 1) 解析参数 / 找 summary 文件
 * ========================================================================== */

const args = process.argv.slice(2);
let summaryPath = null;
let strict = false;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--summary' && args[i + 1]) {
    summaryPath = args[i + 1];
    i += 1;
  } else if (args[i] === '--strict') {
    strict = true;
  }
}

const root = path.resolve(new URL('..', import.meta.url).pathname);
const defaultCoveragePath = path.join(root, 'coverage/coverage-final.json');
const candidates = summaryPath ? [summaryPath] : [defaultCoveragePath];

const existing = candidates.filter((p) => fs.existsSync(p));
const found = existing[0];
if (!found) {
  console.error(
    `[cov] FAIL — 未找到覆盖率文件；尝试路径：\n  - ${candidates.join('\n  - ')}`,
  );
  console.error('请先跑：pnpm test:cov');
  process.exit(1);
}

/* ============================================================================
 * 2) 解析 summary
 * ========================================================================== */

let cov;
try {
  cov = normalizeCoverage(JSON.parse(fs.readFileSync(found, 'utf8')));
} catch (e) {
  console.error(`[cov] FAIL — 解析 ${found} 失败：${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

/**
 * Vitest workspace coverage writes the full-run artifact to
 * `coverage/coverage-final.json`. Targeted package tests can leave newer
 * package-local summaries on disk, so the default path intentionally stays on
 * the root full-run artifact. `--summary` may still point at either Istanbul
 * final coverage or json-summary shape for local diagnostics.
 */
function normalizeCoverage(raw) {
  const entries = Object.entries(raw).filter(([file]) => file !== 'total');
  const sample = entries.find(([, value]) => value && typeof value === 'object')?.[1];
  if (sample && isSummaryMetric(sample)) return raw;

  const out = {};
  for (const [file, fileCoverage] of entries) {
    out[file] = summarizeIstanbulFile(fileCoverage);
  }
  return out;
}

function isSummaryMetric(value) {
  return ['lines', 'functions', 'branches'].every(
    (key) =>
      value?.[key] &&
      typeof value[key].total === 'number' &&
      typeof value[key].covered === 'number' &&
      typeof value[key].pct === 'number',
  );
}

function summarizeIstanbulFile(fileCoverage) {
  const statementMap = fileCoverage?.statementMap ?? {};
  const statements = fileCoverage?.s ?? {};
  const fnMap = fileCoverage?.fnMap ?? {};
  const functions = fileCoverage?.f ?? {};
  const branchMap = fileCoverage?.branchMap ?? {};
  const branches = fileCoverage?.b ?? {};

  const lineHits = new Map();
  for (const [id, loc] of Object.entries(statementMap)) {
    const line = loc?.start?.line;
    if (typeof line !== 'number') continue;
    const hits = Number(statements[id] ?? 0);
    lineHits.set(line, (lineHits.get(line) ?? 0) + hits);
  }

  const branchCounts = Object.values(branches).flatMap((value) =>
    Array.isArray(value) ? value : [value],
  );
  const statementCounts = Object.values(statements);
  const functionCounts = Object.keys(fnMap).map((id) => functions[id] ?? 0);

  const linesTotal = lineHits.size;
  const linesCovered = [...lineHits.values()].filter((hits) => hits > 0).length;
  const statementsTotal = statementCounts.length;
  const statementsCovered = statementCounts.filter((hits) => Number(hits) > 0).length;
  const functionsTotal = functionCounts.length;
  const functionsCovered = functionCounts.filter((hits) => Number(hits) > 0).length;
  const branchesTotal = branchCounts.length;
  const branchesCovered = branchCounts.filter((hits) => Number(hits) > 0).length;

  return {
    lines: metric(linesCovered, linesTotal),
    statements: metric(statementsCovered, statementsTotal),
    functions: metric(functionsCovered, functionsTotal),
    branches: metric(branchesCovered, branchesTotal),
  };
}

function metric(covered, total) {
  return {
    total,
    covered,
    skipped: 0,
    pct: total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2)),
  };
}

/* ============================================================================
 * 3) 三档门禁（聚合 + 严格双门）
 * ========================================================================== */

const thresholds = [
  { prefix: 'src/bridge/', branches: 95, functions: 95, lines: 95 },
  { prefix: 'src/safety/', branches: 90, functions: 90, lines: 90 },
  { prefix: 'src/mastra/workflows/', branches: 80, functions: 80, lines: 80 },
];

/**
 * 跳过非业务源文件（测试 / index 桶 / 非 .ts）。
 */
function isProductionSource(file) {
  if (typeof file !== 'string') return false;
  if (file.endsWith('.test.ts') || file.endsWith('.spec.ts')) return false;
  if (file.endsWith('/index.ts')) return false;
  if (!file.endsWith('.ts')) return false;
  return true;
}

const failures = [];
const tierSummaries = [];

for (const tier of thresholds) {
  const matched = Object.entries(cov).filter(
    ([file]) => typeof file === 'string' && file.includes(tier.prefix) && isProductionSource(file),
  );

  if (matched.length === 0) {
    failures.push({
      kind: 'no-match',
      rule: tier.prefix,
      reason: `0 个文件匹配前缀；请确认 vitest coverage include / cov-summary 已生成`,
    });
    continue;
  }

  // 3.1 聚合：sum(covered) / sum(total)
  const sums = { branches: { c: 0, t: 0 }, functions: { c: 0, t: 0 }, lines: { c: 0, t: 0 } };
  const fileLines = [];
  for (const [file, m] of matched) {
    for (const k of ['branches', 'functions', 'lines']) {
      sums[k].c += m?.[k]?.covered ?? 0;
      sums[k].t += m?.[k]?.total ?? 0;
    }
    fileLines.push({
      file: file.split('agent-service/')[1] ?? file,
      branches: m?.branches?.pct ?? null,
      functions: m?.functions?.pct ?? null,
      lines: m?.lines?.pct ?? null,
    });
  }
  const aggregate = {};
  for (const k of ['branches', 'functions', 'lines']) {
    aggregate[k] = sums[k].t === 0 ? 100 : (sums[k].c / sums[k].t) * 100;
  }

  tierSummaries.push({
    prefix: tier.prefix,
    fileCount: matched.length,
    aggregate,
    threshold: tier,
  });

  // 3.2 聚合门禁
  for (const k of ['branches', 'functions', 'lines']) {
    if (aggregate[k] < tier[k]) {
      failures.push({
        kind: 'aggregate',
        rule: tier.prefix,
        reason: `${k}=${aggregate[k].toFixed(2)}% < ${tier[k]}% (sum across ${matched.length} files)`,
      });
    }
  }

  // 3.3 严格门禁（默认关；用 --strict 开启用于本地诊断）
  if (strict) {
    for (const [file, m] of matched) {
      for (const k of ['branches', 'functions', 'lines']) {
        const pct = m?.[k]?.pct;
        if (typeof pct === 'number' && pct < tier[k]) {
          failures.push({
            kind: 'per-file',
            rule: tier.prefix,
            file,
            reason: `${k}=${pct.toFixed(2)}<${tier[k]}`,
          });
        }
      }
    }
  }
}

/* ============================================================================
 * 4) 输出 / 退出码
 * ========================================================================== */

console.log('[cov] 三档门禁聚合结果（branches / functions / lines）：');
for (const s of tierSummaries) {
  console.log(
    `  • ${s.prefix} (${s.fileCount} files): branches=${s.aggregate.branches.toFixed(2)}% / ` +
      `functions=${s.aggregate.functions.toFixed(2)}% / lines=${s.aggregate.lines.toFixed(2)}% ` +
      `(threshold ${s.threshold.branches}/${s.threshold.functions}/${s.threshold.lines})`,
  );
}

if (failures.length > 0) {
  console.error('\n[cov] FAIL — 覆盖率门禁未达标：\n');
  for (const f of failures) {
    if (f.file) console.error(`  • [${f.rule}] ${f.file}: ${f.reason}`);
    else console.error(`  • [${f.rule}] ${f.reason}`);
  }
  console.error('\n参考：docs/tanks/18-test-unit-integration.md §8.5。');
  process.exit(1);
}

console.log(
  `\n[cov] OK — 3 档门禁全绿（bridge ≥ 95% / safety ≥ 90% / workflows ≥ 80%）。`,
);
process.exit(0);
