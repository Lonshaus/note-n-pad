// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { EditorState, Text } from '@codemirror/state';
import { accumulate, finishCapture, startCapture } from '../util/imeCapture';
import { byteLength, charToByte, mirrorStep } from '../util/windowedEdit';
import {
  selectionAfterChange,
  type LineSelection,
} from '../util/windowSelection';
import {
  PLACEHOLDER,
  budgetCheck,
  budgetPhase,
  cutLines,
  docPos,
  forcedMoves,
  hiddenAt,
  hiddenEnds,
  holeExtensions,
  holeSetOf,
  holeSpans,
  holesOf,
  lineLength,
  livePos,
  markerRead,
  placeOffset,
  placedHoles,
  pointerMoves,
  rangeHasPlaceholder,
  readForOf,
  readRequest,
  setHoles,
  windowHoles,
  type CutLine,
  type ReadHole,
  type ReadInput,
} from './holes';

function hole(
  line: number,
  at: number,
  units: number,
  extra: Partial<ReadHole> = {},
): ReadHole {
  return {
    line,
    at,
    bytes: units,
    units,
    budget: false,
    in_view: false,
    ...extra,
  };
}
// A state over `lines` (placeholders written as U+FFFC) with the holes read
// for them.
function make(
  lines: string[],
  holes: ReadHole[],
  readFor: LineSelection | null = null,
): EditorState {
  const doc = Text.of(lines);
  return EditorState.create({
    doc,
    extensions: [
      holeExtensions(
        holeSetOf(doc, holes, (bytes) => `${bytes} B`),
        readFor,
        {
          onMarker: () => {},
        },
      ),
    ],
  });
}
function sel(
  anchorLine: number,
  anchorCol: number,
  headLine: number,
  headCol: number,
): LineSelection {
  return {
    anchor: { line: anchorLine, col: anchorCol },
    head: { line: headLine, col: headCol },
  };
}
const P = PLACEHOLDER;
function fromsOf(state: EditorState): number[] {
  return placedHoles(state).map((h) => h.from);
}
function rangesOf(state: EditorState): [number, number][] {
  const out: [number, number][] = [];
  holesOf(state).between(0, state.doc.length, (from, to) => {
    out.push([from, to]);
  });
  return out;
}

