// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  byteLength,
  byteToCharIndex,
  COALESCE_MS,
  decideNewGroup,
  mapChangesToEdits,
  nextWindow,
  type RawChange,
} from './windowedEdit';

describe('byteLength', () => {
  it('counts ASCII as one byte each', () => {
    expect(byteLength('abc')).toBe(3);
  });

  it('counts multi-byte UTF-8 by encoded length', () => {
    // "é" is 2 bytes, "日" is 3 bytes.
    expect(byteLength('é日')).toBe(5);
  });
});

describe('mapChangesToEdits', () => {
  it('maps a plain insertion at a window with zero offset', () => {
    // Insert "X" at char 2 of "abcd" (no deletion): fromA === toA.
    const changes: RawChange[] = [{ fromA: 2, toA: 2, inserted: 'X' }];
    expect(mapChangesToEdits(0, 'abcd', changes)).toEqual([
      { start: 2, end: 2, text: 'X' },
    ]);
  });

  it('adds the window byte offset to every position', () => {
    const changes: RawChange[] = [{ fromA: 1, toA: 1, inserted: 'Z' }];
    expect(mapChangesToEdits(1000, 'abcd', changes)).toEqual([
      { start: 1001, end: 1001, text: 'Z' },
    ]);
  });

  it('maps a deletion as an empty-text byte range', () => {
    // Delete "bc" from "abcd": [1,3) removed.
    const changes: RawChange[] = [{ fromA: 1, toA: 3, inserted: '' }];
    expect(mapChangesToEdits(0, 'abcd', changes)).toEqual([
      { start: 1, end: 3, text: '' },
    ]);
  });

  it('maps a replacement with both a range and inserted text', () => {
    const changes: RawChange[] = [{ fromA: 1, toA: 3, inserted: 'YY' }];
    expect(mapChangesToEdits(0, 'abcd', changes)).toEqual([
      { start: 1, end: 3, text: 'YY' },
    ]);
  });

  it('measures positions in UTF-8 bytes, not chars', () => {
    // docBefore "aé日b": chars a(1) é(1) 日(1) b(1); bytes a=1, é=2, 日=3.
    // Insert "!" after "é" (char index 2) → byte prefix "aé" = 1 + 2 = 3.
    const changes: RawChange[] = [{ fromA: 2, toA: 2, inserted: '!' }];
    expect(mapChangesToEdits(0, 'aé日b', changes)).toEqual([
      { start: 3, end: 3, text: '!' },
    ]);
  });

  it('maps multiple changes in one transaction directly (pre-change coords)', () => {
    // Two ascending, non-overlapping changes against the same docBefore.
    const changes: RawChange[] = [
      { fromA: 1, toA: 2, inserted: 'X' },
      { fromA: 4, toA: 4, inserted: 'YY' },
    ];
    expect(mapChangesToEdits(10, 'abcde', changes)).toEqual([
      { start: 11, end: 12, text: 'X' },
      { start: 14, end: 14, text: 'YY' },
    ]);
  });

  it('keeps later multibyte changes on pre-change byte coords', () => {
    // docBefore "中😀xY": chars 中(idx 0, 3 bytes) 😀(idx 1-2 surrogate pair,
    // 4 bytes) x(idx 3) Y(idx 4). Change 1 inserts "哈!" (3 + 1 = 4 bytes) at
    // char 1 (byte 3); change 2 replaces "x" (bytes 7..8) with "€" (3 bytes).
    // If change 1's inserted bytes leaked into change 2's coordinates, start
    // would come out 107 + 4 = 111 instead of 107.
    const changes: RawChange[] = [
      { fromA: 1, toA: 1, inserted: '哈!' },
      { fromA: 3, toA: 4, inserted: '€' },
    ];
    expect(mapChangesToEdits(100, '中😀xY', changes)).toEqual([
      { start: 103, end: 103, text: '哈!' },
      { start: 107, end: 108, text: '€' },
    ]);
  });
});

describe('nextWindow', () => {
  const W = 2000;
  const M = 500;

  it('clamps the start to 0 near the top of the file', () => {
    expect(nextWindow(100, 100_000, W, M)).toEqual({
      startLine: 0,
      endLine: 2000,
    });
  });

  it('anchors margin lines above the target in the middle', () => {
    expect(nextWindow(50_000, 100_000, W, M)).toEqual({
      startLine: 49_500,
      endLine: 51_500,
    });
  });

  it('pulls a full window back from the end of the file', () => {
    expect(nextWindow(99_900, 100_000, W, M)).toEqual({
      startLine: 98_000,
      endLine: 100_000,
    });
  });

  it('returns the whole file when it is shorter than a window', () => {
    expect(nextWindow(10, 300, W, M)).toEqual({ startLine: 0, endLine: 300 });
  });

  it('handles an empty file', () => {
    expect(nextWindow(0, 0, W, M)).toEqual({ startLine: 0, endLine: 0 });
  });
});

