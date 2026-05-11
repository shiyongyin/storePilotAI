import l2Us003Cases from './l2-cases.us003.json';
import l2Us004Cases from './l2-cases.us004.json';
import l2Us005Cases from './l2-cases.us005.json';
import l2Us006Cases from './l2-cases.us006.json';
import l2Us007Cases from './l2-cases.us007.json';
import l2Us008Cases from './l2-cases.us008.json';
import l2Us009Cases from './l2-cases.us009.json';
import l2Us010Cases from './l2-cases.us010.json';
import l3Us003Cases from './l3-cases.us003.json';
import l3Us004Cases from './l3-cases.us004.json';
import l3Us005Cases from './l3-cases.us005.json';
import l3Us006Cases from './l3-cases.us006.json';
import l3Us007Cases from './l3-cases.us007.json';
import l3Us008Cases from './l3-cases.us008.json';
import l3Us009Cases from './l3-cases.us009.json';
import l3Us010Cases from './l3-cases.us010.json';
import {
  L2ToolCombinationCaseSchema,
  L3OutputQualityCaseSchema,
  type Phase2UsCode,
} from './case-schema.js';

export const PHASE2_US_CODES: readonly Phase2UsCode[] = [
  'US-003',
  'US-004',
  'US-005',
  'US-006',
  'US-007',
  'US-008',
  'US-009',
  'US-010',
];

const l2CaseSources = [
  l2Us003Cases,
  l2Us004Cases,
  l2Us005Cases,
  l2Us006Cases,
  l2Us007Cases,
  l2Us008Cases,
  l2Us009Cases,
  l2Us010Cases,
] as const;

const l3CaseSources = [
  l3Us003Cases,
  l3Us004Cases,
  l3Us005Cases,
  l3Us006Cases,
  l3Us007Cases,
  l3Us008Cases,
  l3Us009Cases,
  l3Us010Cases,
] as const;

export type Phase2L2Case = ReturnType<typeof L2ToolCombinationCaseSchema.parse>;
export type Phase2L3Case = ReturnType<typeof L3OutputQualityCaseSchema.parse>;

export function loadPhase2L2Cases(): Phase2L2Case[] {
  const cases = l2CaseSources.flatMap((source) =>
    source.map((item) => L2ToolCombinationCaseSchema.parse(item)),
  );
  assertCoverage(cases, 'L2', 2, 20);
  return cases;
}

export function loadPhase2L3Cases(): Phase2L3Case[] {
  const cases = l3CaseSources.flatMap((source) =>
    source.map((item) => L3OutputQualityCaseSchema.parse(item)),
  );
  assertCoverage(cases, 'L3', 2, 20);
  return cases;
}

function assertCoverage(
  cases: ReadonlyArray<{ coveredUs: readonly Phase2UsCode[] }>,
  layer: 'L2' | 'L3',
  minPerUs: number,
  minTotal: number,
): void {
  if (cases.length < minTotal) {
    throw new Error(`${layer} case 总数 ${cases.length} 不足 ${minTotal}`);
  }
  for (const us of PHASE2_US_CODES) {
    const count = cases.filter((item) => item.coveredUs.includes(us)).length;
    if (count < minPerUs) {
      throw new Error(`${layer} case 不足：${us} 仅 ${count} 条，需 >= ${minPerUs}`);
    }
  }
}
