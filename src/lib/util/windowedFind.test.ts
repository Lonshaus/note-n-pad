// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  MAX_SELECTION_SPAN,
  endOfMatch,
  formatReplaced,
  gotoRangeSelection,
  hitSelection,
  orderedPositions,
  textMatchesQuery,
} from './windowedFind';

describe('hitSelection', () => {
  it('anchors at the start and heads to the end', () => {
    expect(
      hitSelection({
        start: { line: 899_999, col: 4 },
        end: { line: 899_999, col: 10 },
      }),
    ).toEqual({
      anchor: { line: 899_999, col: 4 },
      head: { line: 899_999, col: 10 },
    });
  });
});

describe('endOfMatch', () => {
  it('adds the needle length on the same line', () => {
    expect(endOfMatch({ line: 3, col: 5 }, 'needle')).toEqual({
      line: 3,
      col: 11,
    });
  });
  it('counts UTF-16 units, as CodeMirror does', () => {
    expect(endOfMatch({ line: 0, col: 0 }, 'a😀')).toEqual({ line: 0, col: 3 });
  });
  it('moves to a later line for a newline in the needle', () => {
    expect(endOfMatch({ line: 2, col: 7 }, 'ab\ncd\nef')).toEqual({
      line: 4,
      col: 2,
    });
    expect(endOfMatch({ line: 2, col: 7 }, 'x\n')).toEqual({ line: 3, col: 0 });
  });
});

describe('textMatchesQuery', () => {
  it('compares exactly when case matters', () => {
    expect(textMatchesQuery('Foo', 'Foo', true)).toBe(true);
    expect(textMatchesQuery('foo', 'Foo', true)).toBe(false);
  });
  it('folds ASCII letters only when case is ignored', () => {
    expect(textMatchesQuery('fOO', 'Foo', false)).toBe(true);
    expect(textMatchesQuery('É', 'é', false)).toBe(false);
    expect(textMatchesQuery('é', 'é', false)).toBe(true);
  });
  it('is false for another length or an empty query', () => {
    expect(textMatchesQuery('foo', 'fo', true)).toBe(false);
    expect(textMatchesQuery('', '', true)).toBe(false);
  });
  it('is false once the text under the selection changed', () => {
    expect(textMatchesQuery('fob', 'foo', false)).toBe(false);
  });
});

describe('gotoRangeSelection', () => {
  it('spans the lines with the head at the first one', () => {
    const sel = gotoRangeSelection(10, 20);
    expect(sel.head).toEqual({ line: 10, col: 0 });
    expect(sel.anchor.line).toBe(20);
    expect(sel.anchor.col).toBeGreaterThan(1_000_000);
  });
  it('keeps to what one window holds', () => {
    const sel = gotoRangeSelection(0, 5_000_000);
    expect(sel.anchor.line).toBe(MAX_SELECTION_SPAN);
    expect(sel.head.line).toBe(0);
  });
});

describe('formatReplaced', () => {
  it('fills in the count', () => {
    expect(formatReplaced('Replaced $ matches', 120_000)).toBe(
      'Replaced 120000 matches',
    );
  });
});

describe('orderedPositions', () => {
  it('orders a forward and a backward selection alike', () => {
    const a = { line: 1, col: 2 };
    const b = { line: 4, col: 0 };
    expect(orderedPositions({ anchor: a, head: b })).toEqual({
      first: a,
      last: b,
    });
    expect(orderedPositions({ anchor: b, head: a })).toEqual({
      first: a,
      last: b,
    });
    expect(
      orderedPositions({
        anchor: { line: 1, col: 3 },
        head: { line: 1, col: 1 },
      }).first,
    ).toEqual({ line: 1, col: 1 });
  });
});