describe('byteToCharIndex', () => {
  it('maps ASCII bytes 1:1 to char indices', () => {
    expect(byteToCharIndex('abcd', 0)).toBe(0);
    expect(byteToCharIndex('abcd', 2)).toBe(2);
    expect(byteToCharIndex('abcd', 4)).toBe(4);
  });

  it('clamps a non-positive offset to 0', () => {
    expect(byteToCharIndex('abc', -5)).toBe(0);
  });

  it('counts multi-byte characters by their UTF-8 length', () => {
    // "é" = 2 bytes (1 code unit), "日" = 3 bytes (1 code unit).
    // Byte offset 2 sits right after "é": 1 char in.
    expect(byteToCharIndex('éX', 2)).toBe(1);
    // "aé日": byte prefix "aé" = 1 + 2 = 3 bytes → 2 chars.
    expect(byteToCharIndex('aé日b', 3)).toBe(2);
    // Full "aé日" = 6 bytes → 3 chars.
    expect(byteToCharIndex('aé日b', 6)).toBe(3);
  });

  it('counts a surrogate pair as its two UTF-16 code units', () => {
    // "😀" is 4 UTF-8 bytes and 2 UTF-16 code units. Offset past it → 2.
    expect(byteToCharIndex('😀x', 4)).toBe(2);
    // A "中"(3 bytes) before "😀": byte offset 3 → 1 char (中).
    expect(byteToCharIndex('中😀', 3)).toBe(1);
    // Both = 7 bytes → 1 + 2 = 3 code units.
    expect(byteToCharIndex('中😀', 7)).toBe(3);
  });

  it('rounds a mid-character offset up to the next boundary', () => {
    // Offset 1 lands inside the 2-byte "é"; rounds up to char 1.
    expect(byteToCharIndex('éX', 1)).toBe(1);
  });
});

describe('decideNewGroup', () => {
  const base = { time: 1000, kind: 'input', composing: false };

  it('opens a group on the very first edit (no prior kind)', () => {
    expect(
      decideNewGroup(
        { time: 0, kind: null, composing: false },
        {
          time: 1000,
          kind: 'input',
          composing: false,
          compositionStart: false,
        },
      ),
    ).toBe(true);
  });

  it('coalesces a same-kind edit within the coalesce window', () => {
    expect(
      decideNewGroup(base, {
        time: base.time + COALESCE_MS,
        kind: 'input',
        composing: false,
        compositionStart: false,
      }),
    ).toBe(false);
  });

  it('opens a group after a pause longer than the coalesce window', () => {
    expect(
      decideNewGroup(base, {
        time: base.time + COALESCE_MS + 1,
        kind: 'input',
        composing: false,
        compositionStart: false,
      }),
    ).toBe(true);
  });

  it('opens a group when the edit kind changes', () => {
    expect(
      decideNewGroup(base, {
        time: base.time + 10,
        kind: 'delete',
        composing: false,
        compositionStart: false,
      }),
    ).toBe(true);
    expect(
      decideNewGroup(base, {
        time: base.time + 10,
        kind: 'paste',
        composing: false,
        compositionStart: false,
      }),
    ).toBe(true);
  });

  it('opens a group on composition start and joins later composing edits', () => {
    // First composing transaction opens the group.
    expect(
      decideNewGroup(
        { time: 0, kind: 'input', composing: false },
        { time: 10, kind: 'input', composing: true, compositionStart: true },
      ),
    ).toBe(true);
    // A later composing transaction (even after a long pause) joins it.
    expect(
      decideNewGroup(
        { time: 0, kind: 'input', composing: true },
        {
          time: 5000,
          kind: 'input',
          composing: true,
          compositionStart: false,
        },
      ),
    ).toBe(false);
  });

  it('opens a fresh group on the first edit after composition ends', () => {
    expect(
      decideNewGroup(
        { time: 0, kind: 'input', composing: true },
        { time: 10, kind: 'input', composing: false, compositionStart: false },
      ),
    ).toBe(true);
  });
});
