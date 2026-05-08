import { BizError } from '@storepilot/shared-contracts';
import { z } from 'zod';

import { validateOutput } from '../../safety/output-validator.js';

const FUZZY_NUMBER_RE =
  /(?:约|大概|差不多)\s*[+-]?\d|[+-]?\d+(?:\.\d+)?\s*(?:元|单|个|件|%|SKU)?\s*左右/;

export function validateReportOutput<T>(args: {
  schema: z.ZodType<T>;
  output: unknown;
  allowedNumbers: Set<string>;
  enforceNumberConsistency?: boolean;
}): T {
  try {
    const parsed = validateOutput({
      schema: args.schema,
      output: args.output,
      allowedNumbers: new Set(args.allowedNumbers),
      ...(args.enforceNumberConsistency === undefined
        ? {}
        : { enforceNumberConsistency: args.enforceNumberConsistency }),
    });
    const markdown = (parsed as { summaryMarkdown?: unknown }).summaryMarkdown;
    if (typeof markdown === 'string' && FUZZY_NUMBER_RE.test(markdown)) {
      throw new BizError('SCHEMA_FAIL', '报表输出包含模糊数字措辞');
    }
    return parsed;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new BizError('SCHEMA_FAIL', '报表输出结构校验失败', {
        meta: { issues: error.issues },
      });
    }
    throw error;
  }
}