describe('the hole field', () => {
  const base = () => make([`ab${P}cd`], [hole(0, 2, 6, { bytes: 9 })]);

  it('holds a range per placeholder, in the read order', () => {
    const state = make(
      [`${P}a`, `b${P}c${P}`],
      [hole(0, 0, 4), hole(1, 1, 5), hole(1, 3, 6)],
    );
    expect(fromsOf(state)).toEqual([0, 4, 6]);
    expect(placedHoles(state).map((h) => [h.line, h.at])).toEqual([
      [0, 0],
      [1, 1],
      [1, 3],
    ]);
  });

  it('keeps a hole outside text inserted at its start or at its end', () => {
    const atStart = base().update({ changes: { from: 2, insert: 'XY' } }).state;
    expect(rangesOf(atStart)).toEqual([[4, 5]]);
    const atEnd = base().update({ changes: { from: 3, insert: 'XY' } }).state;
    expect(rangesOf(atEnd)).toEqual([[2, 3]]);
  });

  it('drops a hole whose placeholder is replaced exactly', () => {
    const state = base().update({
      changes: { from: 2, to: 3, insert: 'Z' },
    }).state;
    expect(placedHoles(state)).toEqual([]);
  });

  it('drops a hole whose placeholder lies inside a larger replaced range', () => {
    const state = base().update({
      changes: { from: 1, to: 4, insert: 'Z' },
    }).state;
    expect(placedHoles(state)).toEqual([]);
  });

  it('keeps a hole that a change only touches', () => {
    const state = base().update({
      changes: [
        { from: 1, to: 2, insert: 'Z' },
        { from: 3, to: 4, insert: 'Y' },
      ],
    }).state;
    expect(fromsOf(state)).toEqual([2]);
  });

  it('counts no bytes for the hidden part once the placeholder is replaced by a dispatch', () => {
    const before = base();
    const doc0 = before.doc.toString();
    expect(charToByte(doc0, [], doc0.length, holeSpans(before))).toBe(
      byteLength('ab') + 9 + byteLength('cd'),
    );
    const after = before.update({
      changes: { from: 2, to: 3, insert: 'Z' },
    }).state;
    const doc1 = after.doc.toString();
    expect(charToByte(doc1, [], doc1.length, holeSpans(after))).toBe(
      byteLength(doc1),
    );
  });

  it('counts no bytes for the hidden part once the placeholder is replaced by a mirrored undo edit', () => {
    const before = base();
    const doc0 = before.doc.toString();
    const at = charToByte(doc0, [], 2, holeSpans(before));
    const step = mirrorStep(
      doc0,
      [],
      0,
      { start: at, end: at + 9, text: 'Z' },
      holeSpans(before),
    );
    expect(step?.change).toEqual({ from: 2, to: 3, insert: 'Z' });
    const change = step?.change;
    expect(change).toBeTruthy();
    const after = before.update({
      changes: change as NonNullable<typeof change>,
    }).state;
    const doc1 = after.doc.toString();
    expect(doc1).toBe('abZcd');
    expect(placedHoles(after)).toEqual([]);
    expect(charToByte(doc1, [], doc1.length, holeSpans(after))).toBe(
      byteLength('abZcd'),
    );
  });

  it('puts back the holes of the start with the revert of a composition', () => {
    const start = base();
    let capture = startCapture(start.doc.length);
    const composed = start.update({
      changes: { from: 1, to: 4, insert: 'あい' },
    });
    capture = accumulate(capture, composed.changes);
    expect(placedHoles(composed.state)).toEqual([]);
    const done = finishCapture(start.doc, capture.changes);
    const reverted = composed.state.update({
      changes: done.revert,
      selection: start.selection,
      effects: setHoles(holesOf(start)),
    }).state;
    expect(reverted.doc.eq(start.doc)).toBe(true);
    const doc = reverted.doc.toString();
    expect(charToByte(doc, [], doc.length, holeSpans(reverted))).toBe(
      charToByte(start.doc.toString(), [], start.doc.length, holeSpans(start)),
    );
    expect(done.committed).toBe('あい');
  });

  it('replaces the holes with the set of setHoles, in the new coordinates', () => {
    const start = base();
    const next = make([`xyz${P}`], [hole(0, 3, 2)]);
    const state = start.update({
      changes: { from: 0, to: start.doc.length, insert: `xyz${P}` },
      effects: setHoles(holesOf(next)),
    }).state;
    expect(fromsOf(state)).toEqual([3]);
  });
});

describe('readFor', () => {
  const focus = sel(5, 2, 7, 3);
  it('is the selection the state was built for, or null', () => {
    expect(readForOf(make(['abc'], [], focus))).toEqual(focus);
    expect(readForOf(make(['abc'], []))).toBeNull();
  });

  it('survives a selection change and ends with any document change', () => {
    const state = make(['abc'], [], focus);
    const moved = state.update({ selection: { anchor: 1 } }).state;
    expect(readForOf(moved)).toEqual(focus);
    const edited = moved.update({ changes: { from: 0, insert: 'x' } }).state;
    expect(readForOf(edited)).toBeNull();
  });

  it('is compared by line and column, not by direction', () => {
    const state = make(['abc'], [], { ...focus, undirectional: true });
    expect(windowHoles(state, 0).readFor).toEqual({
      ...focus,
      undirectional: true,
    });
  });

  it('is read from the state of a state without the extensions as null', () => {
    expect(readForOf(EditorState.create({ doc: 'abc' }))).toBeNull();
    expect(holeSpans(EditorState.create({ doc: 'abc' }))).toEqual([]);
  });
});

