// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  childCount,
  childrenOf,
  errorOffsetFrom,
  kindOf,
  offsetToPosition,
  parseJsonForPreview,
} from './json';

describe('kindOf', () => {
  it('separates null from object, and array from object', () => {
    expect(kindOf(null)).toBe('null');
    expect(kindOf([])).toBe('array');
    expect(kindOf({})).toBe('object');
  });

  it('names the scalars', () => {
    expect(kindOf('a')).toBe('string');
    expect(kindOf(0)).toBe('number');
    expect(kindOf(false)).toBe('boolean');
  });
});

describe('childrenOf', () => {
  it('lists object entries in document order, keyed by name', () => {
    const node = { key: null, value: { b: 1, a: 2 } };
    expect(childrenOf(node)).toEqual([
      { key: 'b', value: 1 },
      { key: 'a', value: 2 },
    ]);
  });

  it('lists array elements keyed by index', () => {
    const node = { key: null, value: ['x', 'y'] };
    expect(childrenOf(node)).toEqual([
      { key: '0', value: 'x' },
      { key: '1', value: 'y' },
    ]);
  });

  it('returns nothing for scalars, empty containers and null', () => {
    expect(childrenOf({ key: null, value: 7 })).toEqual([]);
    expect(childrenOf({ key: null, value: null })).toEqual([]);
    expect(childrenOf({ key: null, value: {} })).toEqual([]);
    expect(childrenOf({ key: null, value: [] })).toEqual([]);
  });

  it('keeps nested containers as values rather than flattening them', () => {
    const node = { key: null, value: { outer: { inner: [1] } } };
    const kids = childrenOf(node);
    expect(kids).toHaveLength(1);
    expect(childrenOf(kids[0]!)).toEqual([{ key: 'inner', value: [1] }]);
  });
});

describe('childCount', () => {
  it('counts without building the children', () => {
    expect(childCount({ a: 1, b: 2 })).toBe(2);
    expect(childCount([1, 2, 3])).toBe(3);
    expect(childCount({})).toBe(0);
    expect(childCount([])).toBe(0);
    expect(childCount('abc')).toBe(0);
    expect(childCount(null)).toBe(0);
  });
});

describe('offsetToPosition', () => {
  it('is 1-based on the first line', () => {
    expect(offsetToPosition('abc', 0)).toEqual({ line: 1, column: 1 });
    expect(offsetToPosition('abc', 2)).toEqual({ line: 1, column: 3 });
  });

  it('counts lines from newlines', () => {
    expect(offsetToPosition('a\nbb\nccc', 2)).toEqual({ line: 2, column: 1 });
    expect(offsetToPosition('a\nbb\nccc', 5)).toEqual({ line: 3, column: 1 });
  });

  it('puts an offset at a line end on that line, not the next', () => {
    // Offset 1 is the newline itself: still line 1, one past 'a'.
    expect(offsetToPosition('a\nb', 1)).toEqual({ line: 1, column: 2 });
  });

  it('clamps an offset past the end to the last position', () => {
    expect(offsetToPosition('ab', 99)).toEqual({ line: 1, column: 3 });
    expect(offsetToPosition('a\nb', 99)).toEqual({ line: 2, column: 2 });
  });

  it('clamps a negative offset to the start', () => {
    expect(offsetToPosition('ab', -5)).toEqual({ line: 1, column: 1 });
  });
});

describe('errorOffsetFrom', () => {
  it('reads the offset V8 puts in the message', () => {
    expect(errorOffsetFrom('Unexpected token } in JSON at position 42')).toBe(
      42,
    );
  });

  it('returns null for a message without one, which is the WebKit case', () => {
    expect(errorOffsetFrom('JSON Parse error: Unexpected identifier "x"')).toBe(
      null,
    );
    expect(errorOffsetFrom('')).toBe(null);
  });
});

describe('parseJsonForPreview', () => {
  it('wraps a parsed document as the root node', () => {
    const result = parseJsonForPreview('{"a":[1,2]}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.root).toEqual({ key: null, value: { a: [1, 2] } });
    }
  });

  it('parses bare scalars, which are valid JSON documents', () => {
    const result = parseJsonForPreview('7');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.root.value).toBe(7);
    }
  });

  it('reports a syntax error as data instead of throwing', () => {
    const result = parseJsonForPreview('{ not json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toBe('');
    }
  });

  it('carries a position when the engine gave one and null when it did not', () => {
    const result = parseJsonForPreview('{\n  "a": ,\n}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const { position } = result.error;
      // Whether a position exists is engine-dependent (V8 yes, WebKit no), so
      // assert the contract rather than a number: present means it resolves to
      // a real line/column inside the text, absent means exactly null.
      if (position !== null) {
        expect(position.line).toBeGreaterThanOrEqual(1);
        expect(position.line).toBeLessThanOrEqual(3);
        expect(position.column).toBeGreaterThanOrEqual(1);
      } else {
        expect(position).toBe(null);
      }
    }
  });
});
