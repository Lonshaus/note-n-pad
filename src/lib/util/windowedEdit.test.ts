// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  applyBreaks,
  byteLength,
  byteToChar,
  charToByte,
  COALESCE_MS,
  decideNewGroup,
  detectBreakStyle,
  fullyVisibleLineSpan,
  mapChangesToEdits,
  nextWindow,
  rejectDuringSwap,
  replaceBreaks,
  scanBreaks,
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
    expect(mapChangesToEdits(0, 'abcd', [], '\n', changes)).toEqual([
      { start: 2, end: 2, text: 'X' },
    ]);
  });

  it('adds the window byte offset to every position', () => {
    const changes: RawChange[] = [{ fromA: 1, toA: 1, inserted: 'Z' }];
    expect(mapChangesToEdits(1000, 'abcd', [], '\n', changes)).toEqual([
      { start: 1001, end: 1001, text: 'Z' },
    ]);
  });

  it('maps a deletion as an empty-text byte range', () => {
    // Delete "bc" from "abcd": [1,3) removed.
    const changes: RawChange[] = [{ fromA: 1, toA: 3, inserted: '' }];
    expect(mapChangesToEdits(0, 'abcd', [], '\n', changes)).toEqual([
      { start: 1, end: 3, text: '' },
    ]);
  });

  it('maps a replacement with both a range and inserted text', () => {
    const changes: RawChange[] = [{ fromA: 1, toA: 3, inserted: 'YY' }];
    expect(mapChangesToEdits(0, 'abcd', [], '\n', changes)).toEqual([
      { start: 1, end: 3, text: 'YY' },
    ]);
  });

  it('measures positions in UTF-8 bytes, not chars', () => {
    // docBefore "aé日b": chars a(1) é(1) 日(1) b(1); bytes a=1, é=2, 日=3.
    // Insert "!" after "é" (char index 2) → byte prefix "aé" = 1 + 2 = 3.
    const changes: RawChange[] = [{ fromA: 2, toA: 2, inserted: '!' }];
    expect(mapChangesToEdits(0, 'aé日b', [], '\n', changes)).toEqual([
      { start: 3, end: 3, text: '!' },
    ]);
  });

  it('maps multiple changes in one transaction directly (pre-change coords)', () => {
    // Two ascending, non-overlapping changes against the same docBefore.
    const changes: RawChange[] = [
      { fromA: 1, toA: 2, inserted: 'X' },
      { fromA: 4, toA: 4, inserted: 'YY' },
    ];
    expect(mapChangesToEdits(10, 'abcde', [], '\n', changes)).toEqual([
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
    expect(mapChangesToEdits(100, '中😀xY', [], '\n', changes)).toEqual([
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

describe('byteToChar without CRLF', () => {
  it('maps ASCII bytes 1:1 to char indices', () => {
    expect(byteToChar('abcd', [], 0)).toBe(0);
    expect(byteToChar('abcd', [], 2)).toBe(2);
    expect(byteToChar('abcd', [], 4)).toBe(4);
  });

  it('clamps a non-positive offset to 0', () => {
    expect(byteToChar('abc', [], -5)).toBe(0);
  });

  it('counts multi-byte characters by their UTF-8 length', () => {
    // "é" = 2 bytes (1 code unit), "日" = 3 bytes (1 code unit).
    // Byte offset 2 sits right after "é": 1 char in.
    expect(byteToChar('éX', [], 2)).toBe(1);
    // "aé日": byte prefix "aé" = 1 + 2 = 3 bytes → 2 chars.
    expect(byteToChar('aé日b', [], 3)).toBe(2);
    // Full "aé日" = 6 bytes → 3 chars.
    expect(byteToChar('aé日b', [], 6)).toBe(3);
  });

  it('counts a surrogate pair as its two UTF-16 code units', () => {
    // "😀" is 4 UTF-8 bytes and 2 UTF-16 code units. Offset past it → 2.
    expect(byteToChar('😀x', [], 4)).toBe(2);
    // A "中"(3 bytes) before "😀": byte offset 3 → 1 char (中).
    expect(byteToChar('中😀', [], 3)).toBe(1);
    // Both = 7 bytes → 1 + 2 = 3 code units.
    expect(byteToChar('中😀', [], 7)).toBe(3);
  });

  it('rounds a mid-character offset up to the next boundary', () => {
    // Offset 1 lands inside the 2-byte "é"; rounds up to char 1.
    expect(byteToChar('éX', [], 1)).toBe(1);
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
/** CodeMirror's view of a raw window: every break is one `\n`. */
function normalize(raw: string): string {
  return raw.replace(/\r\n?/g, '\n');
}
/** Raw text from a normalized doc and its breaks. */
function join(doc: string, breaks: readonly string[]): string {
  const lines = doc.split('\n');
  let out = '';
  lines.forEach((line, i) => {
    out += line + (i < lines.length - 1 ? (breaks[i] ?? '\n') : '');
  });
  return out;
}
/** Independent position mapping: the raw string index of normalized position
 *  `pos`, walking the raw text one CodeMirror character at a time. */
function rawIndex(raw: string, pos: number): number {
  let i = 0;
  let n = 0;
  while (n < pos) {
    i += raw[i] === '\r' && raw[i + 1] === '\n' ? 2 : 1;
    n += 1;
  }
  return i;
}

const WINDOWS: Record<string, string> = {
  lf: 'alpha\nbeta\ngamma\ndelta\n',
  crlf: 'alpha\r\nbeta\r\ngamma\r\ndelta\r\n',
  mixed: 'alpha\r\nbeta\ngamma\rdelta\r\n\n\rlast',
  utf8: 'é日\r\n😀x\r\n\r\nend',
  noBreak: 'single line',
};

describe('scanBreaks', () => {
  it('lists the real separator of every break in order', () => {
    expect(scanBreaks('a\r\nb\nc\rd\r\n')).toEqual([
      '\r\n',
      '\n',
      '\r',
      '\r\n',
    ]);
    expect(scanBreaks('no break')).toEqual([]);
  });

  it('matches the number of line breaks CodeMirror splits on', () => {
    for (const raw of Object.values(WINDOWS)) {
      expect(scanBreaks(raw).length).toBe(
        normalize(raw).split('\n').length - 1,
      );
    }
  });
});

describe('charToByte / byteToChar', () => {
  it('round-trips every position of LF, CRLF, mixed and lone-CR windows', () => {
    for (const raw of Object.values(WINDOWS)) {
      const doc = normalize(raw);
      const breaks = scanBreaks(raw);
      for (let pos = 0; pos <= doc.length; pos += 1) {
        // Positions inside a surrogate pair are not valid cursor positions.
        const code = doc.charCodeAt(pos);
        if (code >= 0xdc00 && code <= 0xdfff) {
          continue;
        }
        const bytes = charToByte(doc, breaks, pos);
        expect(bytes).toBe(byteLength(raw.slice(0, rawIndex(raw, pos))));
        expect(byteToChar(doc, breaks, bytes)).toBe(pos);
      }
    }
  });

  it('counts both bytes of every CRLF before a position', () => {
    const raw = 'l1\r\nl2\r\nl3\r\n';
    const doc = normalize(raw);
    // Start of line 3: "l1\r\nl2\r\n" is 8 bytes, not the 6 chars of the doc.
    expect(charToByte(doc, scanBreaks(raw), 6)).toBe(8);
    expect(byteToChar(doc, scanBreaks(raw), 8)).toBe(6);
  });

  it('returns null for a byte offset strictly inside a CRLF', () => {
    const raw = 'ab\r\ncd';
    const doc = normalize(raw);
    expect(byteToChar(doc, scanBreaks(raw), 3)).toBeNull();
    expect(byteToChar(doc, scanBreaks(raw), 2)).toBe(2);
    expect(byteToChar(doc, scanBreaks(raw), 4)).toBe(3);
  });

  it('does not return null between a lone CR and a following LF', () => {
    // Two separate one-byte breaks: every offset maps to a position.
    const doc = 'a\n\nb';
    const breaks = ['\r', '\n'];
    expect(byteToChar(doc, breaks, 2)).toBe(2);
  });
});

describe('mapChangesToEdits with CRLF', () => {
  it('regression: typing at the start of line 3 lands at its byte offset', () => {
    // With CRLF every line is one byte longer than CodeMirror's text.
    const raw = 'line one\r\nline two\r\nline three\r\n';
    const doc = normalize(raw);
    const at = doc.indexOf('line three');
    const edits = mapChangesToEdits(0, doc, scanBreaks(raw), '\r\n', [
      { fromA: at, toA: at, inserted: 'QQ' },
    ]);
    expect(edits).toEqual([
      {
        start: raw.indexOf('line three'),
        end: raw.indexOf('line three'),
        text: 'QQ',
      },
    ]);
  });

  it('writes an inserted line break with the insert separator', () => {
    const doc = 'ab';
    expect(
      mapChangesToEdits(0, doc, [], '\r\n', [
        { fromA: 1, toA: 1, inserted: '\nx\n' },
      ]),
    ).toEqual([{ start: 1, end: 1, text: '\r\nx\r\n' }]);
    expect(
      mapChangesToEdits(0, doc, [], '\n', [
        { fromA: 1, toA: 1, inserted: '\n' },
      ]),
    ).toEqual([{ start: 1, end: 1, text: '\n' }]);
  });

  it('deleting a break removes every byte of its separator', () => {
    const raw = 'a\r\nb';
    const doc = normalize(raw);
    expect(
      mapChangesToEdits(10, doc, scanBreaks(raw), '\n', [
        { fromA: 1, toA: 2, inserted: '' },
      ]),
    ).toEqual([{ start: 11, end: 13, text: '' }]);
  });
});
/** Small deterministic PRNG so a failure is reproducible. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('byte edits against the raw window (random)', () => {
  const pieces = ['x', 'yz', '\n', 'a\nb', '\n\n', 'é', '日本', ' '];

  it('applying the edits to the raw bytes equals the doc joined with the updated breaks', () => {
    for (const [name, base] of Object.entries(WINDOWS)) {
      for (const sep of ['\n', '\r\n']) {
        const rand = rng(name.length * 7 + sep.length);
        let raw = base;
        for (let step = 0; step < 150; step += 1) {
          const doc = normalize(raw);
          const breaks = scanBreaks(raw);
          // 1-3 ascending, non-overlapping changes against the same doc.
          const cuts = Array.from({ length: 6 }, () =>
            Math.floor(rand() * (doc.length + 1)),
          ).sort((a, b) => a - b);
          const changes: RawChange[] = [];
          for (let c = 0; c + 1 < cuts.length && changes.length < 3; c += 2) {
            const fromA = cuts[c] as number;
            const toA = rand() < 0.5 ? fromA : (cuts[c + 1] as number);
            const inserted =
              rand() < 0.3
                ? ''
                : (pieces[Math.floor(rand() * pieces.length)] as string);
            changes.push({ fromA, toA, inserted });
          }
          // The generator can cut inside a surrogate pair; skip those draws.
          const bad = changes.some((c) =>
            [c.fromA, c.toA].some((p) => {
              const code = doc.charCodeAt(p);
              return code >= 0xdc00 && code <= 0xdfff;
            }),
          );
          if (bad) {
            continue;
          }
          const edits = mapChangesToEdits(5, doc, breaks, sep, changes);
          const bytes = new TextEncoder().encode(raw);
          let out = new Uint8Array(0);
          let cursor = 0;
          for (const e of edits) {
            out = new Uint8Array([
              ...out,
              ...bytes.slice(cursor, e.start - 5),
              ...new TextEncoder().encode(e.text),
            ]);
            cursor = e.end - 5;
          }
          out = new Uint8Array([...out, ...bytes.slice(cursor)]);
          // Expected, computed on the raw string by the independent walk.
          let expected = '';
          let from = 0;
          for (const c of changes) {
            expected +=
              raw.slice(from, rawIndex(raw, c.fromA)) +
              c.inserted.replaceAll('\n', sep);
            from = rawIndex(raw, c.toA);
          }
          expected += raw.slice(from);
          const got = new TextDecoder().decode(out);
          expect(got).toBe(expected);
          // And the updated break list reproduces the same bytes from the new doc.
          let newDoc = '';
          let p = 0;
          for (const c of changes) {
            newDoc += doc.slice(p, c.fromA) + c.inserted;
            p = c.toA;
          }
          newDoc += doc.slice(p);
          expect(join(newDoc, applyBreaks(doc, breaks, changes, sep))).toBe(
            expected,
          );
          raw = expected;
          if (raw.length > 400) {
            raw = base;
          }
        }
      }
    }
  });
});

describe('replaceBreaks', () => {
  it('swaps the breaks inside the replaced range for the inserted ones', () => {
    // doc "a\nb\nc", breaks CRLF, LF; replace "\nb\n" (1..4) with one CR break.
    expect(replaceBreaks('a\nb\nc', ['\r\n', '\n'], 1, 4, ['\r'])).toEqual([
      '\r',
    ]);
    expect(replaceBreaks('a\nb\nc', ['\r\n', '\n'], 3, 3, ['\r\n'])).toEqual([
      '\r\n',
      '\r\n',
      '\n',
    ]);
  });
});

describe('detectBreakStyle', () => {
  it('detects LF, CRLF and the majority of a mixed sample', () => {
    expect(detectBreakStyle('a\nb\n')).toEqual({
      lineEnding: 'LF',
      insert: '\n',
    });
    expect(detectBreakStyle('a\r\nb\r\n')).toEqual({
      lineEnding: 'CRLF',
      insert: '\r\n',
    });
    expect(detectBreakStyle('a\r\nb\r\nc\n')?.lineEnding).toBe('CRLF');
    expect(detectBreakStyle('a\r\nb\nc\n')?.lineEnding).toBe('LF');
  });

  it('treats a tie as LF and ignores lone CR', () => {
    expect(detectBreakStyle('a\r\nb\n')?.insert).toBe('\n');
    expect(detectBreakStyle('a\rb\r\nc\r')?.insert).toBe('\r\n');
  });

  it('returns null when the sample has no line break', () => {
    expect(detectBreakStyle('')).toBeNull();
    expect(detectBreakStyle('one line only')).toBeNull();
  });
});

describe('fullyVisibleLineSpan', () => {
  const blocks = [-10, 10, 30, 50, 70, 90].map((top, i) => ({
    from: i * 10,
    to: i * 10 + 9,
    top,
    bottom: top + 20,
  }));

  it('spans the lines fully inside the viewport', () => {
    expect(fullyVisibleLineSpan(blocks, 0, 100)).toEqual({ from: 10, to: 49 });
  });

  it('excludes a partially visible bottom line', () => {
    expect(fullyVisibleLineSpan(blocks, 0, 85)).toEqual({ from: 10, to: 39 });
  });

  it('excludes a partially visible top line', () => {
    expect(fullyVisibleLineSpan(blocks, 15, 100)).toEqual({ from: 20, to: 49 });
  });

  it('falls back to the first intersecting line', () => {
    expect(fullyVisibleLineSpan(blocks, 12, 28)).toEqual({ from: 10, to: 19 });
  });

  it('returns null for no blocks or blocks outside the viewport', () => {
    expect(fullyVisibleLineSpan([], 0, 100)).toBeNull();
    expect(fullyVisibleLineSpan(blocks, 200, 300)).toBeNull();
  });
});

describe('rejectDuringSwap', () => {
  it('rejects a user document change during a swap', () => {
    expect(rejectDuringSwap(true, true, 'input.type')).toBe(true);
  });

  it('accepts everything when not swapping', () => {
    expect(rejectDuringSwap(false, true, 'input.type')).toBe(false);
    expect(rejectDuringSwap(false, false, undefined)).toBe(false);
  });

  it('accepts a swap transaction that does not change the document', () => {
    expect(rejectDuringSwap(true, false, 'select')).toBe(false);
    expect(rejectDuringSwap(true, false, undefined)).toBe(false);
  });

  it('accepts our own document change without a userEvent', () => {
    expect(rejectDuringSwap(true, true, undefined)).toBe(false);
  });
});
