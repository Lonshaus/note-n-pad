// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { matchSegments } from './matchSegments';

describe('matchSegments', () => {
  it('marks every occurrence, keeping the text between', () => {
    expect(matchSegments('a ERROR b ERROR', 'ERROR', true)).toEqual([
      { text: 'a ', hit: false },
      { text: 'ERROR', hit: true },
      { text: ' b ', hit: false },
      { text: 'ERROR', hit: true },
    ]);
  });

  it('keeps the original casing when matching case-insensitively', () => {
    expect(matchSegments('Error error', 'ERROR', false)).toEqual([
      { text: 'Error', hit: true },
      { text: ' ', hit: false },
      { text: 'error', hit: true },
    ]);
  });

  it('does not match a different case when case-sensitive', () => {
    expect(matchSegments('error', 'ERROR', true)).toEqual([
      { text: 'error', hit: false },
    ]);
  });

  it('folds ASCII only, like the backend search', () => {
    expect(matchSegments('ÉCOLE', 'école', false)).toEqual([
      { text: 'ÉCOLE', hit: false },
    ]);
  });

  it('does not overlap matches', () => {
    expect(matchSegments('aaa', 'aa', true)).toEqual([
      { text: 'aa', hit: true },
      { text: 'a', hit: false },
    ]);
  });

  it('returns the text unmarked for an empty query', () => {
    expect(matchSegments('abc', '', false)).toEqual([
      { text: 'abc', hit: false },
    ]);
    expect(matchSegments('', '', false)).toEqual([]);
  });
});
