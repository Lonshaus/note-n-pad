// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { Annotation, EditorState, Transaction } from '@codemirror/state';
import {
  applyBreaks,
  byteLength,
  byteToChar,
  charToByte,
  COALESCE_MS,
  decideNewGroup,
  detectBreakStyle,
  dropSwapSelect,
  fullyVisibleLineSpan,
  fillBreaks,
  globalFilters,
  inApplyOrder,
  junctionRewrites,
  mapChangesToEdits,
  mapOffset,
  mapThrough,
  mirrorStep,
  nextWindow,
  rejectDuringSwap,
  replaceBreaks,
  scanBreaks,
  selectionFilters,
  swapTarget,
  SWAP_THRESHOLD_LINES,
  MARGIN_LINES,
  WINDOW_LINES,
  type ByteEdit,
  type GlobalFilterDeps,
  type RawChange,
  type SelectionFilterDeps,
} from './windowedEdit';
import type { LineSelection, SelectAllMode } from './windowSelection';

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

describe('swapTarget', () => {
  const TOTAL = 100_000;
  // The window `swapTarget` asks for, as `loadWindow` would load it.
  const swap = (top: number, bottom: number, start: number) => {
    const end = Math.min(TOTAL, start + WINDOW_LINES);
    const target = swapTarget(top, bottom, start, end, TOTAL);
    return target === null
      ? null
      : nextWindow(target, TOTAL, WINDOW_LINES, MARGIN_LINES);
  };
  // Whether a viewport in window `w` would swap again.
  const triggers = (
    top: number,
    bottom: number,
    w: { startLine: number; endLine: number },
  ) => swapTarget(top, bottom, w.startLine, w.endLine, TOTAL) !== null;

  it('stays put inside the window', () => {
    expect(swapTarget(50_700, 50_730, 50_000, 52_000, TOTAL)).toBeNull();
  });

  it('has no upward swap at the file start or downward swap at its end', () => {
    expect(swapTarget(10, 40, 0, 2000, TOTAL)).toBeNull();
    expect(swapTarget(99_960, 99_990, 98_000, TOTAL, TOTAL)).toBeNull();
  });

  it('never swaps a viewport too tall to clear both thresholds', () => {
    expect(swapTarget(50_100, 51_450, 50_000, 52_000, TOTAL)).toBeNull();
  });

  for (const h of [1, 30, 199, 250, 700, 1349]) {
    it(`leaves a ${h}-line viewport clear of both thresholds, going down`, () => {
      const start = 50_000;
      const bottom = start + WINDOW_LINES - SWAP_THRESHOLD_LINES + 10;
      const top = bottom - h;
      const w = swap(top, bottom, start);
      expect(w).not.toBeNull();
      expect(triggers(top, bottom, w!)).toBe(false);
      expect(w!.endLine - SWAP_THRESHOLD_LINES - bottom).toBe(1350 - h);
    });

    it(`leaves a ${h}-line viewport clear of both thresholds, going up`, () => {
      const start = 50_000;
      const top = start + SWAP_THRESHOLD_LINES - 10;
      const bottom = top + h;
      const w = swap(top, bottom, start);
      expect(w).not.toBeNull();
      expect(triggers(top, bottom, w!)).toBe(false);
      expect(top - (w!.startLine + SWAP_THRESHOLD_LINES)).toBe(1350 - h);
    });
  }

  it('cannot start a loop when the new window is clamped to a file end', () => {
    const up = swap(400, 430, 200);
    expect(up).toEqual({ startLine: 0, endLine: 2000 });
    expect(triggers(400, 430, up!)).toBe(false);
    const down = swap(99_700, 99_730, 97_900);
    expect(down).toEqual({ startLine: 98_000, endLine: TOTAL });
    expect(triggers(99_700, 99_730, down!)).toBe(false);
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

describe('dropSwapSelect', () => {
  it('drops a DOM selection sync during a swap', () => {
    expect(dropSwapSelect(true, false, 'select', false)).toBe(true);
  });

  it('keeps the selection syncs of a captured composition', () => {
    expect(dropSwapSelect(true, false, 'select', true)).toBe(false);
  });

  it('keeps everything when not swapping', () => {
    expect(dropSwapSelect(false, false, 'select', false)).toBe(false);
  });

  it('keeps a pointer selection, our own dispatch and a document change', () => {
    expect(dropSwapSelect(true, false, 'select.pointer', false)).toBe(false);
    expect(dropSwapSelect(true, false, undefined, false)).toBe(false);
    expect(dropSwapSelect(true, true, 'select', false)).toBe(false);
  });
});

describe('mapOffset', () => {
  const insert = { start: 10, end: 10, text: 'abc' };
  const remove = { start: 10, end: 14, text: '' };
  const replace = { start: 10, end: 14, text: 'xy' };
  it('leaves an offset before the edit alone', () => {
    expect(mapOffset(9, insert)).toBe(9);
    expect(mapOffset(9, remove)).toBe(9);
    expect(mapOffset(10, replace)).toBe(12);
    expect(mapOffset(0, replace)).toBe(0);
  });
  it('moves an offset at or after the end of an insertion by its length', () => {
    expect(mapOffset(10, insert)).toBe(13);
    expect(mapOffset(11, insert)).toBe(14);
  });
  it('moves an offset after a deletion or replacement by the length change', () => {
    expect(mapOffset(14, remove)).toBe(10);
    expect(mapOffset(20, remove)).toBe(16);
    expect(mapOffset(14, replace)).toBe(12);
    expect(mapOffset(20, replace)).toBe(18);
  });
  it('puts an offset inside the replaced range after the inserted text', () => {
    expect(mapOffset(12, remove)).toBe(10);
    expect(mapOffset(11, replace)).toBe(12);
    expect(mapOffset(13, { start: 10, end: 14, text: 'wxyz!' })).toBe(15);
  });
  it('counts the inserted text in bytes', () => {
    expect(mapOffset(30, { start: 10, end: 10, text: 'にほん' })).toBe(39);
    expect(mapOffset(11, { start: 10, end: 12, text: 'é' })).toBe(12);
  });
  it('shifts an old window offset by an edit made before the window', () => {
    // Window starts at byte 5000; the edit sits at the top of the file.
    expect(mapOffset(5000 + 120, { start: 3, end: 8, text: '' })).toBe(5115);
    expect(mapOffset(5000 + 120, { start: 3, end: 3, text: 'a\nb\n' })).toBe(
      5124,
    );
  });
});
// The same edit with its text written out: `len` stands for that many bytes.
const written = (e: ByteEdit): ByteEdit => {
  const { len, ...rest } = e;
  return len === undefined ? e : { ...rest, text: 'x'.repeat(len) };
};
describe('mapOffset with text put back from a spill file', () => {
  const spilled: ByteEdit[] = [
    { start: 10, end: 10, text: '', len: 5 },
    { start: 10, end: 14, text: '', len: 6 },
    { start: 10, end: 14, text: '', len: 2 },
    { start: 10, end: 11, text: '', len: 1, keep_start: true },
    { start: 10, end: 13, text: '', len: 3, keep_start: true },
  ];
  for (const edit of spilled) {
    it(`maps every offset like ${edit.len} bytes of text for ${edit.start}..${edit.end}`, () => {
      for (let offset = 0; offset <= 30; offset += 1) {
        expect(mapOffset(offset, edit)).toBe(mapOffset(offset, written(edit)));
      }
    });
  }
  it('moves an offset before, inside and after the change by the put-back length', () => {
    const edit: ByteEdit = { start: 10, end: 10, text: '', len: 5 };
    expect(mapOffset(9, edit)).toBe(9);
    expect(mapOffset(10, edit)).toBe(15);
    expect(mapOffset(40, edit)).toBe(45);
    const replace: ByteEdit = { start: 10, end: 14, text: '', len: 6 };
    expect(mapOffset(12, replace)).toBe(16);
    expect(mapOffset(14, replace)).toBe(16);
    expect(mapOffset(20, replace)).toBe(22);
  });
  it('keeps an offset at the start of a same-length keep_start edit', () => {
    const edit: ByteEdit = {
      start: 10,
      end: 11,
      text: '',
      len: 1,
      keep_start: true,
    };
    expect(mapOffset(10, edit)).toBe(10);
    expect(mapOffset(11, edit)).toBe(11);
  });
  it('is not confused by a len of zero', () => {
    expect(mapOffset(20, { start: 10, end: 14, text: 'abcd', len: 0 })).toBe(
      16,
    );
  });
});

describe('mapThrough', () => {
  it('applies the edits one after another, each in the frame the last left', () => {
    // Insert 4 at 0, then delete [10, 12) of the result.
    const edits = [
      { start: 0, end: 0, text: 'abcd' },
      { start: 10, end: 12, text: '' },
    ];
    expect(mapThrough(8, edits)).toBe(10);
    expect(mapThrough(20, edits)).toBe(22);
    expect(mapThrough(8, [])).toBe(8);
  });
  it('maps a queued offset through a mix of put-back and typed changes', () => {
    // A spill put back at 0 (8 bytes), a replacement with text, another put-back
    // inside the first, then typed text with a multi-byte character.
    const mixed: ByteEdit[] = [
      { start: 0, end: 0, text: '', len: 8 },
      { start: 20, end: 24, text: 'xy' },
      { start: 5, end: 5, text: '', len: 3 },
      { start: 40, end: 40, text: 'é' },
    ];
    expect(mapThrough(30, mixed)).toBe(30 + 8 - 2 + 3);
    expect(mapThrough(50, mixed)).toBe(50 + 8 - 2 + 3 + 2);
    for (const offset of [0, 3, 5, 12, 19, 20, 22, 24, 30, 39, 40, 50]) {
      expect(mapThrough(offset, mixed)).toBe(
        mapThrough(offset, mixed.map(written)),
      );
    }
  });
  it('keeps the end of line 11 through a three-line indent (lines 10 to 12)', () => {
    // Lines of 9 characters plus the break; indent each of lines 10..12 by 2.
    const lineStart = (n: number) => (n - 1) * 10;
    const endOfLine11 = lineStart(11) + 9;
    const indent = [12, 11, 10].map((n) => ({
      start: lineStart(n),
      end: lineStart(n),
      text: '  ',
    }));
    const ascending = [...indent].reverse();
    expect(inApplyOrder(ascending)).toEqual(indent);
    // Two indents sit before the end of line 11, so it moves by four.
    expect(mapThrough(endOfLine11, inApplyOrder(ascending))).toBe(
      endOfLine11 + 4,
    );
    // Mapping them in ascending order against one table would be wrong:
    // the second edit's start has moved by then.
    expect(mapThrough(endOfLine11, ascending)).not.toBe(endOfLine11 + 4);
  });
});

describe('the click conversion', () => {
  const cases: { name: string; raw: string }[] = [
    { name: 'LF', raw: 'one\ntwo\nthree' },
    { name: 'CRLF', raw: 'one\r\ntwo\r\nthree' },
    { name: 'a lone CR', raw: 'one\rtwo\nthree' },
    { name: 'multi-byte text', raw: 'にほん\nｋé\nthree' },
    { name: 'mixed breaks', raw: 'a\r\nb\rc\nd' },
  ];
  for (const { name, raw } of cases) {
    it(`goes to bytes and back to the same position for ${name}`, () => {
      const breaks = scanBreaks(raw);
      const doc = raw.replace(/\r\n|\r/g, '\n');
      let byte = 0;
      for (let pos = 0; pos <= doc.length; pos += 1) {
        if (doc[pos - 1] !== undefined && doc.codePointAt(pos - 1)! > 0xffff) {
          continue;
        }
        const offset = 5000 + charToByte(doc, breaks, pos);
        expect(offset).toBeGreaterThanOrEqual(5000 + byte);
        byte = offset - 5000;
        expect(byteToChar(doc, breaks, offset - 5000)).toBe(pos);
      }
    });
  }
  it('has no position for an offset between the CR and the LF of a break', () => {
    const raw = 'ab\r\ncd';
    expect(byteToChar('ab\ncd', scanBreaks(raw), 3)).toBeNull();
    expect(byteToChar('ab\ncd', scanBreaks(raw), 2)).toBe(2);
    expect(byteToChar('ab\ncd', scanBreaks(raw), 4)).toBe(3);
  });
});
// --- Junctions: a lone CR an edit would join to a LF ---------------------------
/** Every break of `text` (CRLF, LF or a lone CR) as one `\n`: the line rule. */
const byRule = (text: string): string => text.replace(/\r\n|\r|\n/g, '\n');
/** What a window holds: the file around it and the flags a read reports. */
interface Frame {
  prefix: string;
  raw: string;
  suffix: string;
}
const frameFlags = (f: Frame) => ({
  prevLoneCr: f.prefix.endsWith('\r'),
  nextIsLf: f.suffix.startsWith('\n'),
});
const changesOf = (doc: string, cuts: [number, number, string][]) =>
  cuts.map(([fromA, toA, inserted]) => ({ fromA, toA, inserted }));
/** The file after a batch of byte edits, as the Rust core applies them: edits
 *  in descending `(start, end)` order, then every LF rewrite that asks for a
 *  cascade takes the run of CR bytes before it. Rewrite bytes are tracked by
 *  tag. Returns the bytes. */
function coreApply(file: string, edits: ByteEdit[]): string {
  const enc = new TextEncoder();
  const bytes: [number, boolean][] = [...enc.encode(file)].map((b) => [
    b,
    false,
  ]);
  for (const e of inApplyOrder(edits)) {
    const tagged = e.cascade === true && e.text === '\n';
    bytes.splice(
      e.start,
      e.end - e.start,
      ...[...enc.encode(e.text)].map((b): [number, boolean] => [b, tagged]),
    );
  }
  for (let i = 0; i < bytes.length; i += 1) {
    if ((bytes[i] as [number, boolean])[1]) {
      let from = i;
      while (from > 0 && (bytes[from - 1] as [number, boolean])[0] === 13) {
        from -= 1;
      }
      for (let k = from; k < i; k += 1) {
        (bytes[k] as [number, boolean])[0] = 10;
      }
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes.map((b) => b[0])));
}
/** Run one change set through `junctionRewrites` the way `convertUpdate` does
 *  and apply it to `f`'s file; returns what the window and the file look like. */
function runJunction(
  f: Frame,
  changes: RawChange[],
  sep: string,
): {
  post: string;
  docAfter: string;
  res: ReturnType<typeof junctionRewrites>;
  start: number;
} {
  const enc = new TextEncoder();
  const start = enc.encode(f.prefix).length;
  const doc = byRule(f.raw);
  const breaks = scanBreaks(f.raw);
  const flags = frameFlags(f);
  const edits = mapChangesToEdits(start, doc, breaks, sep, changes);
  const res = junctionRewrites(
    doc,
    breaks,
    changes,
    sep,
    flags.prevLoneCr,
    flags.nextIsLf,
  );
  for (const r of res.rewrites) {
    edits.push({
      start: start + r.at,
      end: start + r.at + 1,
      text: sep,
      keep_start: true,
      cascade: true,
    });
  }
  let docAfter = '';
  let prev = 0;
  for (const c of changes) {
    docAfter += doc.slice(prev, c.fromA) + c.inserted;
    prev = c.toA;
  }
  docAfter += doc.slice(prev);
  return {
    post: coreApply(f.prefix + f.raw + f.suffix, edits),
    docAfter,
    res,
    start: start + res.startShift,
  };
}
/** The window after a change must read back from the file as the editor
 *  expects it, and no line may have been lost to a CRLF. */
function expectConsistent(f: Frame, changes: RawChange[], sep: string): void {
  const { post, docAfter, res, start } = runJunction(f, changes, sep);
  expect(byRule(post)).toBe(byRule(f.prefix) + docAfter + byRule(f.suffix));
  // The window's bytes are where the geometry says, with the breaks it keeps.
  const enc = new TextEncoder();
  const end = start + charToByte(docAfter, res.breaksAfter, docAfter.length);
  const window = new TextDecoder().decode(enc.encode(post).slice(start, end));
  expect(scanBreaks(window)).toEqual(res.breaksAfter);
  expect(byRule(window)).toBe(docAfter);
  const before = post.slice(
    0,
    new TextEncoder().encode(post).slice(0, start).length,
  );
  void before;
  const byteBefore = start > 0 ? enc.encode(post)[start - 1] : undefined;
  expect(res.prevLoneCr).toBe(byteBefore === 13);
}

describe('junctionRewrites', () => {
  const none = (f: Frame, changes: RawChange[], sep: string) =>
    runJunction(f, changes, sep).res.rewrites;

  it('J1: Enter at the line start after a lone CR rewrites that CR (LF style)', () => {
    const f: Frame = { prefix: '', raw: 'x\ry', suffix: '' };
    // CodeMirror holds `x\ny`; Enter at the start of `y` is position 2.
    const res = junctionRewrites(
      'x\ny',
      ['\r'],
      [{ fromA: 2, toA: 2, inserted: '\n' }],
      '\n',
      false,
      false,
    );
    expect(res.rewrites).toEqual([{ at: 1, whereBefore: 'inside' }]);
    expect(res.breaksAfter).toEqual(['\n', '\n']);
    expect(res.startShift).toBe(0);
    expectConsistent(f, [{ fromA: 2, toA: 2, inserted: '\n' }], '\n');
    // CRLF style: the typed break starts with a CR, so nothing joins.
    expect(none(f, [{ fromA: 2, toA: 2, inserted: '\n' }], '\r\n')).toEqual([]);
    expectConsistent(f, [{ fromA: 2, toA: 2, inserted: '\n' }], '\r\n');
  });

  it('J2: deleting a line between a lone CR and an LF rewrites the CR, in both styles', () => {
    const f: Frame = { prefix: 'p\n', raw: 'x\rmid\nt', suffix: '' };
    // `mid` is doc positions 2..5.
    const del = [{ fromA: 2, toA: 5, inserted: '' }];
    for (const sep of ['\n', '\r\n']) {
      const rewrites = none(f, del, sep);
      expect(rewrites).toEqual([{ at: 1, whereBefore: 'inside' }]);
      expectConsistent(f, del, sep);
    }
    const lf = junctionRewrites(
      'x\nmid\nt',
      ['\r', '\n'],
      del,
      '\n',
      false,
      false,
    );
    expect(lf.breaksAfter).toEqual(['\n', '\n']);
    const crlf = junctionRewrites(
      'x\nmid\nt',
      ['\r', '\n'],
      del,
      '\r\n',
      false,
      false,
    );
    expect(crlf.breaksAfter).toEqual(['\r\n', '\n']);
  });

  it('J3: at the first position, the CR is the byte before the window', () => {
    // Window `\nrest` (an empty first line) after a lone CR is impossible to
    // read, so the window opens on `a\nb`; deleting `a` leaves a `\n` first.
    const f: Frame = { prefix: 'q\r', raw: 'a\nb', suffix: '' };
    const del = [{ fromA: 0, toA: 1, inserted: '' }];
    for (const sep of ['\n', '\r\n']) {
      const out = junctionRewrites('a\nb', ['\n'], del, sep, true, false);
      expect(out.rewrites).toEqual([{ at: -1, whereBefore: 'before' }]);
      expect(out.startShift).toBe(sep.length - 1);
      expect(out.prevLoneCr).toBe(false);
      expectConsistent(f, del, sep);
    }
    // Enter at the window's first position joins the CR before it too.
    const enter = [{ fromA: 0, toA: 0, inserted: '\n' }];
    for (const sep of ['\n']) {
      expect(none(f, enter, sep)).toEqual([{ at: -1, whereBefore: 'before' }]);
      expectConsistent(f, enter, sep);
    }
    expect(none(f, enter, '\r\n')).toEqual([]);
  });

  it('J4: deleting down to a lone CR at the window end, with an LF after it', () => {
    const f: Frame = { prefix: '', raw: 'a\rb\n', suffix: '\nz' };
    const del = [{ fromA: 2, toA: 4, inserted: '' }];
    for (const sep of ['\n', '\r\n']) {
      expect(none(f, del, sep)).toEqual([{ at: 1, whereBefore: 'inside' }]);
      expectConsistent(f, del, sep);
    }
    // No LF after the window: nothing joins.
    expect(none({ ...f, suffix: 'z' }, del, '\n')).toEqual([]);
  });

  it('J5: the whole window deleted between a lone CR and an LF', () => {
    const f: Frame = { prefix: 'q\r', raw: 'a\nb\n', suffix: '\nz' };
    const del = [{ fromA: 0, toA: 4, inserted: '' }];
    for (const sep of ['\n', '\r\n']) {
      const out = junctionRewrites(
        'a\nb\n',
        ['\n', '\n'],
        del,
        sep,
        true,
        true,
      );
      expect(out.rewrites).toEqual([{ at: -1, whereBefore: 'before' }]);
      expect(out.startShift).toBe(sep.length - 1);
      expectConsistent(f, del, sep);
    }
    expect(none({ ...f, suffix: 'z' }, del, '\n')).toEqual([]);
    expect(none({ ...f, prefix: 'q\n' }, del, '\n')).toEqual([]);
  });

  it('covers every combination of where the CR and the LF are', () => {
    // CR inside or before the window, LF inside or after it.
    const cases: { f: Frame; changes: RawChange[]; at: number[] }[] = [
      // CR inside, LF inside.
      {
        f: { prefix: '', raw: 'a\rb\nc', suffix: '' },
        changes: [{ fromA: 2, toA: 3, inserted: '' }],
        at: [1],
      },
      // CR before, LF inside.
      {
        f: { prefix: 'z\r', raw: 'b\nc', suffix: '' },
        changes: [{ fromA: 0, toA: 1, inserted: '' }],
        at: [-1],
      },
      // CR inside, LF after.
      {
        f: { prefix: '', raw: 'a\rb\n', suffix: '\nc' },
        changes: [{ fromA: 2, toA: 4, inserted: '' }],
        at: [1],
      },
      // CR before, LF after.
      {
        f: { prefix: 'z\r', raw: 'b\n', suffix: '\nc' },
        changes: [{ fromA: 0, toA: 2, inserted: '' }],
        at: [-1],
      },
    ];
    for (const { f, changes, at } of cases) {
      for (const sep of ['\n', '\r\n']) {
        expect(none(f, changes, sep).map((r) => r.at)).toEqual(at);
        expectConsistent(f, changes, sep);
      }
    }
  });

  it('leaves alone a CR that is half of a CRLF, one followed by something else, and CRLF-style J1', () => {
    // `\r\n` is one break, deleting around it joins nothing new.
    const crlf: Frame = { prefix: '', raw: 'a\r\nb\nc', suffix: '' };
    expect(none(crlf, [{ fromA: 2, toA: 3, inserted: '' }], '\n')).toEqual([]);
    expectConsistent(crlf, [{ fromA: 2, toA: 3, inserted: '' }], '\n');
    // A lone CR whose next line stays non-empty.
    const other: Frame = { prefix: '', raw: 'a\rbc\nd', suffix: '' };
    expect(none(other, [{ fromA: 3, toA: 4, inserted: '' }], '\n')).toEqual([]);
    // A lone CR followed by a CRLF line.
    const next: Frame = { prefix: '', raw: 'a\rmid\r\nd', suffix: '' };
    expect(none(next, [{ fromA: 2, toA: 5, inserted: '' }], '\n')).toEqual([]);
    expectConsistent(next, [{ fromA: 2, toA: 5, inserted: '' }], '\n');
  });

  it('A16: the run of CR before a rewrite is marked in the window (length 1, 2, 3)', () => {
    for (const run of [1, 2, 3]) {
      const raw = 'x' + '\r'.repeat(run) + 'tail';
      const f: Frame = { prefix: '', raw, suffix: '' };
      const at = 1 + run;
      const enter = [{ fromA: at, toA: at, inserted: '\n' }];
      const res = junctionRewrites(
        byRule(raw),
        scanBreaks(raw),
        enter,
        '\n',
        false,
        false,
      );
      expect(res.rewrites).toEqual([{ at: run, whereBefore: 'inside' }]);
      expect(res.breaksAfter).toEqual(Array(run + 1).fill('\n'));
      expectConsistent(f, enter, '\n');
      // CRLF style: Enter starts with a CR, so nothing joins at all; the
      // deleting form rewrites the last CR only.
      const del = [{ fromA: at, toA: at + 4, inserted: '' }];
      const raw2 = raw + '\nend';
      const f2: Frame = { prefix: '', raw: raw2, suffix: '' };
      const crlf = junctionRewrites(
        byRule(raw2),
        scanBreaks(raw2),
        del,
        '\r\n',
        false,
        false,
      );
      expect(crlf.rewrites).toEqual([{ at: run, whereBefore: 'inside' }]);
      expect(crlf.breaksAfter).toEqual(
        [...Array(run - 1).fill('\r'), '\r\n', '\n'].slice(0, run + 1),
      );
      expectConsistent(f2, del, '\r\n');
    }
  });

  it('A16: a run that reaches the window start clears prevLoneCr, so Enter there rewrites nothing', () => {
    // File `\r` before the window, then a window of `\r\r` and a line: the
    // run is the window's two breaks and the byte before it.
    const f: Frame = { prefix: 'q\r', raw: '\r\rtail', suffix: '' };
    const enter = [{ fromA: 2, toA: 2, inserted: '\n' }];
    const res = junctionRewrites(
      byRule(f.raw),
      scanBreaks(f.raw),
      enter,
      '\n',
      true,
      false,
    );
    expect(res.rewrites).toEqual([{ at: 1, whereBefore: 'inside' }]);
    expect(res.prevLoneCr).toBe(false);
    expectConsistent(f, enter, '\n');
    // The core rewrote the byte before the window as part of the run, so the
    // next Enter at the window's first position joins nothing.
    const again = junctionRewrites(
      byRule('\n\n\ntail'),
      res.breaksAfter,
      [{ fromA: 0, toA: 0, inserted: '\n' }],
      '\n',
      res.prevLoneCr,
      false,
    );
    expect(again.rewrites).toEqual([]);
  });

  it('A10: random windows and changes never lose a line to a CRLF, and the geometry reads back', () => {
    const rand = rng(20261023);
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    const prefixes = [
      '',
      'ab\n',
      'ab\r',
      'x\r\r',
      '\n',
      'a\r\r\r',
      'q\r\n',
      '\r',
      '\r\r\r\r',
    ];
    const suffixes = ['', '\nq', 'q', '\n\n', '\r', 'qq\n', '\n', '\r\nq'];
    const lineTexts = ['', 'x', 'yz', 'é', ''];
    const breaksPool = ['\n', '\r\n', '\r', '\r', '\n'];
    const inserts = ['x', '\n', '\n\n', 'é\n', 'ab', '\nz'];
    let junctions = 0;
    let runs = 0;
    for (let n = 0; n < 4000; n += 1) {
      const prefix = pick(prefixes);
      const suffix = pick(suffixes);
      let raw = '';
      for (let i = Math.floor(rand() * 6) + 1; i > 0; i -= 1) {
        raw += pick(lineTexts) + pick(breaksPool);
      }
      if (suffix === '') {
        raw = rand() < 0.5 ? raw : raw.replace(/(\r\n|\r|\n)$/, '');
      }
      // The window opens on a line start and closes on a line end.
      if (prefix.endsWith('\r') && raw.startsWith('\n')) {
        raw = 'k' + raw;
      }
      if (suffix.startsWith('\n') && raw.endsWith('\r')) {
        raw = raw.slice(0, -1) + '\n';
      }
      const f: Frame = { prefix, raw, suffix };
      const doc = byRule(raw);
      for (const sep of ['\n', '\r\n']) {
        // One to three ascending, non-overlapping changes.
        const cuts = Array.from({ length: 6 }, () =>
          Math.floor(rand() * (doc.length + 1)),
        ).sort((a, b) => a - b);
        const changes: RawChange[] = [];
        for (let c = 0; c + 1 < cuts.length && changes.length < 3; c += 2) {
          const fromA = cuts[c] as number;
          const toA = rand() < 0.4 ? fromA : (cuts[c + 1] as number);
          // CodeMirror merges changes that touch; its change sets never do.
          const last = changes[changes.length - 1];
          if (last !== undefined && fromA <= last.toA) {
            continue;
          }
          changes.push({
            fromA,
            toA,
            inserted: rand() < 0.5 ? '' : pick(inserts),
          });
        }
        const out = runJunction(f, changes, sep);
        junctions += out.res.rewrites.length;
        if (
          sep === '\n' &&
          out.res.rewrites.some((r) => r.whereBefore === 'inside') &&
          /\r\r/.test(raw)
        ) {
          runs += 1;
        }
        try {
          expectConsistent(f, changes, sep);
        } catch (e) {
          throw new Error(
            JSON.stringify({ f, changes, sep }) + ' ' + String(e),
          );
        }
      }
    }
    // The draws reach both kinds of junction and runs of CR.
    expect(junctions).toBeGreaterThan(100);
    expect(runs).toBeGreaterThan(5);
  });
});

describe('the rewrite edits in the map and the order of an apply', () => {
  it('keep_start holds an offset at the start of the edit, other offsets behave as before', () => {
    const rewrite = { start: 10, end: 11, text: '\n', keep_start: true };
    // Same length: nothing moves, whatever side.
    expect(mapOffset(10, rewrite)).toBe(10);
    expect(mapOffset(11, rewrite)).toBe(11);
    expect(mapOffset(30, rewrite)).toBe(30);
    expect(mapOffset(9, rewrite)).toBe(9);
    // Without the flag an offset at the start of a replacement goes after it.
    expect(mapOffset(10, { start: 10, end: 11, text: '\n' })).toBe(11);
    // A CRLF rewrite is one byte longer: the start stays, later offsets shift.
    const crlf = { start: 10, end: 11, text: '\r\n', keep_start: true };
    expect(mapOffset(10, crlf)).toBe(10);
    expect(mapOffset(11, crlf)).toBe(12);
    // The undo of it: two bytes back to one.
    const undo = { start: 10, end: 12, text: '\r', keep_start: true };
    expect(mapOffset(10, undo)).toBe(10);
    expect(mapOffset(11, undo)).toBe(11);
    expect(mapOffset(12, undo)).toBe(11);
    // A fill edit changes no length at all.
    const fill = { start: 4, end: 9, text: '', fill: '\r' };
    for (const o of [0, 4, 6, 9, 20]) {
      expect(mapOffset(o, fill)).toBe(o);
    }
  });

  it('an insertion at the start of a rewrite is applied after it and lands before it', () => {
    const ins = { start: 5, end: 5, text: 'b' };
    const rewrite = {
      start: 5,
      end: 6,
      text: '\n',
      keep_start: true,
      cascade: true,
    };
    const gone = { start: 6, end: 7, text: '' };
    expect(inApplyOrder([ins, gone, rewrite])).toEqual([gone, rewrite, ins]);
    expect(inApplyOrder([rewrite, ins])).toEqual([rewrite, ins]);
    // An offset at 5 (the caret before the rewritten byte) ends after the text
    // inserted there, and an offset after the deleted byte follows both.
    const order = inApplyOrder([ins, gone, rewrite]);
    expect(mapThrough(5, order)).toBe(6);
    expect(mapThrough(7, order)).toBe(7);
    expect(mapThrough(8, order)).toBe(8);
  });
});

describe('mirroring the core fill edits', () => {
  // The A12 case, as the core sends it: `x\r\r\ry` with an LF typed before `y`.
  const undoJson = JSON.parse(
    '[{"start":1,"end":3,"text":"","keep_start":false,"fill":"\\r"},' +
      '{"start":4,"end":5,"text":"","keep_start":false,"fill":null},' +
      '{"start":3,"end":4,"text":"\\r","keep_start":true,"fill":null}]',
  ) as ByteEdit[];
  const redoJson = JSON.parse(
    '[{"start":3,"end":4,"text":"\\n","keep_start":true,"fill":null},' +
      '{"start":4,"end":4,"text":"\\n","keep_start":false,"fill":null},' +
      '{"start":1,"end":3,"text":"","keep_start":false,"fill":"\\n"}]',
  ) as ByteEdit[];
  /** Mirror `edits` into a window the way the editor does, one step at a time. */
  function mirror(raw: string, edits: ByteEdit[], windowStart = 0) {
    let doc = byRule(raw);
    let breaks: string[] = scanBreaks(raw);
    for (const e of edits) {
      const step = mirrorStep(doc, breaks, windowStart, e);
      expect(step).not.toBeNull();
      if (step === null) {
        break;
      }
      if (step.change !== null) {
        doc =
          doc.slice(0, step.change.from) +
          byRule(step.change.insert) +
          doc.slice(step.change.to);
      }
      breaks = step.breaks;
    }
    return { doc, breaks };
  }

  it('the window breaks follow the core bytes after an undo and after a redo', () => {
    const typed = 'x\n\n\n\ny';
    const afterUndo = mirror(typed, undoJson);
    expect(afterUndo.doc).toBe('x\n\n\ny');
    expect(afterUndo.breaks).toEqual(scanBreaks('x\r\r\ry'));
    const afterRedo = mirror('x\r\r\ry', redoJson);
    expect(afterRedo.doc).toBe('x\n\n\n\ny');
    expect(afterRedo.breaks).toEqual(scanBreaks(typed));
  });

  it('fillBreaks sets only the breaks whose bytes lie in the range', () => {
    const doc = 'a\n\nb\n';
    expect(fillBreaks(doc, ['\r', '\r', '\n'], 1, 3, '\n')).toEqual([
      '\n',
      '\n',
      '\n',
    ]);
    expect(fillBreaks(doc, ['\r', '\r', '\n'], 2, 3, '\n')).toEqual([
      '\r',
      '\n',
      '\n',
    ]);
    expect(fillBreaks(doc, ['\r', '\r', '\n'], 0, 1, '\n')).toEqual([
      '\r',
      '\r',
      '\n',
    ]);
  });

  it('an edit boundary inside a CRLF has no document position', () => {
    expect(
      mirrorStep('a\nb', ['\r\n'], 0, { start: 2, end: 2, text: 'x' }),
    ).toBeNull();
    expect(
      mirrorStep('a\nb', ['\r\n'], 0, { start: 1, end: 3, text: '\r' }),
    ).not.toBeNull();
  });
});

describe('selectionFilters', () => {
  const DOC = 'line\n'.repeat(99) + 'line';
  function setup(over: Partial<SelectionFilterDeps> = {}) {
    const request = vi.fn();
    const deps: SelectionFilterDeps = {
      swapping: () => false,
      keep: () => false,
      mode: () => 'file' as SelectAllMode,
      keyActive: () => false,
      viewport: () => ({ from: 0, to: DOC.length }),
      request,
      ...over,
    };
    const state = EditorState.create({
      doc: DOC,
      extensions: selectionFilters(deps),
    });
    return { state, request };
  }
  const selectAll = (state: EditorState) =>
    state.update({
      selection: { anchor: 0, head: state.doc.length },
      userEvent: 'select',
    });

  it('notes a native select-all once and lets the transaction pass', () => {
    const { state, request } = setup();
    const tr = selectAll(state);
    expect(request).toHaveBeenCalledTimes(1);
    expect(tr.selection?.main.to).toBe(DOC.length);
  });
  it('notes it during a swap, while the swap still empties the transaction', () => {
    const { state, request } = setup({ swapping: () => true });
    const tr = selectAll(state);
    expect(request).toHaveBeenCalledTimes(1);
    expect(tr.selection).toBeUndefined();
    expect(tr.newSelection.main.to).toBe(0);
  });
  it('keeps the selection of a composition captured in a swap', () => {
    const { state, request } = setup({
      swapping: () => true,
      keep: () => true,
    });
    const tr = selectAll(state);
    expect(request).toHaveBeenCalledTimes(1);
    expect(tr.newSelection.main.to).toBe(DOC.length);
  });
  it('drops a DOM selection sync in a swap and not outside one', () => {
    const sync = (state: EditorState) =>
      state.update({
        selection: { anchor: 3 },
        userEvent: 'select',
      });
    const during = setup({ swapping: () => true });
    expect(sync(during.state).newSelection.main.head).toBe(0);
    const idle = setup();
    expect(sync(idle.state).newSelection.main.head).toBe(3);
  });
  it('does not note a pointer selection or one a key command made', () => {
    const pointer = setup();
    pointer.state.update({
      selection: { anchor: 0, head: DOC.length },
      userEvent: 'select.pointer',
    });
    expect(pointer.request).not.toHaveBeenCalled();
    const key = setup({ keyActive: () => true });
    selectAll(key.state);
    expect(key.request).not.toHaveBeenCalled();
  });
  it('does not note a selection that leaves part of the range out', () => {
    const { state, request } = setup();
    state.update({
      selection: { anchor: 0, head: DOC.length - 1 },
      userEvent: 'select',
    });
    expect(request).not.toHaveBeenCalled();
  });
  it('does not note a change of the document', () => {
    const { state, request } = setup();
    state.update({
      changes: { from: 0, insert: 'x' },
      selection: { anchor: 0, head: DOC.length },
      userEvent: 'select',
    });
    expect(request).not.toHaveBeenCalled();
  });
  it('does not note it under the "visible" setting', () => {
    const { state, request } = setup({ mode: () => 'visible' });
    selectAll(state);
    expect(request).not.toHaveBeenCalled();
  });
  it('does not note a selection that is already there', () => {
    const request = vi.fn();
    const state = EditorState.create({
      doc: DOC,
      selection: { anchor: 0, head: DOC.length },
      extensions: selectionFilters({
        swapping: () => false,
        keep: () => false,
        mode: () => 'file',
        keyActive: () => false,
        viewport: () => ({ from: 0, to: DOC.length }),
        request,
      }),
    });
    state.update({
      selection: { anchor: 0, head: DOC.length },
      userEvent: 'select',
    });
    expect(request).not.toHaveBeenCalled();
  });
  it('does nothing without a view to read the range from', () => {
    const { state, request } = setup({ viewport: () => null });
    selectAll(state);
    expect(request).not.toHaveBeenCalled();
  });
  it('leaves a transaction without a user event alone', () => {
    const { state } = setup({ swapping: () => true });
    const tr = state.update({ selection: { anchor: 5 } });
    expect(tr.newSelection.main.head).toBe(5);
    expect(tr.annotation(Transaction.userEvent)).toBeUndefined();
  });
});

describe('globalFilters', () => {
  interface Key {
    chord: boolean;
    bound: boolean;
  }
  const LARGE: LineSelection = {
    anchor: { line: 0, col: 0 },
    head: { line: 5000, col: 0 },
  };
  const SMALL: LineSelection = {
    anchor: { line: 10, col: 0 },
    head: { line: 12, col: 0 },
  };
  const exemptMark = Annotation.define<boolean>();
  const DOC = 'hello world';
  function setup(over: Partial<GlobalFilterDeps<Key>> = {}) {
    const text: string[] = [];
    const keys: Key[] = [];
    const deps: GlobalFilterDeps<Key> = {
      swapping: () => false,
      locked: () => false,
      holds: () => 0,
      capturing: () => false,
      pendingIme: () => false,
      late: () => false,
      replayPending: () => false,
      draining: () => false,
      keyActive: () => false,
      keydown: () => undefined,
      globalSel: () => LARGE,
      outside: () => true,
      exempt: (tr) => tr.annotation(exemptMark) === true,
      captureMark: (tr) => tr.annotation(exemptMark) === true,
      chord: (e) => e.chord,
      bound: (e) => e.bound,
      defer: (run) => run(),
      queueText: (t) => text.push(t),
      queueKey: (e) => keys.push(e),
      ...over,
    };
    const state = EditorState.create({
      doc: DOC,
      selection: { anchor: 0, head: 5 },
      extensions: globalFilters(deps),
    });
    return { state, text, keys };
  }
  const typed = (state: EditorState, userEvent: string): Transaction =>
    state.update({
      changes: { from: 5, insert: 'X' },
      userEvent,
    });

  describe('under a selection too large for one window', () => {
    it('refuses a deleted line', () => {
      const { state, text, keys } = setup();
      const tr = state.update({
        changes: { from: 0, to: DOC.length },
        userEvent: 'delete.line',
      });
      expect(tr.docChanged).toBe(false);
      expect(text).toEqual([]);
      expect(keys).toEqual([]);
    });

    it('accepts the text of a composition a capture covers', () => {
      const { state, text } = setup({ capturing: () => true });
      const tr = typed(state, 'input.type.compose');
      expect(tr.docChanged).toBe(true);
      expect(text).toEqual([]);
    });

    it('queues text that came with no keydown once, and refuses its transaction', () => {
      const { state, text } = setup();
      const tr = typed(state, 'input.type');
      expect(tr.docChanged).toBe(false);
      expect(text).toEqual(['X']);
    });

    it('queues text only after the filter, never inside it', () => {
      const later: (() => void)[] = [];
      const { state, text } = setup({ defer: (run) => later.push(run) });
      typed(state, 'input.type');
      expect(text).toEqual([]);
      expect(later).toHaveLength(1);
      later[0]?.();
      expect(text).toEqual(['X']);
    });

    it('defers the late text of a composition too, while a swap runs', () => {
      const later: (() => void)[] = [];
      const { state, text } = setup({
        swapping: () => true,
        replayPending: () => true,
        late: () => true,
        defer: (run) => later.push(run),
      });
      typed(state, 'input.type.compose');
      expect(text).toEqual([]);
      expect(later).toHaveLength(1);
      later[0]?.();
      expect(text).toEqual(['X']);
    });

    it('queues the text of a composition no capture covers when it comes late', () => {
      const { state, text } = setup({ late: () => true });
      const tr = typed(state, 'input.type.compose');
      expect(tr.docChanged).toBe(false);
      expect(text).toEqual(['X']);
    });

    it('queues the late text of a composition once while a swap runs', () => {
      const { state, text } = setup({
        swapping: () => true,
        replayPending: () => true,
        late: () => true,
      });
      const tr = typed(state, 'input.type.compose');
      expect(tr.docChanged).toBe(false);
      expect(text).toEqual(['X']);
    });

    it('queues the text typed while a swap runs behind the queue and refuses it', () => {
      const { state, text } = setup({
        swapping: () => true,
        replayPending: () => true,
      });
      const tr = typed(state, 'input.type');
      expect(tr.docChanged).toBe(false);
      expect(text).toEqual([]);
    });

    it('queues the key of a refused chord that moves the selection', () => {
      const e: Key = { chord: true, bound: true };
      const { state, keys } = setup({
        keyActive: () => true,
        keydown: () => e,
      });
      const tr = state.update({
        selection: { anchor: 3 },
        userEvent: 'select',
      });
      expect(tr.newSelection.main.head).toBe(5);
      expect(keys).toEqual([e]);
    });

    it('queues the key of Escape, which is no chord', () => {
      const e: Key = { chord: false, bound: true };
      const { state, keys } = setup({
        keyActive: () => true,
        keydown: () => e,
        replayPending: () => true,
      });
      state.update({ selection: { anchor: 5 }, userEvent: 'select' });
      expect(keys).toEqual([e]);
    });

    it('leaves a key no binding answers', () => {
      const e: Key = { chord: false, bound: false };
      const { state, keys } = setup({
        keyActive: () => true,
        keydown: () => e,
      });
      state.update({ selection: { anchor: 3 }, userEvent: 'select' });
      expect(keys).toEqual([]);
    });

    it('does not refuse a transaction an exempt mark covers', () => {
      const { state } = setup();
      const tr = state.update({
        changes: { from: 0, to: 5 },
        annotations: exemptMark.of(true),
      });
      expect(tr.docChanged).toBe(true);
      const sel = state.update({
        selection: { anchor: 2, head: 9 },
        userEvent: 'select',
        annotations: exemptMark.of(true),
      });
      expect(sel.newSelection.main.head).toBe(9);
    });

    it('lets a pointer selection through', () => {
      const { state } = setup({ keyActive: () => true });
      const tr = state.update({
        selection: { anchor: 3 },
        userEvent: 'select.pointer',
      });
      expect(tr.newSelection.main.head).toBe(3);
    });

    it('refuses a user edit during a hold', () => {
      const { state } = setup({ holds: () => 1, outside: () => false });
      expect(typed(state, 'input.type').docChanged).toBe(false);
    });
  });

  describe('under a selection one window holds', () => {
    it('queues nothing and lets a key command inside the window through', () => {
      const e: Key = { chord: true, bound: true };
      const { state, keys } = setup({
        globalSel: () => SMALL,
        outside: () => false,
        keyActive: () => true,
        keydown: () => e,
      });
      const tr = state.update({
        selection: { anchor: 3 },
        userEvent: 'select',
      });
      expect(tr.newSelection.main.head).toBe(3);
      expect(keys).toEqual([]);
    });

    it('does not queue the key of a bound key that is no chord', () => {
      const e: Key = { chord: false, bound: true };
      const { state, keys } = setup({
        globalSel: () => SMALL,
        outside: () => true,
        keyActive: () => true,
        keydown: () => e,
      });
      state.update({ selection: { anchor: 3 }, userEvent: 'select' });
      expect(keys).toEqual([]);
    });

    it('queues the key of a chord that is refused outside the window', () => {
      const e: Key = { chord: true, bound: true };
      const { state, keys } = setup({
        globalSel: () => SMALL,
        outside: () => true,
        keyActive: () => true,
        keydown: () => e,
      });
      state.update({ selection: { anchor: 3 }, userEvent: 'select' });
      expect(keys).toEqual([e]);
    });
  });

  it('takes a user edit during a swap to keep the composition apart', () => {
    const swapping = setup({ swapping: () => true, outside: () => false });
    expect(typed(swapping.state, 'input.type').docChanged).toBe(false);
    const composing = setup({
      swapping: () => true,
      outside: () => false,
      capturing: () => true,
    });
    expect(typed(composing.state, 'input.type.compose').docChanged).toBe(true);
  });
});
