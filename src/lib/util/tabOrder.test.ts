// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { compareTabOrder, keyBetween, newKey, orderOf } from './tabOrder';

describe('orderOf', () => {
  it('is the stored key, or the tab index of a record without one', () => {
    expect(orderOf({ tab_index: 7, tab_order: 0.5 })).toBe(0.5);
    expect(orderOf({ tab_index: 7, tab_order: 0 })).toBe(0);
    expect(orderOf({ tab_index: 7 })).toBe(7);
    expect(orderOf({ tab_index: 7, tab_order: null })).toBe(7);
  });
});

describe('compareTabOrder', () => {
  it('sorts by key, then by tab index', () => {
    const rows = [
      { id: 'c', tab_index: 2, tab_order: 5 },
      { id: 'b', tab_index: 9, tab_order: 1 },
      { id: 'a2', tab_index: 4, tab_order: 1 },
      { id: 'legacy', tab_index: 3 },
    ];
    expect(rows.sort(compareTabOrder).map((r) => r.id)).toEqual([
      'a2',
      'b',
      'legacy',
      'c',
    ]);
  });

  it('keeps a legacy pair and a rewritten second record in display order', () => {
    // tab_index 30 and 31; only the second was written again, after a move to
    // the front, so it carries a key and the first does not.
    const first = { tab_index: 30 };
    const second = { tab_index: 31, tab_order: 29 };
    expect([first, second].sort(compareTabOrder)).toEqual([second, first]);
    expect([first, { tab_index: 31 }].sort(compareTabOrder)).toEqual([
      first,
      { tab_index: 31 },
    ]);
  });

  it('does not overflow on keys of very different size', () => {
    expect(
      compareTabOrder(
        { tab_index: 0, tab_order: 1e300 },
        { tab_index: 1, tab_order: -1e300 },
      ),
    ).toBe(1);
  });
});

describe('newKey', () => {
  it('is one above the highest key, and 0 for an empty window', () => {
    expect(newKey([])).toBe(0);
    expect(newKey([0, 3, 1])).toBe(4);
    expect(newKey([-2, -5])).toBe(-1);
    expect(newKey([0.5])).toBe(1.5);
  });
});

describe('keyBetween', () => {
  it('takes the midpoint of two neighbours', () => {
    expect(keyBetween(1, 2)).toBe(1.5);
    expect(keyBetween(-1, 3)).toBe(1);
  });

  it('goes one before the first and one after the last', () => {
    expect(keyBetween(null, 4)).toBe(3);
    expect(keyBetween(4, null)).toBe(5);
    expect(keyBetween(null, null)).toBe(0);
  });

  it('is null when no number is left between the neighbours', () => {
    const left = 1;
    const right = 1 + Number.EPSILON;
    expect(keyBetween(left, right)).toBeNull();
    expect(keyBetween(2, 2)).toBeNull();
    expect(keyBetween(1e300, 1e300)).toBeNull();
    // One more than the key does not exist in floating point at this size.
    expect(keyBetween(1e300, null)).toBeNull();
    expect(keyBetween(null, -1e300)).toBeNull();
  });

  it('can halve a gap many times before it is exhausted', () => {
    let right = 1;
    let steps = 0;
    for (
      let key = keyBetween(0, right);
      key !== null;
      key = keyBetween(0, right)
    ) {
      right = key;
      steps += 1;
    }
    expect(steps).toBeGreaterThan(1000);
    expect(right).toBeGreaterThan(0);
  });
});
