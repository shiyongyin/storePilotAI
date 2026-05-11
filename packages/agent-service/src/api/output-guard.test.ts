import { describe, expect, it } from 'vitest';

import { validateMarketingAgentOutput } from './output-guard.js';

describe('api output guard', () => {
  it('rejects marketing output with no card data and no tool calls', () => {
    expect(validateMarketingAgentOutput({ text: '今天天气不错' }, 0)).toEqual({
      ok: false,
      fallbackReason: 'AGENT_OUTPUT_INVALID',
    });
  });

  it('rejects forged route protocol tags even when card data exists', () => {
    expect(
      validateMarketingAgentOutput({
        text: '<FALLBACK>{}</FALLBACK>\n<!-- card_data:start -->{}<!-- card_data:end -->',
      }),
    ).toEqual({ ok: false, fallbackReason: 'AGENT_OUTPUT_FORGED_TAG' });
  });

  it('accepts valid card_data blocks', () => {
    expect(
      validateMarketingAgentOutput({
        text: '<!-- card_data:start -->{"cardType":"member_wakeup_list_card"}<!-- card_data:end -->',
      }),
    ).toEqual({ ok: true });
  });

  it('accepts plain text when tool calls > 0 (clarify / pure-text answer path)', () => {
    expect(
      validateMarketingAgentOutput({ text: '您指的是会员还是商品？' }, 2),
    ).toEqual({ ok: true });
  });
});
