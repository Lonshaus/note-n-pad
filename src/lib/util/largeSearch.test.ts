// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { moveResultCursor, parseGotoLine, parseGotoRange } from './largeSearch';

describe('parseGotoLine', () => {
  it('converts a 1-based number to a 0-based line', () => {
    expect(parseGotoLine('1', 100)).toBe(0);
    expect(parseGotoLine('42', 100)).toBe(41);
  });

  it('clamps to the last line when the total is known', () => {
    expect(parseGotoLine('500', 100)).toBe(99);
  });

  it('clamps up to the first line for zero', () => {
    expect(parseGotoLine('0', 100)).toBe(0);
  });

  it('only clamps the lower bound while the total is unknown', () => {
    expect(parseGotoLine('999999', null)).toBe(999998);
    expect(parseGotoLine('0', null)).toBe(0);
  });

  it('ignores surrounding whitespace', () => {
    expect(parseGotoLine('  7  ', 100)).toBe(6);
  });

  it('returns null for empty or non-numeric input', () => {
    expect(parseGotoLine('', 100)).toBeNull();
    expect(parseGotoLine('abc', 100)).toBeNull();
    expect(parseGotoLine('12x', 100)).toBeNull();
    expect(parseGotoLine('-3', 100)).toBeNull();
  });
});

describe('parseGotoRange', () => {
  it('parses a single number as a line jump', () => {
    expect(parseGotoRange('42', 100)).toEqual({ kind: 'line', line: 41 });
  });

  it('parses an A-B pair as a 0-based inclusive range', () => {
    expect(parseGotoRange('12-500', 1000)).toEqual({
      kind: 'range',
      range: { start: 11, end: 499 },
    });
  });

  it('orders reversed endpoints', () => {
    expect(parseGotoRange('500-12', 1000)).toEqual({
      kind: 'range',
      range: { start: 11, end: 499 },
    });
  });

  it('clamps each endpoint to the known total', () => {
    expect(parseGotoRange('90-500', 100)).toEqual({
      kind: 'range',
      range: { start: 89, end: 99 },
    });
  });

  it('ignores surrounding whitespace on each endpoint', () => {
    expect(parseGotoRange('  3 - 7 ', 100)).toEqual({
      kind: 'range',
      range: { start: 2, end: 6 },
    });
  });

  it('returns null when either endpoint is empty or non-numeric', () => {
    expect(parseGotoRange('12-', 100)).toBeNull();
    expect(parseGotoRange('-3', 100)).toBeNull();
    expect(parseGotoRange('12-x', 100)).toBeNull();
    expect(parseGotoRange('', 100)).toBeNull();
    expect(parseGotoRange('1-2-3', 100)).toBeNull();
  });
});

describe('moveResultCursor', () => {
  it('returns -1 for an empty list', () => {
    expect(moveResultCursor(-1, 0, 1)).toBe(-1);
    expect(moveResultCursor(3, 0, -1)).toBe(-1);
  });

  it('lands on the first result from an unselected cursor', () => {
    expect(moveResultCursor(-1, 5, 1)).toBe(0);
  });

  it('steps forward and backward within bounds', () => {
    expect(moveResultCursor(2, 5, 1)).toBe(3);
    expect(moveResultCursor(2, 5, -1)).toBe(1);
  });

  it('clamps at both ends instead of wrapping', () => {
    expect(moveResultCursor(4, 5, 1)).toBe(4);
    expect(moveResultCursor(0, 5, -1)).toBe(0);
  });
});
