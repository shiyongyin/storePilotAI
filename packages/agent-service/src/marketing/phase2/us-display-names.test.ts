import { describe, expect, it } from 'vitest';

import { US_DISPLAY_NAMES, isUsCode } from './us-display-names.js';

describe('US_DISPLAY_NAMES', () => {
  it('covers all 18 US codes with unique user-visible labels', () => {
    const entries = Object.entries(US_DISPLAY_NAMES);

    expect(entries.map(([code]) => code)).toEqual(
      Array.from({ length: 18 }, (_, index) => `US-${String(index + 1).padStart(3, '0')}`),
    );
    expect(new Set(entries.map(([, label]) => label)).size).toBe(18);
    expect(entries.every(([, label]) => label.length > 0)).toBe(true);
  });

  it('recognizes only declared US codes', () => {
    expect(isUsCode('US-003')).toBe(true);
    expect(isUsCode('US-019')).toBe(false);
    expect(isUsCode('沉睡会员')).toBe(false);
  });
});
