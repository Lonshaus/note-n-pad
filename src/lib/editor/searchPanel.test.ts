// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { inScope, type ScopeState } from './searchPanel';

describe('inScope', () => {
  const range: ScopeState = { on: true, scope: { from: 10, to: 20 } };

  it('never restricts when off', () => {
    const off: ScopeState = { on: false, scope: { from: 10, to: 20 } };
    expect(inScope(off, 0, 5)).toBe(true);
    expect(inScope(off, 100, 200)).toBe(true);
  });

  it('never restricts when the captured selection was empty (whole document)', () => {
    const whole: ScopeState = { on: true, scope: null };
    expect(inScope(whole, 0, 5)).toBe(true);
    expect(inScope(whole, 100, 200)).toBe(true);
  });

  it('accepts a match fully inside the range, including the edges', () => {
    expect(inScope(range, 12, 15)).toBe(true);
    expect(inScope(range, 10, 20)).toBe(true);
    expect(inScope(range, 10, 11)).toBe(true);
    expect(inScope(range, 19, 20)).toBe(true);
  });

  it('rejects a match crossing or outside the range', () => {
    expect(inScope(range, 5, 12)).toBe(false);
    expect(inScope(range, 18, 25)).toBe(false);
    expect(inScope(range, 0, 5)).toBe(false);
    expect(inScope(range, 21, 30)).toBe(false);
  });
});
