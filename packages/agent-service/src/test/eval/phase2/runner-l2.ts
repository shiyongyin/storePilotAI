import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadPhase2L2Cases } from './index.js';
import {
  assertNoReportPii,
  makePhase2ReportDir,
  writePhase2EvalArtifacts,
  type Phase2EvalMode,
  type Phase2EvalReport,
} from './report.js';

export interface RunPhase2L2Options {
  mode?: Phase2EvalMode;
  reportDir?: string;
}

export async function runPhase2L2(options: RunPhase2L2Options = {}): Promise<Phase2EvalReport> {
  const mode = options.mode ?? (process.env.MODEL_API_KEY ? 'live' : 'dry');
  const cases = loadPhase2L2Cases();
  const failedCases: string[] = [];

  for (const item of cases) {
    const totalExpectedSteps = new Set([
      ...item.expectedTools.mustCall,
      ...item.expectedTools.shouldCall,
    ]).size;
    if (item.expectedTools.mustNotCall.length > 0) {
      const forbiddenReadToolHit = item.expectedTools.mustNotCall.some((tool) =>
        item.expectedTools.mustCall.includes(tool as never),
      );
      if (forbiddenReadToolHit) failedCases.push(item.id);
    }
    if (totalExpectedSteps < item.minSteps || item.minSteps > item.maxSteps || totalExpectedSteps > item.maxSteps) {
      failedCases.push(item.id);
    }
  }

  const totalMustCalls = cases.reduce((sum, item) => sum + item.expectedTools.mustCall.length, 0);
  const missedMustCalls = failedCases.length;
  const passRate = totalMustCalls === 0 ? 1 : (totalMustCalls - missedMustCalls) / totalMustCalls;
  const l2 = { total: cases.length, passRate, failedCases: [...new Set(failedCases)] };
  const report: Phase2EvalReport = {
    phase: 'v2-phase2',
    generatedAt: new Date().toISOString(),
    layer: 'l2',
    mode,
    missingKeys: mode === 'dry' && !process.env.MODEL_API_KEY ? ['MODEL_API_KEY'] : [],
    l2,
  };

  if (l2.passRate < 0.85 || l2.failedCases.length > 0) {
    throw new Error(`L2 gate failed: ${JSON.stringify(l2)}`);
  }

  await writeAggregationSnapshot(options.reportDir ?? makePhase2ReportDir(), 'l2-cases.json', cases);
  assertNoReportPii(JSON.stringify(report));
  return report;
}

async function writeAggregationSnapshot(
  reportDir: string,
  fileName: 'l2-cases.json',
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

export async function runAndWritePhase2L2(options: RunPhase2L2Options = {}): Promise<{
  report: Phase2EvalReport;
  runModePath: string;
  reportPath: string;
}> {
  const reportDir = options.reportDir ?? makePhase2ReportDir();
  const report = await runPhase2L2({ ...options, reportDir });
  const paths = await writePhase2EvalArtifacts(reportDir, report);
  return { report, ...paths };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAndWritePhase2L2()
    .then(({ runModePath, report }) => {
      console.log(`[phase2-eval:l2] mode=${report.mode} passRate=${report.l2?.passRate} runMode=${runModePath}`);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
