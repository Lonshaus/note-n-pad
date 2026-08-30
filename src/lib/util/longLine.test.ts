// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  beautifyJson,
  maxJsonDepth,
  MAX_BEAUTIFY_DEPTH,
  softWrapLongLines,
  SOFT_WRAP_LIMIT,
} from './longLine';

/** True when a string has no unpaired surrogate at either edge, i.e. no soft
 *  break cut a pair. */
function edgesArePaired(part: string): boolean {
  const first = part.charCodeAt(0);
  const last = part.charCodeAt(part.length - 1);
  const firstIsLow = first >= 0xdc00 && first <= 0xdfff;
  const lastIsHigh = last >= 0xd800 && last <= 0xdbff;
  return !firstIsLow && !lastIsHigh;
}

describe('softWrapLongLines', () => {
  it('breaks a single long line into pieces at the limit', () => {
    const line = 'a'.repeat(SOFT_WRAP_LIMIT * 2 + 3);
    const out = softWrapLongLines(line);
    const pieces = out.split('\n');
    expect(pieces).toHaveLength(3);
    expect(pieces[0]!.length).toBe(SOFT_WRAP_LIMIT);
    expect(pieces[1]!.length).toBe(SOFT_WRAP_LIMIT);
    expect(pieces[2]!.length).toBe(3);
    // Removing the inserted breaks reconstructs the original content.
    expect(out.replace(/\n/g, '')).toBe(line);
  });

  it('leaves short lines and existing structure untouched', () => {
    const text = 'one\ntwo\nthree';
    expect(softWrapLongLines(text)).toBe(text);
  });

  it('never splits a surrogate pair at a break point', () => {
    // A line of astral emoji (each a surrogate pair) with an odd limit so a
    // naive cut would land mid-pair.
    const line = '\u{1F600}'.repeat(200);
    const out = softWrapLongLines(line, 5);
    for (const piece of out.split('\n')) {
      expect(edgesArePaired(piece)).toBe(true);
      // Every code point is a full emoji: no lone surrogate survived.
      expect([...piece].every((cp) => cp === '\u{1F600}')).toBe(true);
    }
    expect(out.replace(/\n/g, '')).toBe(line);
  });

  it('handles CRLF-origin content, treating a lone CR as an ordinary char', () => {
    // split('\n') on CRLF text leaves a trailing \r on the first segment; it is
    // counted like any character and the segment still wraps by length.
    const long = 'x'.repeat(SOFT_WRAP_LIMIT + 1);
    const out = softWrapLongLines(`${long}\r\nyyy`);
    const pieces = out.split('\n');
    // First over-long segment (with its trailing \r) split into two; then "yyy".
    expect(pieces).toHaveLength(3);
    expect(pieces[0]!.length).toBe(SOFT_WRAP_LIMIT);
    expect(pieces[2]).toBe('yyy');
    // The carriage return is preserved, not dropped.
    expect(out).toContain('\r');
  });
});

describe('beautifyJson', () => {
  it('pretty-prints with a two-space indent', () => {
    expect(beautifyJson('{"a":1,"b":[2,3]}')).toBe(
      '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}',
    );
  });
  it('returns null for non-JSON', () => {
    expect(beautifyJson('['.repeat(100))).toBe(null);
  });
  it('refuses pathologically deep nesting instead of freezing', () => {
    // Valid, parseable JSON but nested far past the cap. On JavaScriptCore
    // JSON.stringify would build a multi-GB string; the depth guard returns
    // null first so the "format" option is simply not offered.
    const deep = '['.repeat(30000) + ']'.repeat(30000);
    expect(beautifyJson(deep)).toBe(null);
  });
});

describe('maxJsonDepth', () => {
  it('counts bracket/brace nesting depth', () => {
    expect(maxJsonDepth('[]')).toBe(1);
    expect(maxJsonDepth('[[[]]]')).toBe(3);
    expect(maxJsonDepth('{"a":{"b":[1]}}')).toBe(3);
    expect(maxJsonDepth('flat')).toBe(0);
  });
  it('ignores brackets inside string literals', () => {
    // The brackets live in a string value, so real depth is 1, not many.
    expect(maxJsonDepth('{"k":"[[[[[not nesting]]]]]"}')).toBe(1);
    // Escaped quote does not end the string early.
    expect(maxJsonDepth('["a\\"[[[b"]')).toBe(1);
  });
  it('stops early once the cap is exceeded', () => {
    const deep = '['.repeat(1000);
    expect(maxJsonDepth(deep, 500)).toBeGreaterThan(500);
    // A file at the cap is still allowed through.
    expect(maxJsonDepth('['.repeat(MAX_BEAUTIFY_DEPTH))).toBe(
      MAX_BEAUTIFY_DEPTH,
    );
  });
});
