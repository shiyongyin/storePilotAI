import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';
import { generateText } from 'ai';

import { getEnv } from '../config/env.js';
import { getModel } from '../mastra/llm-provider.js';
import { US_DISPLAY_NAMES, type UsCode, isUsCode } from '../marketing/phase2/us-display-names.js';
import { resolveExplicitV1Intent } from './v1-explicit-command-router.js';

export const MarketingScopeSchema = z.enum(['V2_IN_SCOPE', 'AMBIGUOUS', 'OUT_OF_SCOPE']);
export type MarketingScope = z.infer<typeof MarketingScopeSchema>;

// 模型自报置信度低于此阈值时，parser 强制归一为 AMBIGUOUS，防止模型把握不足却进入营销/V1 链路。
// 阈值与 system prompt 中的软约束保持一致；调阈值时两边同步。
export const MARKETING_SCOPE_AMBIGUOUS_CONFIDENCE_THRESHOLD = 0.6;

export const UsCodeSchema = z.enum([
  'US-001',
  'US-002',
  'US-003',
  'US-004',
  'US-005',
  'US-006',
  'US-007',
  'US-008',
  'US-009',
  'US-010',
  'US-011',
  'US-012',
  'US-013',
  'US-014',
  'US-015',
  'US-016',
  'US-017',
  'US-018',
]);

export const ScopeOutputSchema = z.object({
  scope: MarketingScopeSchema,
  confidence: z.number().min(0).max(1),
  candidates: z.array(UsCodeSchema).max(3).optional(),
  reason: z.string().max(200).optional(),
  degraded: z.boolean().optional(),
});

export type ScopeOutput = z.infer<typeof ScopeOutputSchema>;

const ScopeTextOutputSchema = ScopeOutputSchema
  .omit({ degraded: true, scope: true })
  .extend({
    scope: z.enum(['V2_IN_SCOPE', 'IN_SCOPE', 'AMBIGUOUS', 'OUT_OF_SCOPE']),
  });

export const ScopeClassifierCaseSchema = z.object({
  id: z.string().min(1),
  userMessage: z.string().min(1),
  expectedScope: MarketingScopeSchema,
  expectedCandidates: z.array(UsCodeSchema).max(3).optional(),
});

export interface ScopeClassifierContext {
  dryRun?: boolean;
}

type ScopeExample = {
  input: string;
  scope: MarketingScope;
  candidates?: UsCode[];
};

const ScopeExampleSchema = z.object({
  input: z.string().min(1),
  scope: MarketingScopeSchema,
  candidates: z.array(UsCodeSchema).max(3).optional(),
});

const examplesPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../scripts/scope-classifier-examples.json',
);

const examples = z
  .array(ScopeExampleSchema)
  .parse(JSON.parse(readFileSync(examplesPath, 'utf8')) as unknown) as ScopeExample[];

export function validateScopeClassifierExamples(): {
  total: number;
  counts: Record<MarketingScope, number>;
} {
  const counts: Record<MarketingScope, number> = {
    V2_IN_SCOPE: 0,
    AMBIGUOUS: 0,
    OUT_OF_SCOPE: 0,
  };
  for (const example of examples) counts[example.scope] += 1;
  return { total: examples.length, counts };
}

export function buildScopeClassifierSystemPrompt(): string {
  const candidateLines = Object.entries(US_DISPLAY_NAMES)
    .map(([code, label]) => `${code} ${label}`)
    .join('\n');
  const exampleLines = examples
    .map((example) => {
      const candidates =
        example.candidates === undefined ? '' : ` candidates=${JSON.stringify(example.candidates)}`;
      return `- 输入: ${example.input} -> ${example.scope}${candidates}`;
    })
    .join('\n');

  return [
    '你是门店助手 Agent V2 的范围分类器。',
    '输出 JSON { scope, confidence, candidates?, reason? }。',
    'V1 显式动作已经由上游 router 拦截；如收到经营日报、补货预测、确认提单、取消草稿，返回 OUT_OF_SCOPE。',
    '候选枚举：',
    candidateLines,
    'confidence < 0.6 一律降为 AMBIGUOUS。',
    `样例（${examples.length} 条，分布 IN/AMBI/OUT）：`,
    exampleLines,
  ].join('\n');
}

