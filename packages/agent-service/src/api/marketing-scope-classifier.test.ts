import { describe, expect, it } from 'vitest';

import {
  ScopeClassifierCaseSchema,
  ScopeOutputSchema,
  buildScopeClassifierSystemPrompt,
  classifyMarketingScope,
  parseScopeClassifierText,
  validateScopeClassifierExamples,
} from './marketing-scope-classifier.js';

describe('marketing-scope-classifier', () => {
  it('validates scope output and rejects free-text candidates', () => {
    expect(
      ScopeOutputSchema.parse({
        scope: 'AMBIGUOUS',
        confidence: 0.58,
        candidates: ['US-013', 'US-012'],
      }),
    ).toMatchObject({ scope: 'AMBIGUOUS' });

    expect(() =>
      ScopeOutputSchema.parse({
        scope: 'AMBIGUOUS',
        confidence: 0.7,
        candidates: ['沉睡会员'],
      }),
    ).toThrow();
  });

  it('loads examples from JSON with IN/AMBIGUOUS/OUT coverage', () => {
    const result = validateScopeClassifierExamples();
    expect(result.total).toBeGreaterThanOrEqual(30);
    expect(result.counts.V2_IN_SCOPE).toBeGreaterThanOrEqual(10);
    expect(result.counts.AMBIGUOUS).toBeGreaterThanOrEqual(10);
    expect(result.counts.OUT_OF_SCOPE).toBeGreaterThanOrEqual(10);
    expect(buildScopeClassifierSystemPrompt()).toContain(`样例（${result.total} 条`);
  });

  it('dry-runs deterministic scope decisions without external LLM calls', async () => {
    await expect(classifyMarketingScope('经营日报', { dryRun: true })).resolves.toMatchObject({
      scope: 'OUT_OF_SCOPE',
      reason: 'V1_LEAKED',
    });
    await expect(classifyMarketingScope('搞个活动', { dryRun: true })).resolves.toMatchObject({
      scope: 'AMBIGUOUS',
      candidates: ['US-013', 'US-012', 'US-011'],
    });
    await expect(classifyMarketingScope('沉睡会员', { dryRun: true })).resolves.toMatchObject({
      scope: 'V2_IN_SCOPE',
      candidates: ['US-003'],
    });
  });

  it('谁该来补货 enters US-004 by semantic scope classification after explicit V1 misses', async () => {
    await expect(classifyMarketingScope('谁该来补货了', { dryRun: true })).resolves.toMatchObject({
      scope: 'V2_IN_SCOPE',
      candidates: ['US-004'],
    });
  });

  it('defines a reusable classifier case schema', () => {
    expect(
      ScopeClassifierCaseSchema.parse({
        id: 'SCOPE-IN-001',
        userMessage: '沉睡会员',
        expectedScope: 'V2_IN_SCOPE',
        expectedCandidates: ['US-003'],
      }),
    ).toMatchObject({ expectedScope: 'V2_IN_SCOPE' });
  });

  it('parses plain text JSON and accepts IN_SCOPE alias from OpenAI-compatible models', () => {
    expect(
      parseScopeClassifierText('```json\n{"scope":"IN_SCOPE","confidence":0.91,"candidates":["US-010"]}\n```'),
    ).toMatchObject({
      scope: 'V2_IN_SCOPE',
      confidence: 0.91,
      candidates: ['US-010'],
      degraded: false,
    });
  });
});