describe('positions in a line with holes', () => {
  // Real columns: line 0 hides 10 before `abc`; line 1 hides 8 after `abc`;
  // line 2 hides 4 before and 6 after `mid`; line 3 hides 3 and 5 in the middle.
  const state = make(
    [`${P}abc`, `abc${P}`, `${P}mid${P}`, `a${P}b${P}c`, 'plain'],
    [
      hole(0, 0, 10),
      hole(1, 3, 8),
      hole(2, 0, 4),
      hole(2, 4, 6),
      hole(3, 1, 3),
      hole(3, 3, 5),
    ],
  );
  const lineStart = (n: number) => state.doc.line(n + 1).from;

  it('counts what each hole before a position stands for', () => {
    expect(livePos(state, lineStart(0))).toEqual({ line: 0, col: 0 });
    expect(livePos(state, lineStart(0) + 1)).toEqual({ line: 0, col: 10 });
    expect(livePos(state, lineStart(0) + 4)).toEqual({ line: 0, col: 13 });
    expect(livePos(state, lineStart(1) + 3)).toEqual({ line: 1, col: 3 });
    expect(livePos(state, lineStart(1) + 4)).toEqual({ line: 1, col: 11 });
    expect(livePos(state, lineStart(2) + 1)).toEqual({ line: 2, col: 4 });
    expect(livePos(state, lineStart(2) + 4)).toEqual({ line: 2, col: 7 });
    expect(livePos(state, lineStart(2) + 5)).toEqual({ line: 2, col: 13 });
    expect(livePos(state, lineStart(3) + 2)).toEqual({ line: 3, col: 4 });
    expect(livePos(state, lineStart(3) + 5)).toEqual({ line: 3, col: 11 });
    expect(livePos(state, lineStart(4) + 3)).toEqual({ line: 4, col: 3 });
  });

  it('turns every position of the document back into itself', () => {
    for (let pos = 0; pos <= state.doc.length; pos += 1) {
      expect(docPos(state, livePos(state, pos)), `pos ${pos}`).toBe(pos);
    }
  });

  it('puts a column strictly inside a hole at the edge nearer to it in the file', () => {
    // Line 3's first hole hides columns 1 to 4.
    expect(docPos(state, { line: 3, col: 2 })).toBe(lineStart(3) + 1);
    expect(docPos(state, { line: 3, col: 3 })).toBe(lineStart(3) + 2);
    // Line 0's hole hides columns 0 to 10; the middle goes left.
    expect(docPos(state, { line: 0, col: 5 })).toBe(lineStart(0));
    expect(docPos(state, { line: 0, col: 6 })).toBe(lineStart(0) + 1);
    // Line 2's first hole hides 4 columns: 2 is a tie, the left edge.
    expect(docPos(state, { line: 2, col: 2 })).toBe(lineStart(2));
  });

  it('maps a column past the line end to the line end', () => {
    expect(docPos(state, { line: 0, col: 99 })).toBe(lineStart(0) + 4);
    expect(docPos(state, { line: 1, col: 11 })).toBe(lineStart(1) + 4);
    expect(docPos(state, { line: 1, col: 1_000_000 })).toBe(lineStart(1) + 4);
    expect(docPos(state, { line: 4, col: 99 })).toBe(lineStart(4) + 5);
  });

  it('measures a line as it is in the file', () => {
    expect(lineLength(state, 0)).toBe(13);
    expect(lineLength(state, 1)).toBe(11);
    expect(lineLength(state, 2)).toBe(13);
    expect(lineLength(state, 3)).toBe(11);
    expect(lineLength(state, 4)).toBe(5);
  });

  it('calls a column hidden only strictly inside a hole', () => {
    expect(hiddenAt(state, { line: 0, col: 0 })).toBe(false);
    expect(hiddenAt(state, { line: 0, col: 1 })).toBe(true);
    expect(hiddenAt(state, { line: 0, col: 9 })).toBe(true);
    expect(hiddenAt(state, { line: 0, col: 10 })).toBe(false);
    expect(hiddenAt(state, { line: 1, col: 3 })).toBe(false);
    expect(hiddenAt(state, { line: 1, col: 4 })).toBe(true);
    expect(hiddenAt(state, { line: 1, col: 11 })).toBe(false);
    expect(hiddenAt(state, { line: 1, col: 99 })).toBe(false);
    expect(hiddenAt(state, { line: 3, col: 2 })).toBe(true);
    expect(hiddenAt(state, { line: 3, col: 5 })).toBe(false);
    expect(hiddenAt(state, { line: 3, col: 6 })).toBe(true);
  });

  it('finds a placeholder in a document range', () => {
    expect(rangeHasPlaceholder(state, 0, 1)).toBe(true);
    expect(rangeHasPlaceholder(state, 1, 4)).toBe(false);
    expect(rangeHasPlaceholder(state, 2, 5)).toBe(false);
    expect(rangeHasPlaceholder(state, 3, 6)).toBe(false);
    expect(rangeHasPlaceholder(state, 4, 9)).toBe(true);
    expect(rangeHasPlaceholder(state, 3, 3)).toBe(false);
  });
});

