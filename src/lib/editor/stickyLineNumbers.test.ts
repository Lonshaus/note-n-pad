// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { StickyNumber, maxLineNumber } from './stickyLineNumbers';

describe('maxLineNumber', () => {
  it('rounds up to the next run of nines', () => {
    expect(maxLineNumber(0)).toBe(9);
    expect(maxLineNumber(1)).toBe(9);
    expect(maxLineNumber(9)).toBe(9);
    expect(maxLineNumber(10)).toBe(99);
    expect(maxLineNumber(99)).toBe(99);
    expect(maxLineNumber(100)).toBe(999);
    expect(maxLineNumber(1_000_001)).toBe(9_999_999);
  });
});
describe('StickyNumber', () => {
  it('equals a marker with the same text only', () => {
    expect(new StickyNumber('12').eq(new StickyNumber('12'))).toBe(true);
    expect(new StickyNumber('12').eq(new StickyNumber('13'))).toBe(false);
  });
});
