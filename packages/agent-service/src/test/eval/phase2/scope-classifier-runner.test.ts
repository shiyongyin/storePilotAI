import cases from './scope-classifier-cases.json';
import { describe, expect, it } from 'vitest';

import { classifyMarketingScope } from '../../../api/marketing-scope-classifier.js';
import { ScopeClassifierCaseSchema } from './case-schema.js';

describe('phase2 scope classifier cases', () => {
  it('meets dry-run accuracy, OUT recall, ambiguous share, and latency gates', async () => {
    const parsed = cases.map((item) => ScopeClassifierCaseSchema.parse(item));
    let correct = 0;
    let outTotal = 0;
    let outCorrect = 0;
    let actualAmbiguous = 0;
    const latencies: number[] = [];

    for (const item of parsed) {
      const started = performance.now();
      const actual = await classifyMarketingScope(item.userMessage, { dryRun: true });
      latencies.push(performance.now() - started);
      if (actual.scope === item.expectedScope) correct += 1;
      if (actual.scope === 'AMBIGUOUS') actualAmbiguous += 1;
      if (item.expectedScope === 'OUT_OF_SCOPE') {
        outTotal += 1;
        if (actual.scope === 'OUT_OF_SCOPE') outCorrect += 1;
      }
    }

    const sorted = [...latencies].sort((a: number, b: number) => a - b);
    const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
    const p95Latency = sorted[p95Index] ?? 0;
    const ambiguousShare = actualAmbiguous / parsed.length;

    expect(parsed.filter((item) => item.expectedScope === 'V2_IN_SCOPE')).toHaveLength(30);
    expect(parsed.filter((item) => item.expectedScope === 'AMBIGUOUS')).toHaveLength(10);
    expect(parsed.filter((item) => item.expectedScope === 'OUT_OF_SCOPE')).toHaveLength(30);
    expect(correct / parsed.length).toBeGreaterThanOrEqual(0.85);
    expect(outCorrect / outTotal).toBeGreaterThanOrEqual(0.9);
    expect(ambiguousShare).toBeGreaterThanOrEqual(0.05);
    expect(ambiguousShare).toBeLessThanOrEqual(0.15);
    expect(p95Latency).toBeLessThanOrEqual(500);
  });
});