describe('placeOffset', () => {
  // `ab` + a hole of 9 bytes + `cd` + a CRLF + `e`.
  const state = make([`ab${P}cd`, 'e'], [hole(0, 2, 6, { bytes: 9 })]);
  const doc = state.doc.toString();
  const breaks = ['\r\n'];
  const spans = holeSpans(state);
  const geometry = {
    startOffset: 100,
    endOffset: 100 + 2 + 9 + 2 + 2 + 1,
    endLine: 2,
  };
  const place = (off: number, totalLines = 2) =>
    placeOffset(off, geometry, totalLines, doc, breaks, spans);

  it('finds the document position of an offset in the loaded part', () => {
    expect(place(100)).toBe(0);
    expect(place(102)).toBe(2);
    expect(place(111)).toBe(3);
    expect(place(115)).toBe(6);
  });

  it('puts an offset strictly inside a hole outside the window', () => {
    expect(place(103)).toBeNull();
    expect(place(110)).toBeNull();
  });

  it('puts an offset outside the window range outside', () => {
    expect(place(99)).toBeNull();
    expect(place(116, 3)).toBeNull();
  });

  it('takes the end of the file as inside only when the window holds its last line', () => {
    expect(place(116, 2)).toBe(7);
  });

  it('moves an offset inside a CRLF to the start of the break', () => {
    expect(place(114)).toBe(5);
  });
});

describe('pointerMoves', () => {
  const none = { anchor: false, head: false };
  const hiddenHead = { anchor: false, head: true };
  it('is the ends whose position differs when no kept end is hidden', () => {
    expect(
      pointerMoves({ anchor: 2, head: 5 }, { anchor: 2, head: 5 }, none),
    ).toEqual({ anchor: false, head: false });
    expect(
      pointerMoves({ anchor: 2, head: 5 }, { anchor: 2, head: 8 }, none),
    ).toEqual({ anchor: false, head: true });
  });

  it('counts the head as moved by a shift-click at a hidden end', () => {
    expect(
      pointerMoves({ anchor: 2, head: 5 }, { anchor: 2, head: 5 }, hiddenHead),
    ).toEqual({ anchor: false, head: true });
  });

  it('counts both ends as moved by a click that leaves a caret', () => {
    expect(
      pointerMoves({ anchor: 5, head: 5 }, { anchor: 5, head: 5 }, hiddenHead),
    ).toEqual({ anchor: true, head: true });
  });

  it('counts both ends as moved by a Select All', () => {
    expect(
      pointerMoves(
        { anchor: 2, head: 9 },
        { anchor: 2, head: 9 },
        { anchor: true, head: false },
        true,
      ),
    ).toEqual({ anchor: true, head: true });
  });

  it('leaves a click at the edge of a hidden end out of the ends it keeps', () => {
    // The ends a click does not move are the ones read from the global
    // selection: the hidden head is not among them, the anchor is.
    const moved = pointerMoves(
      { anchor: 2, head: 5 },
      { anchor: 2, head: 5 },
      hiddenHead,
    );
    const unmoved = (['anchor', 'head'] as const).filter((end) => !moved[end]);
    expect(unmoved).toEqual(['anchor']);
  });
});

