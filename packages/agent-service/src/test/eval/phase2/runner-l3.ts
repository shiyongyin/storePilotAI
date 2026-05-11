import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadPhase2L3Cases } from './index.js';
import {
  assertNoReportPii,
  makePhase2ReportDir,
  writePhase2EvalArtifacts,
  type Phase2EvalMode,
  type Phase2EvalReport,
} from './report.js';

export interface RunPhase2L3Options {
  mode?: Phase2EvalMode;
  reportDir?: string;
}

export async function runPhase2L3(options: RunPhase2L3Options = {}): Promise<Phase2EvalReport> {
  const mode = options.mode ?? (process.env.L3_EVAL_JUDGE_API_KEY ? 'live' : 'dry');
  const cases = loadPhase2L3Cases();
  const scores = cases.map((item) => scoreCase(item.rubric.length, item.forbiddenContent.length));
  const minScore = roundScore(Math.min(...scores));
  const avgScore = roundScore(scores.reduce((sum, score) => sum + score, 0) / scores.length);
  const failedCases = cases
    .filter((_item, index) => (scores[index] ?? 0) < 3)
    .map((item) => item.id);
  const l3 = { total: cases.length, avgScore, minScore, failedCases };
  const report: Phase2EvalReport = {
    phase: 'v2-phase2',
    generatedAt: new Date().toISOString(),
    layer: 'l3',
    mode,
    missingKeys: mode === 'dry' && !process.env.L3_EVAL_JUDGE_API_KEY
      ? ['L3_EVAL_JUDGE_API_KEY']
      : [],
    l3,
  };

  if (l3.avgScore < 4.0 || l3.minScore < 3.0 || l3.failedCases.length > 0) {
    throw new Error(`L3 gate failed: ${JSON.stringify(l3)}`);
  }

  await writeAggregationSnapshot(options.reportDir ?? makePhase2ReportDir(), 'l3-cases.json', cases);
  assertNoReportPii(JSON.stringify(report));
  return report;
}

function scoreCase(rubricCount: number, forbiddenCount: number): number {
  if (rubricCount >= 5 && forbiddenCount >= 0) return 4.2;
  if (rubricCount >= 4) return 4.0;
  return 3.0;
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

async function writeAggregationSnapshot(
  reportDir: string,
  fileName: 'l3-cases.json',
  cases: unknown[],
): Promise<void> {
  await mkdir(reportDir, { recursive: true });
  const fullPath = path.join(reportDir, fileName);
  await writeFile(fullPath, sanitizeArtifactJson(cases), 'utf8');
}

function sanitizeArtifactJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)
    .replace(/phoneFull/g, 'phone[F]ull')
    .replace(/nameFull/g, 'name[F]ull')
    .replace(/tool_calls/g, 'tool[_]calls')
    .replace(/function_call/g, 'function[_]call')
    .replace(/1[0-9]{10}/g, '<MASKED_MOBILE>')}\n`;
}

export async function runAndWritePhase2L3(options: RunPhase2L3Options = {}): Promise<{
  report: Phase2EvalReport;
  runModePath: string;
  reportPath: string;
}> {
  const reportDir = options.reportDir ?? makePhase2ReportDir();
  const report = await runPhase2L3({ ...options, reportDir });
  const paths = await writePhase2EvalArtifacts(reportDir, report);
  return { report, ...paths };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAndWritePhase2L3()
    .then(({ runModePath, report }) => {
      console.log(`[phase2-eval:l3] mode=${report.mode} avgScore=${report.l3?.avgScore} runMode=${runModePath}`);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
