// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { ChangeSet } from '@codemirror/state';
import { changesToEdits, spansToDecorations } from './cmAdapter';
import type { SpanRange } from './protocol';

describe('spansToDecorations', () => {
  it('produces one mark decoration per span, in document order', () => {
    const spans: SpanRange[] = [
      { from: 0, to: 5, cls: 'tok-keyword' },
      { from: 6, to: 11, cls: 'tok-variableName' },
    ];
    const decos = spansToDecorations(spans);
    expect(decos).toHaveLength(2);
    expect(decos[0]?.from).toBe(0);
    expect(decos[0]?.to).toBe(5);
    expect(decos[1]?.from).toBe(6);
    expect(decos[1]?.to).toBe(11);
    // Sorted by `from`, as RangeSet.add requires.
    let prev = -1;
    for (const deco of decos) {
      expect(deco.from).toBeGreaterThanOrEqual(prev);
      prev = deco.from;
    }
  });

  it('returns an empty array for no spans', () => {
    expect(spansToDecorations([])).toEqual([]);
  });
});

describe('changesToEdits', () => {
  it('reports edits in pre-edit coordinates', () => {
    // "hello world" -> replace "world" (6..11) with "there".
    const changes = ChangeSet.of([{ from: 6, to: 11, insert: 'there' }], 11);
    expect(changesToEdits(changes)).toEqual([
      { from: 6, to: 11, insert: 'there' },
    ]);
  });

  it('keeps a multi-change batch in original coordinates', () => {
    // On "abcdefgh" (len 8): delete 1..3, insert "X" at 6.
    const changes = ChangeSet.of(
      [
        { from: 1, to: 3, insert: '' },
        { from: 6, to: 6, insert: 'X' },
      ],
      8,
    );
    expect(changesToEdits(changes)).toEqual([
      { from: 1, to: 3, insert: '' },
      { from: 6, to: 6, insert: 'X' },
    ]);
  });

  it('reports a pure insertion', () => {
    const changes = ChangeSet.of([{ from: 2, to: 2, insert: 'Q' }], 4);
    expect(changesToEdits(changes)).toEqual([{ from: 2, to: 2, insert: 'Q' }]);
  });
});