describe('a selection made where a hidden end is drawn', () => {
  // Line 100 of the file, `¤abc` with the first 10 columns hidden. The head
  // is hidden (column 4); the view draws it at the left edge of the marker.
  const state = make([`${P}abc`], [hole(0, 0, 10)]);
  const hiddenHead = sel(100, 12, 100, 4);
  const drawn = (s: EditorState, selection: { anchor: number; head: number }) =>
    EditorState.create({
      doc: s.doc,
      selection,
      extensions: [holeExtensions(holesOf(s), null, { onMarker: () => {} })],
    });
  const shown = drawn(state, { anchor: 3, head: 0 });
  const live = (s: EditorState) => ({
    anchor: livePos(s, s.selection.main.anchor),
    head: livePos(s, s.selection.main.head),
  });

  it('reads the live selection back from the view, not from the global one', () => {
    expect(live(shown)).toEqual(sel(0, 12, 0, 0));
    expect(docPos(state, { line: 0, col: 4 })).toBe(0);
  });

  it('keeps a hidden end whose live position the transaction did not change', () => {
    const lastLive = live(shown);
    const next = shown.update({ selection: { anchor: 3, head: 0 } }).state;
    expect(
      selectionAfterChange(hiddenHead, lastLive, live(next), 100, false),
    ).toEqual(hiddenHead);
  });

  it('moves the hidden head for a pointer selection made at its edge', () => {
    const lastLive = live(shown);
    const next = shown.update({ selection: { anchor: 3, head: 0 } }).state;
    const moved = forcedMoves({
      pointer: true,
      selectAll: false,
      startState: shown,
      next: next.selection.main,
      sel: hiddenHead,
      startLine: 100,
    });
    expect(moved).toEqual({ anchor: false, head: true });
    expect(
      selectionAfterChange(hiddenHead, lastLive, live(next), 100, false, moved),
    ).toEqual(sel(100, 12, 100, 0));
  });

  it('moves both ends for a Select All that comes out as the same selection', () => {
    const lastLive = live(shown);
    const next = shown.update({ selection: { anchor: 3, head: 0 } }).state;
    const moved = forcedMoves({
      pointer: false,
      selectAll: true,
      startState: shown,
      next: next.selection.main,
      sel: hiddenHead,
      startLine: 100,
    });
    expect(moved).toEqual({ anchor: true, head: true });
    expect(
      selectionAfterChange(hiddenHead, lastLive, live(next), 100, false, moved),
    ).toEqual(sel(100, 12, 100, 0));
    // The anchor is no longer a hidden or remembered end: it is the one drawn.
    const anchorHidden = sel(100, 5, 100, 12);
    expect(
      selectionAfterChange(
        anchorHidden,
        sel(0, 0, 0, 12),
        sel(0, 0, 0, 12),
        100,
        false,
        forcedMoves({
          pointer: false,
          selectAll: true,
          startState: drawn(state, { anchor: 0, head: 3 }),
          next: { anchor: 0, head: 3 },
          sel: anchorHidden,
          startLine: 100,
        }),
      ),
    ).toEqual(sel(100, 0, 100, 12));
  });

  it('keeps an end outside the window for such a click', () => {
    // `x`, then `¤abc`: the anchor lies before the window (drawn at its start),
    // the head is hidden on the second line and drawn at the marker's edge.
    const two = make(['x', `${P}abc`], [hole(1, 0, 10)]);
    const outside = sel(40, 3, 101, 4);
    const before = drawn(two, { anchor: 0, head: 2 });
    const lastLive = live(before);
    const next = before.update({ selection: { anchor: 0, head: 2 } }).state;
    const moved = forcedMoves({
      pointer: true,
      selectAll: false,
      startState: before,
      next: next.selection.main,
      sel: outside,
      startLine: 100,
    });
    expect(moved).toEqual({ anchor: false, head: true });
    expect(
      selectionAfterChange(outside, lastLive, live(next), 100, false, moved),
    ).toEqual(sel(40, 3, 101, 0));
  });

  it('is no forced move for a transaction that is neither', () => {
    expect(
      forcedMoves({
        pointer: false,
        selectAll: false,
        startState: shown,
        next: { anchor: 3, head: 0 },
        sel: hiddenHead,
        startLine: 100,
      }),
    ).toBeUndefined();
  });

  it('is no forced move when no kept end is hidden', () => {
    expect(
      forcedMoves({
        pointer: true,
        selectAll: false,
        startState: shown,
        next: { anchor: 3, head: 0 },
        sel: sel(100, 12, 100, 13),
        startLine: 100,
      }),
    ).toBeUndefined();
  });

  it('names the hidden ends of a global selection', () => {
    expect(hiddenEnds(state, hiddenHead, 100)).toEqual({
      anchor: false,
      head: true,
    });
    expect(hiddenEnds(state, sel(99, 4, 101, 4), 100)).toEqual({
      anchor: false,
      head: false,
    });
  });
});

describe('what the holes say about a selection (windowHoles)', () => {
  // Window from line 100: `¤abc` (10 hidden), `plain`, `x¤y`.
  const read = sel(100, 11, 100, 13);
  const state = make(
    [`${P}abc`, 'plain', `x${P}y`],
    [hole(0, 0, 10), hole(2, 1, 6)],
    read,
  );
  const holes = windowHoles(state, 100);

  it('says a global position strictly inside a hole is hidden', () => {
    expect(holes.hidden({ line: 100, col: 5 })).toBe(true);
    expect(holes.hidden({ line: 100, col: 10 })).toBe(false);
    expect(holes.hidden({ line: 100, col: 0 })).toBe(false);
    expect(holes.hidden({ line: 101, col: 2 })).toBe(false);
    expect(holes.hidden({ line: 102, col: 4 })).toBe(true);
    expect(holes.hidden({ line: 99, col: 4 })).toBe(false);
    expect(holes.hidden({ line: 103, col: 4 })).toBe(false);
  });

  it('carries the selection the window was read for', () => {
    expect(holes.readFor).toEqual(read);
  });

  it('says the text is hidden for a range that holds a placeholder', () => {
    expect(holes.hiddenText(sel(100, 0, 100, 12))).toBe(true);
    expect(holes.hiddenText(sel(100, 11, 100, 13))).toBe(false);
  });

  it('says the text is hidden for a hidden end whose live range holds no placeholder', () => {
    expect(holes.hiddenText(sel(100, 4, 100, 4))).toBe(true);
    expect(holes.hiddenText(sel(100, 4, 100, 12))).toBe(true);
  });

  it('says the text is hidden for a caret on a line with a hole', () => {
    expect(holes.hiddenText(sel(102, 0, 102, 0))).toBe(true);
    expect(holes.hiddenText(sel(101, 2, 101, 2))).toBe(false);
  });

  it('does not count a caret outside the window as on a line with a hole', () => {
    expect(holes.hiddenText(sel(300, 0, 300, 0))).toBe(false);
  });
});