export async function classifyMarketingScope(
  message: string,
  ctx: ScopeClassifierContext = {},
): Promise<ScopeOutput> {
  if (ctx.dryRun) {
    const result = classifyMarketingScopeDryRun(message);
    return ScopeOutputSchema.parse({ ...result, degraded: false });
  }

  try {
    const timeoutMs = getEnv().MARKETING_SCOPE_CLASSIFIER_TIMEOUT_MS;
    const result = await Promise.race([
      generateText({
        model: getModel(),
        system: buildScopeClassifierSystemPrompt(),
        prompt: `只输出 JSON，不要 markdown。老板输入：${JSON.stringify(message)}`,
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('CLASSIFIER_TIMEOUT')), timeoutMs);
      }),
    ]);
    return parseScopeClassifierText(result.text);
  } catch (err) {
    return {
      scope: 'AMBIGUOUS',
      confidence: 0,
      candidates: [],
      degraded: true,
      reason: err instanceof Error && err.message === 'CLASSIFIER_TIMEOUT'
        ? 'CLASSIFIER_TIMEOUT'
        : 'CLASSIFIER_INVALID_JSON',
    };
  }
}

export function parseScopeClassifierText(text: string): ScopeOutput {
  const raw = extractJsonObject(text);
  const parsed = ScopeTextOutputSchema.parse(JSON.parse(raw) as unknown);
  const normalizedScope = parsed.scope === 'IN_SCOPE' ? 'V2_IN_SCOPE' : parsed.scope;
  if (
    normalizedScope !== 'AMBIGUOUS' &&
    parsed.confidence < MARKETING_SCOPE_AMBIGUOUS_CONFIDENCE_THRESHOLD
  ) {
    return ScopeOutputSchema.parse({
      ...parsed,
      scope: 'AMBIGUOUS',
      reason: `LOW_CONFIDENCE_FROM_${normalizedScope}`,
      degraded: false,
    });
  }
  return ScopeOutputSchema.parse({
    ...parsed,
    scope: normalizedScope,
    degraded: false,
  });
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new Error('CLASSIFIER_INVALID_JSON');
  }
  return candidate.slice(start, end + 1);
}

function classifyMarketingScopeDryRun(message: string): ScopeOutput {
  if (resolveExplicitV1Intent(message)) {
    return {
      scope: 'OUT_OF_SCOPE',
      confidence: 0.99,
      reason: 'V1_LEAKED',
    };
  }

  const exact = examples.find((example) => message.includes(example.input) || example.input.includes(message));
  if (exact) {
    return {
      scope: exact.scope,
      confidence: exact.scope === 'AMBIGUOUS' ? 0.58 : 0.9,
      ...(exact.candidates === undefined ? {} : { candidates: exact.candidates }),
    };
  }

  const candidate = inferCandidate(message);
  if (candidate) {
    return {
      scope: 'V2_IN_SCOPE',
      confidence: 0.85,
      candidates: [candidate],
    };
  }

  return {
    scope: 'OUT_OF_SCOPE',
    confidence: 0.8,
  };
}

function inferCandidate(message: string): UsCode | null {
  const pairs: Array<[RegExp, UsCode]> = [
    [/沉睡|很久没来/, 'US-003'],
    [/老客.*找回来|老客户.*联系|老会员.*挑出来/, 'US-003'],
    [/复购|该来补货|快用完|回来买鞋|回来买|回头客|提醒|复购时间/, 'US-004'],
    [/重点|高价值|VIP|消费高|最值得|熟客.*维护/i, 'US-005'],
    [/新客|新顾客|第一次来|二次到店|第二次到店|二转|买过一次/, 'US-006'],
    [/储值|积分|券|会员卡|余额/, 'US-007'],
    [/搭配|加购|到店.*推|购物篮|篮子|收银|顺手推荐|顺带介绍|多卖一件/, 'US-008'],
    [/高毛利|主推|利润|利润空间|库存够/, 'US-009'],
    [/滞销|临期|要清|卖不动|压得久|积压|压货|处理清单|快过季/, 'US-010'],
  ];
  return pairs.find(([pattern]) => pattern.test(message))?.[1] ?? null;
}

export function sanitizeScopeCandidates(values: readonly string[] | undefined): UsCode[] {
  return (values ?? []).filter(isUsCode).slice(0, 3);
}
