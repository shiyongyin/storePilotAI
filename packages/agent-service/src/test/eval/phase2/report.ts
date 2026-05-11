import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type Phase2EvalLayer = 'l2' | 'l3' | 'l4' | 'dry' | 'scope';
export type Phase2EvalMode = 'dry' | 'live';

export interface Phase2EvalReport {
  phase: 'v2-phase2';
  generatedAt: string;
  layer: Phase2EvalLayer;
  mode: Phase2EvalMode;
  missingKeys: string[];
  l2?: {
    total: number;
    passRate: number;
    failedCases: string[];
  };
  l3?: {
    total: number;
    avgScore: number;
    minScore: number;
    failedCases: string[];
  };
  l4?: {
    violations: string[];
  };
  scope?: {
    total: number;
    accuracy: number;
    outRecall: number;
    ambiguousShare: number;
    p95LatencyMs: number;
    failedCases: string[];
  };
  v1Regression?: {
    passed: boolean;
  };
}

export interface Phase2RunModeRecord {
  phase: 'v2-phase2';
  layer: Phase2EvalLayer;
  mode: Phase2EvalMode;
  missingKeys: string[];
  startedAt: string;
  reportPath?: string;
  l2?: Phase2EvalReport['l2'];
  l3?: Phase2EvalReport['l3'];
  l4?: Phase2EvalReport['l4'];
  scope?: Phase2EvalReport['scope'];
  v1Regression?: Phase2EvalReport['v1Regression'];
}

export function makePhase2ReportDir(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.resolve(
    process.cwd(),
    '..',
    '..',
    'reports',
    'phase2-eval',
    `${stamp}-${process.pid}`,
  );
}

export async function writePhase2EvalArtifacts(
  reportDir: string,
  report: Phase2EvalReport,
): Promise<{ runModePath: string; reportPath: string }> {
  await mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `${report.layer}-report.json`);
  const runModePath = path.join(reportDir, 'run-mode.json');
  const runMode: Phase2RunModeRecord = {
    phase: report.phase,
    layer: report.layer,
    mode: report.mode,
    missingKeys: report.missingKeys,
    startedAt: report.generatedAt,
    reportPath,
    ...(report.l2 === undefined ? {} : { l2: report.l2 }),
    ...(report.l3 === undefined ? {} : { l3: report.l3 }),
    ...(report.l4 === undefined ? {} : { l4: report.l4 }),
    ...(report.scope === undefined ? {} : { scope: report.scope }),
    ...(report.v1Regression === undefined ? {} : { v1Regression: report.v1Regression }),
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(runModePath, `${JSON.stringify(runMode, null, 2)}\n`, 'utf8');
  return { runModePath, reportPath };
}

export function assertNoReportPii(text: string): void {
  const forbidden = /1[0-9]{10}|phoneFull|nameFull|tool_calls|function_call/;
  if (forbidden.test(text)) {
    throw new Error('phase2 eval report contains PII or system protocol terms');
  }
}