describe('the lines of a window with holes (cutLines)', () => {
  const state = make(
    [`abc${P}`, `${P}é日`, `${P}x${P}`, `a${P}b${P}c`, P, 'plain'],
    [
      hole(0, 3, 100, { bytes: 120 }),
      hole(1, 0, 40, { bytes: 50 }),
      hole(2, 0, 7, { bytes: 9 }),
      hole(2, 2, 8, { bytes: 11 }),
      hole(3, 1, 2),
      hole(3, 3, 3),
      hole(4, 0, 30),
    ],
  );
  const cuts = cutLines(state, 1000);

  it('names the shape of each line and keeps global lines', () => {
    expect(cuts.map((c) => [c.line, c.shape])).toEqual([
      [1000, 'right'],
      [1001, 'left'],
      [1002, 'both'],
      [1003, 'mid'],
      [1004, 'right'],
    ]);
  });

  it('counts a line as its loaded bytes plus what the holes stand for', () => {
    expect(cuts[0]?.contentBytes).toBe(3 + 120);
    expect(cuts[1]?.contentBytes).toBe(50 + 2 + 3);
    expect(cuts[2]?.contentBytes).toBe(9 + 1 + 11);
    expect(cuts[4]?.contentBytes).toBe(30);
  });

  it('gives the bytes before the loaded part of a line with a left hole', () => {
    expect(cuts[1]?.leftBytes).toBe(50);
    expect(cuts[2]?.leftBytes).toBe(9);
  });
});

describe('a click on a marker (markerRead)', () => {
  // `¤mid¤` with 9 bytes hidden before and 11 after.
  const state = make(
    [`${P}mid${P}`, `a${P}b${P}c`],
    [
      hole(0, 0, 7, { bytes: 9 }),
      hole(0, 4, 8, { bytes: 11 }),
      hole(1, 1, 2),
      hole(1, 3, 3),
    ],
  );
  const line1 = state.doc.line(2).from;

  it('shows the part before a hole that loaded text follows, ending at its end', () => {
    expect(markerRead(state, 0, 500)).toEqual({
      line: 500,
      entry: { line: 500, end: 9 },
      fromEnd: true,
    });
  });

  it('shows the part after a hole that nothing loaded follows, starting at its start', () => {
    expect(markerRead(state, 4, 500)).toEqual({
      line: 500,
      entry: { line: 500, start: 9 + 3 },
      fromEnd: false,
    });
  });

  it('counts the bytes of the holes before a hole in the middle of a line', () => {
    expect(markerRead(state, line1 + 1, 500)?.entry).toEqual({
      line: 501,
      end: 1 + 2,
    });
    expect(markerRead(state, line1 + 3, 500)?.entry).toEqual({
      line: 501,
      end: 1 + 2 + 1 + 3,
    });
  });

  it('finds nothing where no hole starts', () => {
    expect(markerRead(state, 2, 500)).toBeNull();
  });
});

