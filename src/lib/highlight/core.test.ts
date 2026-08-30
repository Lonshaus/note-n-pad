// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { Parser, Tree } from '@lezer/common';
import { parser as jsParser } from '@lezer/javascript';
import { parser as jsonParser } from '@lezer/json';
import {
  HighlightSession,
  applyEditsToText,
  extractSpans,
  nextStopPos,
  reusableFragments,
  toChangedRanges,
} from './core';
import type { Edit } from './protocol';

/** A `now` that never advances, so a finite parse always finishes within one
 *  `advance` call regardless of the byte budget. */
const frozenNow = (): number => 0;

function fullParse(parser: Parser, doc: string): Tree {
  const session = new HighlightSession(parser, doc);
  const tree = session.advance(1000, frozenNow);
  expect(tree).not.toBeNull();
  return tree as Tree;
}

describe('nextStopPos', () => {
  it('targets the viewport end while it is unparsed', () => {
    expect(nextStopPos(0, 40, 200)).toBe(40);
    expect(nextStopPos(39, 40, 200)).toBe(40);
  });

  it('falls back to the full document once the viewport is covered', () => {
    expect(nextStopPos(40, 40, 200)).toBe(200);
    expect(nextStopPos(120, 40, 200)).toBe(200);
  });

  it('clamps a viewport that runs past the document', () => {
    expect(nextStopPos(0, 500, 200)).toBe(200);
  });
});

describe('extractSpans', () => {
  it('produces valid, in-order spans over a JSON document', () => {
    const doc = '{"a": 1, "b": [true, null]}';
    const tree = fullParse(jsonParser, doc);
    const spans = extractSpans(tree, 0, doc.length);
    expect(spans.length).toBeGreaterThan(0);
    let prev = -1;
    for (const span of spans) {
      expect(span.from).toBeGreaterThanOrEqual(0);
      expect(span.to).toBeLessThanOrEqual(doc.length);
      expect(span.from).toBeLessThan(span.to);
      expect(span.cls).toBeTruthy();
      expect(span.from).toBeGreaterThanOrEqual(prev);
      prev = span.from;
    }
  });

  it('clips spans to the requested window', () => {
    const doc = 'const answer = 12345;';
    const tree = fullParse(jsParser, doc);
    const from = 6;
    const to = 12;
    const spans = extractSpans(tree, from, to);
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(span.from).toBeGreaterThanOrEqual(from);
      expect(span.to).toBeLessThanOrEqual(to);
    }
  });
});

describe('applyEditsToText', () => {
  it('applies a sorted, non-overlapping edit batch', () => {
    // Replace "world" with "there" and delete the trailing "!".
    const doc = 'hello world!';
    const edits: Edit[] = [
      { from: 6, to: 11, insert: 'there' },
      { from: 11, to: 12, insert: '' },
    ];
    expect(applyEditsToText(doc, edits)).toBe('hello there');
  });

  it('handles pure insertion', () => {
    expect(applyEditsToText('ab', [{ from: 1, to: 1, insert: 'X' }])).toBe(
      'aXb',
    );
  });
});

describe('toChangedRanges', () => {
  it('maps edits into pre/post coordinate ranges with a running delta', () => {
    const edits: Edit[] = [
      { from: 2, to: 4, insert: 'XYZ' },
      { from: 8, to: 8, insert: 'Q' },
    ];
    expect(toChangedRanges(edits)).toEqual([
      { fromA: 2, toA: 4, fromB: 2, toB: 5 },
      { fromA: 8, toA: 8, fromB: 9, toB: 10 },
    ]);
  });
});

describe('HighlightSession', () => {
  it('aborts when cancelled before advancing', () => {
    const doc = 'function f(x) { return x + 1; }\n'.repeat(200);
    const session = new HighlightSession(jsParser, doc);
    session.cancel();
    expect(session.advance(1000, frozenNow)).toBeNull();
    expect(session.isCancelled).toBe(true);
    expect(session.tree).toBeNull();
  });

  it('stops at the viewport position when capped', () => {
    const doc = '{"a": 1, "b": 2, "c": 3, "d": 4}';
    const stopPos = 10;
    const session = new HighlightSession(jsParser, doc, [], stopPos);
    const tree = session.advance(1000, frozenNow);
    expect(tree).not.toBeNull();
    expect(session.parsedPos).toBeGreaterThanOrEqual(stopPos);
  });
});

describe('incremental reuse', () => {
  it('reparsing with reusable fragments matches a fresh parse', () => {
    const doc = 'const a = 1;\nfunction g() { return a * 2; }\n';
    const tree = fullParse(jsParser, doc);
    // Rename `a` to `total` at its declaration site.
    const edits: Edit[] = [{ from: 6, to: 7, insert: 'total' }];
    const edited = applyEditsToText(doc, edits);
    const fragments = reusableFragments(tree, edits);
    const session = new HighlightSession(jsParser, edited, fragments);
    const reparsed = session.advance(1000, frozenNow);
    expect(reparsed).not.toBeNull();
    const reuseSpans = extractSpans(reparsed as Tree, 0, edited.length);
    const freshSpans = extractSpans(
      fullParse(jsParser, edited),
      0,
      edited.length,
    );
    expect(reuseSpans).toEqual(freshSpans);
  });
});