describe('readRequest', () => {
  const cuts: CutLine[] = [
    { line: 10, shape: 'right', leftBytes: 0, contentBytes: 5000 },
    { line: 12, shape: 'left', leftBytes: 4000, contentBytes: 5000 },
    { line: 14, shape: 'both', leftBytes: 100, contentBytes: 9000 },
    { line: 16, shape: 'mid', leftBytes: 7, contentBytes: 9000 },
    { line: 3000, shape: 'right', leftBytes: 0, contentBytes: 5000 },
  ];
  const input = (extra: Partial<ReadInput>): ReadInput => ({
    mode: 'reload',
    range: { startLine: 0, endLine: 2000 },
    screen: [20, 60],
    keepAllowed: true,
    cuts,
    ...extra,
  });
  const keepOfLines = (keep: { line: number }[] | undefined) =>
    keep?.map((k) => k.line);

  it('goto reads for a caret at the start of the target, with no view', () => {
    const { args, readFor } = readRequest(input({ mode: 'goto', target: 7 }));
    expect(args.focus).toEqual({ line: 7, col: 0 });
    expect(args.also).toEqual({ line: 7, col: 0 });
    expect(args.view).toBeUndefined();
    expect(readFor).toEqual(sel(7, 0, 7, 0));
    expect(args.keep).toEqual([
      { line: 10, start: 0 },
      { line: 12, end: 5000 },
      { line: 14, start: 100 },
    ]);
  });

  it('goto keeps no entry for the target line', () => {
    const { args } = readRequest(input({ mode: 'goto', target: 12 }));
    expect(keepOfLines(args.keep)).toEqual([10, 14]);
  });

  it('reveal reads for the selection, the head as focus and the anchor as also', () => {
    const selection = sel(12, 3, 14, 9);
    const { args, readFor } = readRequest(
      input({ mode: 'reveal', sel: selection }),
    );
    expect(args.focus).toEqual({ line: 14, col: 9 });
    expect(args.also).toEqual({ line: 12, col: 3 });
    expect(args.view).toBeUndefined();
    expect(readFor).toEqual(selection);
    expect(keepOfLines(args.keep)).toEqual([10]);
  });

  it('mount reads for the restored caret when its line is in the range', () => {
    const { args, readFor } = readRequest(
      input({
        mode: 'mount',
        keepAllowed: false,
        target: 40,
        caret: { line: 100, col: 6 },
      }),
    );
    expect(args.focus).toEqual({ line: 100, col: 6 });
    expect(readFor).toEqual(sel(100, 6, 100, 6));
    expect(args.keep).toBeUndefined();
    expect(args.view).toBeUndefined();
  });

  it('mount reads for the start of the target line when the caret is out of the range', () => {
    expect(
      readRequest(
        input({
          mode: 'mount',
          keepAllowed: false,
          target: 40,
          caret: { line: 2500, col: 6 },
        }),
      ).readFor,
    ).toEqual(sel(40, 0, 40, 0));
    expect(
      readRequest(input({ mode: 'mount', keepAllowed: false, target: 40 }))
        .readFor,
    ).toEqual(sel(40, 0, 40, 0));
  });

  it('preserve and reload read for nothing and name the lines on screen', () => {
    for (const mode of ['preserve', 'reload'] as const) {
      const { args, readFor } = readRequest(input({ mode }));
      expect(readFor).toBeNull();
      expect(args.focus).toBeUndefined();
      expect(args.also).toBeUndefined();
      expect(args.view).toEqual([20, 60]);
      expect(args.keep).toEqual([
        { line: 10, start: 0 },
        { line: 12, end: 5000 },
        { line: 14, start: 100 },
      ]);
    }
  });

  it('sends no view without a screen, and no entry for a line outside the range', () => {
    const { args } = readRequest(input({ mode: 'reload', screen: null }));
    expect(args.view).toBeUndefined();
    expect(keepOfLines(args.keep)).not.toContain(3000);
  });

  it('sends no keep while byte offsets inside lines are stale', () => {
    for (const mode of ['reload', 'preserve', 'reveal', 'goto'] as const) {
      const { args } = readRequest(
        input({ mode, keepAllowed: false, sel: sel(1, 0, 1, 0), target: 1 }),
      );
      expect(args.keep, mode).toBeUndefined();
    }
  });

  it('a budget re-read names the lines on screen and repeats the focus only when focused', () => {
    const selection = sel(12, 3, 14, 9);
    const focused = readRequest(
      input({ mode: 'budget', sel: selection, focused: true }),
    );
    expect(focused.args.view).toEqual([20, 60]);
    expect(focused.args.focus).toEqual({ line: 14, col: 9 });
    expect(focused.readFor).toEqual(selection);
    expect(keepOfLines(focused.args.keep)).toEqual([10]);
    const plain = readRequest(
      input({ mode: 'budget', sel: selection, focused: false }),
    );
    expect(plain.args.focus).toBeUndefined();
    expect(plain.readFor).toBeNull();
    expect(keepOfLines(plain.args.keep)).toEqual([10, 12, 14]);
  });

  it('a marker click leads with its line and keeps the part its hole says', () => {
    const { args, readFor } = readRequest(
      input({
        mode: 'click',
        click: { line: 12, entry: { line: 12, start: 4000 } },
      }),
    );
    expect(readFor).toBeNull();
    expect(args.lead).toBe(12);
    expect(args.view).toEqual([20, 60]);
    expect(args.keep).toEqual([
      { line: 10, start: 0 },
      { line: 12, start: 4000 },
      { line: 14, start: 100 },
    ]);
  });

  it('a marker click sends its own entry even when the line has a hole in the middle', () => {
    const { args } = readRequest(
      input({
        mode: 'click',
        click: { line: 16, entry: { line: 16, start: 7 } },
      }),
    );
    expect(args.keep?.find((k) => k.line === 16)).toEqual({
      line: 16,
      start: 7,
    });
  });

  it('a shadow read sends neither keep nor view', () => {
    const reveal = readRequest(
      input({ mode: 'reveal', sel: sel(12, 3, 14, 9), shadow: true }),
    );
    expect(reveal.args.keep).toBeUndefined();
    expect(reveal.args.view).toBeUndefined();
    expect(reveal.args.focus).toEqual({ line: 14, col: 9 });
    const plain = readRequest(input({ mode: 'reload', shadow: true }));
    expect(plain.args).toEqual({});
    expect(plain.readFor).toBeNull();
    const goto = readRequest(input({ mode: 'goto', target: 5, shadow: true }));
    expect(goto.args.focus).toEqual({ line: 5, col: 0 });
    expect(goto.args.keep).toBeUndefined();
  });
});

describe('budgetCheck', () => {
  const screen = [20, 60] as const;
  const selection = sel(25, 1, 30, 2);
  const cut = { budget: true, inView: false };
  it('asks for a re-read for a budget hole not in view on a line on screen', () => {
    expect(
      budgetCheck(screen, [{ line: 30, ...cut }], null, selection).reread,
    ).toBe(true);
  });

  it('does not for a hole off screen, in view, or cut by the line cap alone', () => {
    expect(
      budgetCheck(screen, [{ line: 61, ...cut }], null, selection).reread,
    ).toBe(false);
    expect(
      budgetCheck(screen, [{ line: 60, ...cut }], null, selection).reread,
    ).toBe(false);
    expect(
      budgetCheck(
        screen,
        [{ line: 30, budget: true, inView: true }],
        null,
        selection,
      ).reread,
    ).toBe(false);
    expect(
      budgetCheck(
        screen,
        [{ line: 30, budget: false, inView: false }],
        null,
        selection,
      ).reread,
    ).toBe(false);
    expect(
      budgetCheck(null, [{ line: 30, ...cut }], null, selection).reread,
    ).toBe(false);
  });

  it('repeats the focus only while the window was read for the selection', () => {
    const holes = [{ line: 30, ...cut }];
    expect(budgetCheck(screen, holes, selection, selection).focused).toBe(true);
    expect(
      budgetCheck(
        screen,
        holes,
        { ...selection, undirectional: true },
        selection,
      ).focused,
    ).toBe(true);
    expect(
      budgetCheck(screen, holes, sel(25, 1, 30, 3), selection).focused,
    ).toBe(false);
    expect(budgetCheck(screen, holes, null, selection).focused).toBe(false);
  });

  it('is never focused without a re-read', () => {
    expect(budgetCheck(screen, [], selection, selection)).toEqual({
      reread: false,
      focused: false,
    });
  });
});

describe('budgetPhase', () => {
  it('waits after an install until the timer queued after its frames', () => {
    const pending = budgetPhase('idle', 'install');
    expect(pending).toBe('pending');
    expect(budgetPhase(pending, 'install')).toBe('pending');
    expect(budgetPhase(pending, 'timer')).toBe('due');
  });

  it('stays due until the next install makes it wait again', () => {
    expect(budgetPhase('due', 'timer')).toBe('due');
    expect(budgetPhase('due', 'install')).toBe('pending');
  });

  it('is never due without an install, and ends with the editor', () => {
    expect(budgetPhase('idle', 'timer')).toBe('idle');
    expect(budgetPhase('due', 'gone')).toBe('idle');
    expect(budgetPhase('pending', 'gone')).toBe('idle');
  });
});
