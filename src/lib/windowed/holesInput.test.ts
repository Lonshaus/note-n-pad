// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EditorSelection,
  EditorState,
  Text,
  type SelectionRange,
  type Transaction,
} from '@codemirror/state';
import type { Command } from '@codemirror/view';
import {
  copyLineDown,
  copyLineUp,
  deleteCharBackward,
  deleteCharForward,
  deleteGroupBackward,
  deleteGroupForward,
  deleteLine,
  deleteLineBoundaryBackward,
  deleteLineBoundaryForward,
  deleteToLineEnd,
  deleteToLineStart,
  moveLineDown,
  moveLineUp,
  transposeChars,
} from '@codemirror/commands';
import { mapChangesToEdits } from '../util/windowedEdit';
import { dequeueStep, shadowStep } from '../util/globalRouting';
import { commandChain, coreKeyBindings } from '../util/replayKeys';
import { buildKeymap } from '../editor/keymap';
import {
  replayReady,
  type LineSelection,
  type ReachDecision,
} from '../util/windowSelection';
import {
  PLACEHOLDER,
  PLACEHOLDER_DELETES,
  REACHING_DELETES,
  dragRefused,
  holeExtensions,
  holeSetOf,
  holeSpans,
  keptListStep,
  keptMarkerPos,
  keptRequest,
  keptSchedule,
  livePos,
  markerAtByte,
  markerStart,
  newPartEnd,
  reachDecision,
  reachGate,
  recordedCommand,
  replaceTarget,
  runKeptList,
  runsRecordedCommand,
  windowHoles,
  type KeptHost,
  type KeptRequest,
  type LineBoundary,
  type ReadHole,
} from './holes';

const P = PLACEHOLDER;
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
// A state over `lines` with the holes read for them. `command` is what the
// editor reports as the command of the key being handled.
function make(
  lines: string[],
  holes: ReadHole[],
  selection: { anchor: number; head?: number } = { anchor: 0 },
  command: Command | null = null,
): EditorState {
  const doc = Text.of(lines);
  return EditorState.create({
    doc,
    selection,
    extensions: [
      holeExtensions(
        holeSetOf(doc, holes, (b) => `${b} B`),
        null,
        {
          onMarker: () => {},
          recordedCommand: () => command,
          hiddenEnd: () => false,
        },
      ),
    ],
  });
}
// The line edge a boundary command moves to: the real line's, which the
// placeholder stands for.
const edge =
  (state: EditorState): LineBoundary =>
  (range: SelectionRange, forward: boolean): SelectionRange => {
    const line = state.doc.lineAt(range.head);
    return EditorSelection.cursor(forward ? line.to : line.from);
  };
// The transaction a command makes on the state, null when it makes none.
function run(state: EditorState, command: Command): Transaction | null {
  let out: Transaction | null = null;
  command({
    state,
    dispatch: (tr: Transaction) => {
      out = tr;
    },
    moveToLineBoundary: edge(state),
  } as never);
  return out;
}
function caretAt(
  state: EditorState,
  line: number,
  docCol: number,
): LineSelection {
  const pos = livePos(state, state.doc.line(line + 1).from + docCol);
  return { anchor: pos, head: pos };
}

describe('the commands a key is recorded as', () => {
  const other: Command = () => true;
  const another: Command = () => true;

  it('is the first command of the chain that reaches a placeholder or may remove one', () => {
    expect(
      recordedCommand([other, deleteCharBackward, deleteToLineEnd], null),
    ).toBe(deleteCharBackward);
    expect(recordedCommand([other, deleteLine, deleteCharForward], null)).toBe(
      deleteLine,
    );
  });

  it('is the first command of the chain when none of them does', () => {
    expect(recordedCommand([other, another], null)).toBe(other);
  });

  it('is the command a code-named key resolves when the chain is empty', () => {
    expect(recordedCommand([], deleteGroupBackward)).toBe(deleteGroupBackward);
    expect(recordedCommand([], null)).toBeNull();
  });

  it('keeps the two sets apart, the line-boundary deletes in both', () => {
    expect(REACHING_DELETES.has(deleteLineBoundaryForward)).toBe(true);
    expect(PLACEHOLDER_DELETES.has(deleteLineBoundaryForward)).toBe(true);
    expect(REACHING_DELETES.has(deleteToLineEnd)).toBe(false);
    expect(PLACEHOLDER_DELETES.has(deleteCharBackward)).toBe(false);
  });
});

describe('the gate of the keydown decision', () => {
  const open = {
    guard: true,
    focusInEditor: true,
    inside: true,
    imeKey: false,
    composing: false,
    capturing: false,
  };

  it('judges a key when everything allows it', () => {
    expect(reachGate(open)).toBe(true);
  });

  it('makes no decision with focus elsewhere, outside the window, for an input-method key, or during a composition', () => {
    expect(reachGate({ ...open, guard: false })).toBe(false);
    expect(reachGate({ ...open, focusInEditor: false })).toBe(false);
    expect(reachGate({ ...open, inside: false })).toBe(false);
    expect(reachGate({ ...open, imeKey: true })).toBe(false);
    expect(reachGate({ ...open, composing: true })).toBe(false);
    expect(reachGate({ ...open, capturing: true })).toBe(false);
  });
});

describe('reachDecision', () => {
  const decide = (
    state: EditorState,
    command: Command,
    caret: LineSelection,
    readFor: LineSelection | null = null,
  ) => reachDecision(state, command, caret, readFor, edge(state));

  it('reloads for a plain Backspace right after a placeholder', () => {
    const state = make([`ab${P}cd`], [hole(0, 2, 6)]);
    expect(decide(state, deleteCharBackward, caretAt(state, 0, 3))).toBe(
      'reload',
    );
  });

  it('reloads for Backspace after a left placeholder followed by U+FE0F', () => {
    const state = make([`${P}️a`], [hole(0, 0, 6)]);
    expect(decide(state, deleteCharBackward, caretAt(state, 0, 2))).toBe(
      'reload',
    );
  });

  it('reloads for a forward delete before a ZWJ followed by a right placeholder', () => {
    const state = make([`ab‍${P}`], [hole(0, 3, 6)]);
    expect(decide(state, deleteCharForward, caretAt(state, 0, 2))).toBe(
      'reload',
    );
  });

  it('reloads for a group delete two punctuation characters before a right placeholder', () => {
    const state = make([`a..${P}`], [hole(0, 3, 6)]);
    expect(decide(state, deleteGroupForward, caretAt(state, 0, 1))).toBe(
      'reload',
    );
  });

  it('reloads for a group delete over letters that end at a left placeholder', () => {
    const state = make([`${P}abc`], [hole(0, 0, 6)]);
    expect(decide(state, deleteGroupBackward, caretAt(state, 0, 4))).toBe(
      'reload',
    );
  });

  it('reloads for a line-boundary delete when the window was not read for the caret', () => {
    const state = make([`ab${P}`], [hole(0, 2, 6)]);
    expect(decide(state, deleteLineBoundaryForward, caretAt(state, 0, 0))).toBe(
      'reload',
    );
  });

  it('runs a Backspace two letters away from a placeholder', () => {
    const state = make([`${P}abc`], [hole(0, 0, 6)]);
    expect(decide(state, deleteCharBackward, caretAt(state, 0, 3))).toBe('run');
  });

  it('runs a group delete at column 0 after a line with a right hole, and one at a line end before a line with a left hole', () => {
    const before = make([`ab${P}`, 'cd'], [hole(0, 2, 6)]);
    expect(decide(before, deleteGroupBackward, caretAt(before, 1, 0))).toBe(
      'run',
    );
    const after = make(['ab', `${P}cd`], [hole(1, 0, 6)]);
    expect(decide(after, deleteGroupForward, caretAt(after, 0, 2))).toBe('run');
  });

  it('runs a Backspace at column 0 and a forward delete at a line end that only remove a break', () => {
    const before = make([`ab${P}`, 'cd'], [hole(0, 2, 6)]);
    expect(decide(before, deleteCharBackward, caretAt(before, 1, 0))).toBe(
      'run',
    );
    const after = make(['ab', `${P}cd`], [hole(1, 0, 6)]);
    expect(decide(after, deleteCharForward, caretAt(after, 0, 2))).toBe('run');
  });

  it('runs a break-only delete on the line that has the hole', () => {
    // The caret at the end of a line that ends in a hole, and at the start of
    // one that starts with a hole: the key removes the break between them.
    const end = make([`ab${P}`, 'cd'], [hole(0, 2, 6)]);
    expect(decide(end, deleteCharForward, caretAt(end, 0, 3))).toBe('run');
    expect(decide(end, deleteGroupForward, caretAt(end, 0, 3))).toBe('run');
    const start = make(['ab', `${P}cd`], [hole(1, 0, 6)]);
    expect(decide(start, deleteCharBackward, caretAt(start, 1, 0))).toBe('run');
    expect(decide(start, deleteGroupBackward, caretAt(start, 1, 0))).toBe(
      'run',
    );
  });

  it('runs a key that is not a reaching delete, and a non-empty selection', () => {
    const state = make([`${P}abc`], [hole(0, 0, 6)]);
    expect(decide(state, deleteToLineEnd, caretAt(state, 0, 1))).toBe('run');
    // Its head right after the placeholder: a caret there would reload.
    const head = caretAt(state, 0, 1).head;
    const range: LineSelection = {
      anchor: { line: 0, col: 9 },
      head,
    };
    expect(decide(state, deleteCharBackward, caretAt(state, 0, 1))).toBe(
      'reload',
    );
    expect(decide(state, deleteCharBackward, range)).toBe('run');
  });

  it('runs a caret outside the window', () => {
    const state = make([`${P}abc`], [hole(0, 0, 6)]);
    const far: LineSelection = {
      anchor: { line: 40, col: 0 },
      head: { line: 40, col: 0 },
    };
    expect(decide(state, deleteCharBackward, far)).toBe('run');
  });

  it('measures the caret from the first line of the window', () => {
    const state = make([`x`, `${P}abc`], [hole(1, 0, 6)]);
    const caret = caretAt(state, 1, 4);
    const global: LineSelection = {
      anchor: { line: 301, col: caret.anchor.col },
      head: { line: 301, col: caret.head.col },
    };
    expect(
      reachDecision(state, deleteGroupBackward, global, null, edge(state), 300),
    ).toBe('reload');
  });

  it('refuses a reaching group delete once the window was read for the caret', () => {
    const state = make([`${P}abc`], [hole(0, 0, 6)]);
    const caret = caretAt(state, 0, 4);
    expect(decide(state, deleteGroupBackward, caret, caret)).toBe('refuse');
    expect(decide(state, deleteCharBackward, caretAt(state, 0, 1), null)).toBe(
      'reload',
    );
    expect(
      decide(
        state,
        deleteCharBackward,
        caretAt(state, 0, 1),
        caretAt(state, 0, 1),
      ),
    ).toBe('refuse');
  });

  it('runs a line-boundary delete once the window was read for the caret', () => {
    const state = make([`ab${P}`], [hole(0, 2, 6)]);
    const caret = caretAt(state, 0, 0);
    expect(decide(state, deleteLineBoundaryForward, caret, caret)).toBe('run');
    expect(decide(state, deleteLineBoundaryBackward, caret, caret)).toBe('run');
  });

  it('compares the selection read for by line and column only', () => {
    const state = make([`${P}abc`], [hole(0, 0, 6)]);
    const caret = caretAt(state, 0, 4);
    const marked = { ...caret, undirectional: true };
    expect(decide(state, deleteGroupBackward, caret, marked)).toBe('refuse');
  });

  it('changes nothing in the state it was asked about', () => {
    const state = make([`${P}abc`], [hole(0, 0, 6)], { anchor: 2 });
    decide(state, deleteGroupBackward, caretAt(state, 0, 4));
    expect(state.doc.toString()).toBe(`${P}abc`);
    expect(state.selection.main.head).toBe(2);
  });
});

describe('the delete filter', () => {
  const lines = [`ab${P}cd`];
  const holes = [hole(0, 2, 6, { bytes: 9 })];

  it('refuses a caret transaction that removes a placeholder under no key', () => {
    const state = make(lines, holes, { anchor: 3 });
    const tr = state.update({
      changes: { from: 2, to: 3 },
      userEvent: 'delete.backward',
    });
    expect(tr.docChanged).toBe(false);
  });

  it('refuses it under a Backspace key', () => {
    const state = make(lines, holes, { anchor: 3 }, deleteCharBackward);
    const tr = run(state, deleteCharBackward);
    expect(tr?.docChanged).toBe(false);
  });

  it('refuses a delete the browser makes itself, read back as typed input', () => {
    const state = make(lines, holes, { anchor: 3 });
    const tr = state.update({
      changes: { from: 2, to: 3 },
      userEvent: 'input.type',
    });
    expect(tr.docChanged).toBe(false);
  });

  it('passes a delete that removes no placeholder, and one with no user event', () => {
    const state = make(lines, holes, { anchor: 5 });
    expect(
      state.update({
        changes: { from: 4, to: 5 },
        userEvent: 'delete.backward',
      }).docChanged,
    ).toBe(true);
    expect(state.update({ changes: { from: 2, to: 3 } }).docChanged).toBe(true);
  });

  it('passes Delete to Line End as one byte edit that covers the hidden bytes', () => {
    const state = make(lines, holes, { anchor: 1 }, deleteToLineEnd);
    const tr = state.update({
      changes: { from: 1, to: 5 },
      userEvent: 'delete.forward',
    });
    expect(tr.docChanged).toBe(true);
    const changes: { fromA: number; toA: number; inserted: string }[] = [];
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      changes.push({ fromA, toA, inserted: inserted.toString() });
    });
    const edits = mapChangesToEdits(
      0,
      state.doc.toString(),
      [],
      '\n',
      changes,
      holeSpans(state),
    );
    // `b`, the 9 hidden bytes and `cd`.
    expect(edits.map((e) => [e.start, e.end])).toEqual([[1, 1 + 1 + 9 + 2]]);
  });

  it('passes Delete to Line Start, Delete Line and the line-boundary deletes', () => {
    for (const command of [
      deleteToLineStart,
      deleteLine,
      deleteLineBoundaryBackward,
      deleteLineBoundaryForward,
    ]) {
      const state = make(lines, holes, { anchor: 4 }, command);
      const tr = state.update({
        changes: { from: 0, to: 4 },
        userEvent: 'delete.backward',
      });
      expect(tr.docChanged).toBe(true);
    }
  });

  it('passes a non-empty selection that holds the placeholder', () => {
    const state = make(lines, holes, { anchor: 1, head: 4 });
    const tr = state.update({
      changes: { from: 1, to: 4 },
      userEvent: 'delete.selection',
    });
    expect(tr.docChanged).toBe(true);
  });

  it('passes typed or pasted text that holds a U+FFFC', () => {
    const state = make(lines, holes, { anchor: 5 });
    const typed = state.update({
      changes: { from: 5, insert: P },
      userEvent: 'input.paste',
    });
    expect(typed.docChanged).toBe(true);
  });
});

describe('the line-text filter', () => {
  const doc = [`ab${P}`, 'cd', `${P}ef`, 'gh', 'ij'];
  const holes = [hole(0, 2, 6), hole(2, 0, 6)];
  const at = (state: EditorState, line: number, col = 0): number =>
    state.doc.line(line + 1).from + col;
  const withCaret = (line: number, col = 0): EditorState => {
    const probe = make(doc, holes);
    return make(doc, holes, { anchor: at(probe, line, col) });
  };
  // From the start of line `from` to column `col` of line `to`.
  const withRange = (from: number, to: number, col = 1): EditorState => {
    const probe = make(doc, holes);
    return make(doc, holes, {
      anchor: at(probe, from),
      head: at(probe, to, col),
    });
  };
  const changed = (state: EditorState, command: Command): boolean =>
    run(state, command)?.docChanged === true;

  it('refuses Copy Line Down on a line with a hole', () => {
    expect(changed(withCaret(0), copyLineDown)).toBe(false);
  });

  it('refuses Copy Line Down on a block whose last line has a hole', () => {
    expect(changed(withRange(1, 2), copyLineDown)).toBe(false);
  });

  it('refuses Copy Line Up on a block whose first line has a hole', () => {
    expect(changed(withRange(2, 3), copyLineUp)).toBe(false);
  });

  it('refuses Move Line Up on a line whose upper neighbour has a hole', () => {
    expect(changed(withCaret(1), moveLineUp)).toBe(false);
  });

  it('refuses Move Line Down onto a lower neighbour with a hole', () => {
    expect(changed(withCaret(1), moveLineDown)).toBe(false);
  });

  it('refuses a transpose at the start of a line after a line with a right hole', () => {
    expect(changed(withCaret(1, 0), transposeChars)).toBe(false);
  });

  it('refuses a transpose with the caret right after a left placeholder', () => {
    expect(changed(withCaret(2, 1), transposeChars)).toBe(false);
  });

  it('lets the same commands act on lines with no hole', () => {
    expect(changed(withCaret(3), copyLineDown)).toBe(true);
    expect(changed(withCaret(3), moveLineDown)).toBe(true);
    expect(changed(withCaret(4, 1), transposeChars)).toBe(true);
  });
});

describe('the drop filter', () => {
  it('refuses a move that removes a placeholder', () => {
    const doc = Text.of([`ab${P}cd`, 'xy']);
    const state = EditorState.create({
      doc,
      selection: { anchor: 1, head: 4 },
      extensions: holeExtensions(
        holeSetOf(doc, [hole(0, 2, 6)], (b) => `${b} B`),
        null,
        { onMarker: () => {} },
      ),
    });
    const moved = state.update({
      changes: [
        { from: 1, to: 4 },
        { from: 7, insert: 'bP' },
      ],
      userEvent: 'move.drop',
    });
    expect(moved.docChanged).toBe(false);
    const copied = state.update({
      changes: { from: 7, insert: 'bP' },
      userEvent: 'input.drop',
    });
    expect(copied.docChanged).toBe(true);
  });
});

describe('the drag decision', () => {
  const lines = [`ab${P}cd`];
  const holes = [hole(0, 2, 6)];

  it('refuses a selection that holds a placeholder', () => {
    expect(dragRefused(make(lines, holes, { anchor: 1, head: 4 }), false)).toBe(
      true,
    );
  });

  it('refuses a selection with an end in a part not loaded', () => {
    expect(dragRefused(make(lines, holes, { anchor: 3, head: 5 }), true)).toBe(
      true,
    );
  });

  it('lets a selection of loaded text be dragged', () => {
    expect(dragRefused(make(lines, holes, { anchor: 3, head: 5 }), false)).toBe(
      false,
    );
    expect(dragRefused(make(lines, holes, { anchor: 3 }), false)).toBe(false);
  });
});

describe('the Replace match', () => {
  const lines = [`one ${P} two`];
  const holes = [hole(0, 4, 6)];

  it('is the range of a selection that matches the query', () => {
    const state = make(lines, holes, { anchor: 0, head: 3 });
    expect(replaceTarget(state, 'ONE', false)).toEqual({ from: 0, to: 3 });
    expect(replaceTarget(state, 'ONE', true)).toBeNull();
  });

  it('is nothing for a caret or a text that does not match', () => {
    expect(
      replaceTarget(make(lines, holes, { anchor: 1 }), 'one', false),
    ).toBeNull();
    expect(
      replaceTarget(make(lines, holes, { anchor: 0, head: 3 }), 'two', false),
    ).toBeNull();
  });

  it('is nothing for a range that holds a placeholder, whatever its loaded text says', () => {
    const state = make(lines, holes, { anchor: 0, head: 5 });
    expect(replaceTarget(state, `one ${P}`, false)).toBeNull();
  });
});

describe('where the hole of a kept marker is', () => {
  // `¤mid¤` with 9 bytes hidden before and 11 after, and a second line.
  const state = make(
    [`${P}mid${P}`, `a${P}b`],
    [hole(0, 0, 7, { bytes: 9 }), hole(0, 4, 8, { bytes: 11 }), hole(1, 1, 3)],
  );

  it('names the line and the byte a hole starts at', () => {
    expect(markerStart(state, 0, 700)).toEqual({ line: 700, start: 0 });
    expect(markerStart(state, 4, 700)).toEqual({ line: 700, start: 9 + 3 });
    expect(markerStart(state, state.doc.line(2).from + 1, 700)).toEqual({
      line: 701,
      start: 1,
    });
    expect(markerStart(state, 2, 700)).toBeNull();
  });

  it('finds the placeholder that starts at a byte again', () => {
    expect(markerAtByte(state, 700, 700, 0)).toBe(0);
    expect(markerAtByte(state, 700, 700, 12)).toBe(4);
    expect(markerAtByte(state, 701, 700, 1)).toBe(state.doc.line(2).from + 1);
  });

  it('finds none for a byte no hole starts at or a line outside the window', () => {
    expect(markerAtByte(state, 700, 700, 5)).toBeNull();
    expect(markerAtByte(state, 699, 700, 0)).toBeNull();
    expect(markerAtByte(state, 702, 700, 0)).toBeNull();
  });
});

describe('the list of kept requests', () => {
  const goto: KeptRequest = { kind: 'goto', line: 40 };
  const panel: KeptRequest = {
    kind: 'panel',
    target: { kind: 'range', range: { start: 3, end: 9 } },
  };
  const hit: KeptRequest = { kind: 'find', backward: true };
  const result: KeptRequest = { kind: 'result', index: 2 };
  const replace: KeptRequest = { kind: 'replace' };
  const marker: KeptRequest = {
    kind: 'marker',
    line: 700,
    start: 12,
    installs: 3,
  };

  it('keeps each kind of request in the form it was made while composing', () => {
    let list: readonly KeptRequest[] = [];
    for (const request of [goto, panel, hit, result, replace, marker]) {
      const next = keptRequest(list, request, true);
      expect(next.kept).toBe(true);
      list = next.list;
    }
    expect(list).toEqual([goto, panel, hit, result, replace, marker]);
  });

  it('keeps nothing when no composition is open, so the request runs now', () => {
    const list = [goto];
    const next = keptRequest(list, replace, false);
    expect(next).toEqual({ kept: false, list });
    expect(next.list).toBe(list);
  });

  it('never keeps a request the list itself runs', () => {
    const list = [goto];
    const next = keptRequest(list, replace, true, true);
    expect(next).toEqual({ kept: false, list });
  });

  it('leaves the list it was given as it was', () => {
    const list: readonly KeptRequest[] = [goto];
    keptRequest(list, replace, true);
    expect(list).toEqual([goto]);
  });

  it('knows no kind for the jump an undo makes', () => {
    const kinds = [goto, panel, hit, result, replace, marker].map(
      (r) => r.kind,
    );
    expect(kinds).not.toContain('undo');
    expect(kinds).not.toContain('jump');
  });

  const idle = {
    gone: false,
    locked: false,
    composing: false,
    capturing: false,
    released: false,
    renewed: false,
    held: false,
  };

  it('runs the first request when nothing holds the editor', () => {
    expect(keptListStep(idle)).toBe('run');
  });

  it('retries when a hold keeps the editor busy', () => {
    expect(keptListStep({ ...idle, held: true })).toBe('retry');
  });

  it('drops the list for a locked or gone editor, whatever else holds', () => {
    expect(keptListStep({ ...idle, locked: true, held: true })).toBe('drop');
    expect(keptListStep({ ...idle, gone: true, composing: true })).toBe('drop');
  });

  it('waits again when a new composition has begun', () => {
    expect(keptListStep({ ...idle, composing: true })).toBe('wait');
    expect(keptListStep({ ...idle, composing: true, held: true })).toBe('wait');
  });

  it('waits for a capture that is open even for a released list', () => {
    expect(keptListStep({ ...idle, capturing: true })).toBe('wait');
    expect(keptListStep({ ...idle, capturing: true, released: true })).toBe(
      'wait',
    );
  });

  it('runs a list released without a compositionend although the view still composes', () => {
    expect(keptListStep({ ...idle, composing: true, released: true })).toBe(
      'run',
    );
  });

  it('waits for a composition begun after the release, not for the stale flag', () => {
    const released = { ...idle, composing: true, released: true };
    expect(keptListStep(released)).toBe('run');
    expect(keptListStep({ ...released, renewed: true })).toBe('wait');
    expect(keptListStep({ ...idle, released: true, renewed: true })).toBe(
      'run',
    );
  });

  it('keeps a marker whose window is still installed and whose hole is there', () => {
    const state = make(
      [`${P}mid${P}`],
      [hole(0, 0, 7, { bytes: 9 }), hole(0, 4, 8, { bytes: 11 })],
    );
    const kept: Extract<KeptRequest, { kind: 'marker' }> = {
      kind: 'marker',
      line: 700,
      start: 12,
      installs: 3,
    };
    expect(keptMarkerPos(kept, state, 700, 3)).toBe(4);
  });

  it('drops a marker once a window has been installed since', () => {
    const state = make([`${P}mid`], [hole(0, 0, 7, { bytes: 9 })]);
    const kept: Extract<KeptRequest, { kind: 'marker' }> = {
      kind: 'marker',
      line: 700,
      start: 0,
      installs: 3,
    };
    expect(keptMarkerPos(kept, state, 700, 3)).toBe(0);
    expect(keptMarkerPos(kept, state, 700, 4)).toBeNull();
  });

  it('drops a marker whose hole is gone', () => {
    const state = make(['mid'], []);
    const kept: Extract<KeptRequest, { kind: 'marker' }> = {
      kind: 'marker',
      line: 700,
      start: 0,
      installs: 3,
    };
    expect(keptMarkerPos(kept, state, 700, 3)).toBeNull();
  });
});

describe("the queue's head key at a caret next to a part not loaded", () => {
  const own = {
    closeBox: () => false,
    selectVisible: () => true,
    undo: () => true,
    redo: () => true,
  };
  const { normal, offscreen } = buildKeymap('windowed', 'macos', () => null);
  const layers = [offscreen, coreKeyBindings(own), normal];
  const keyEvent = (key: string, keyCode: number) => ({
    key,
    keyCode,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
  });
  const backspace = commandChain(layers, keyEvent('Backspace', 8), 'macos');
  // Window from global line 200: `¤abc` with the caret right after the marker.
  const state = (readFor: LineSelection | null): EditorState => {
    const doc = Text.of([`${P}abc`]);
    return EditorState.create({
      doc,
      extensions: holeExtensions(
        holeSetOf(doc, [hole(0, 0, 6)], (b) => `${b} B`),
        readFor,
        { onMarker: () => {} },
      ),
    });
  };
  const caret: LineSelection = {
    anchor: { line: 200, col: 6 },
    head: { line: 200, col: 6 },
  };
  const startLine = 200;
  function stepsFor(readFor: LineSelection | null, holds = 0) {
    const view = state(readFor);
    const holes = windowHoles(view, startLine);
    const decision: ReachDecision = reachDecision(
      view,
      deleteCharBackward,
      caret,
      readFor,
      edge(view),
      startLine,
    );
    const win = { startLine, lineCount: 1, holes };
    const ready = replayReady(caret, startLine, 1, holes, decision);
    const input = {
      item: { kind: 'key' } as const,
      sel: caret,
      commands: backspace,
      panelOpen: false,
      own,
      headMapping: false,
      ready,
      decision,
      totalLines: 9000,
      win,
    };
    return {
      decision,
      drain: dequeueStep({ ...input, swapping: false, holds }),
      shadow: shadowStep(input),
    };
  }

  it('swaps to read the window around the caret, in the drain and in the shadow', () => {
    const r = stepsFor(null);
    expect(r.decision).toBe('reload');
    expect(r.drain.step).toBe('swap');
    expect(r.shadow.step).toBe('swap');
  });

  it('drops the key once the window was read for the caret, and never swaps again', () => {
    const r = stepsFor(caret);
    expect(r.decision).toBe('refuse');
    expect(r.drain.step).toBe('drop');
    expect(r.shadow.step).toBe('drop');
  });

  it('waits behind a hold, as every other step does', () => {
    expect(stepsFor(caret, 1).drain.step).toBe('wait');
    expect(stepsFor(null, 1).drain.step).toBe('wait');
  });

  it('never swaps for a caret the window was read for, whichever delete key it is', () => {
    for (const command of REACHING_DELETES) {
      const view = state(caret);
      const decision = reachDecision(
        view,
        command,
        caret,
        caret,
        edge(view),
        startLine,
      );
      expect(decision).not.toBe('reload');
    }
  });
});

describe('running the list of kept requests', () => {
  const requests: KeptRequest[] = [
    { kind: 'goto', line: 1 },
    { kind: 'replace' },
    { kind: 'find', backward: false },
  ];
  // A host whose editor is idle, recording what it ran and when.
  function host(over: Partial<KeptHost> = {}) {
    let list: readonly KeptRequest[] = requests;
    const log: string[] = [];
    const h: KeptHost = {
      get: () => list,
      set: (next) => {
        list = next;
      },
      settled: async () => {
        log.push('settled');
        return true;
      },
      gone: () => false,
      locked: () => false,
      held: () => false,
      composing: () => false,
      capturing: () => false,
      renewed: () => false,
      run: async (request) => {
        log.push(request.kind);
      },
      ...over,
    };
    return { h, log, left: () => list };
  }

  it('runs every request once, in order, each after the editor has settled', async () => {
    const { h, log, left } = host();
    await runKeptList(h, false);
    expect(log).toEqual([
      'settled',
      'goto',
      'settled',
      'replace',
      'settled',
      'find',
    ]);
    expect(left()).toEqual([]);
    await runKeptList(h, false);
    expect(log).toHaveLength(6);
  });

  it('starts the next request only once the one before has finished', async () => {
    const order: string[] = [];
    let finish: () => void = () => {};
    const { h } = host({
      run: async (request) => {
        order.push(`start ${request.kind}`);
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        order.push(`end ${request.kind}`);
      },
    });
    const done = runKeptList(h, false);
    await vi.waitFor(() => expect(order).toEqual(['start goto']));
    finish();
    await vi.waitFor(() =>
      expect(order).toEqual(['start goto', 'end goto', 'start replace']),
    );
    finish();
    finish = () => {};
    await vi.waitFor(() => expect(order).toContain('start find'));
    finish();
    await done;
  });

  it('keeps the list for a hold to release, and runs it then', async () => {
    let busy = true;
    const { h, log, left } = host({
      settled: async () => !busy,
      held: () => busy,
    });
    await runKeptList(h, false);
    expect(log).toEqual([]);
    expect(left()).toEqual(requests);
    busy = false;
    await runKeptList(h, false);
    expect(log).toEqual(['goto', 'replace', 'find']);
  });

  it('drops the list for a locked editor and for a gone one', async () => {
    const locked = host({ settled: async () => false, locked: () => true });
    await runKeptList(locked.h, false);
    expect(locked.left()).toEqual([]);
    expect(locked.log).toEqual([]);
    const gone = host({ settled: async () => false, gone: () => true });
    await runKeptList(gone.h, false);
    expect(gone.left()).toEqual([]);
  });

  it('waits while a new composition is open, and runs when it has ended', async () => {
    let composing = true;
    const { h, log, left } = host({ composing: () => composing });
    await runKeptList(h, false);
    expect(log).toEqual(['settled']);
    expect(left()).toEqual(requests);
    composing = false;
    await runKeptList(h, false);
    expect(log.filter((e) => e !== 'settled')).toEqual([
      'goto',
      'replace',
      'find',
    ]);
  });

  it('waits for a capture whether the list was released or not', async () => {
    const { h, left } = host({ capturing: () => true });
    await runKeptList(h, true);
    expect(left()).toEqual(requests);
  });

  it('runs a released list although the view still says it composes', async () => {
    const { h, left } = host({ composing: () => true });
    await runKeptList(h, true);
    expect(left()).toEqual([]);
  });

  // A run function as the editor writes them: it begins by keeping its request
  // while a composition is open, unless the list is running it.
  function rekeeping(composing: () => boolean, ran: string[]): KeptHost {
    const { h } = host();
    let list: readonly KeptRequest[] = requests;
    return {
      ...h,
      get: () => list,
      set: (next) => {
        list = next;
      },
      composing,
      run: async (request) => {
        ran.push(request.kind);
        if (ran.length > 50) {
          throw new Error('runaway');
        }
        list = keptRequest(list, request, composing(), true).list;
      },
    };
  }

  it('runs each request once although the view still says it composes', async () => {
    const ran: string[] = [];
    await runKeptList(
      rekeeping(() => true, ran),
      true,
    );
    expect(ran).toEqual(['goto', 'replace', 'find']);
  });

  it('runs each request once for an unreleased list too', async () => {
    const ran: string[] = [];
    await runKeptList(
      rekeeping(() => false, ran),
      false,
    );
    expect(ran).toEqual(['goto', 'replace', 'find']);
  });

  it('waits for a composition begun since the release, then runs once', async () => {
    let composing = true;
    const ran: string[] = [];
    const wired = { ...rekeeping(() => composing, ran), renewed: () => true };
    await runKeptList(wired, true);
    expect(ran).toEqual([]);
    expect(wired.get()).toEqual(requests);
    composing = false;
    await runKeptList(wired, true);
    expect(ran).toEqual(['goto', 'replace', 'find']);
  });

  it('stops where a request starts a new composition', async () => {
    let composing = false;
    const { h, left } = host({
      composing: () => composing,
      run: async (request) => {
        composing = request.kind === 'goto';
      },
    });
    await runKeptList(h, false);
    expect(left()).toEqual(requests.slice(1));
  });
});

describe('a replayed key the reaching-delete path queued', () => {
  it('runs its recorded command only when nothing else handled it', () => {
    expect(runsRecordedCommand(false, true, 0)).toBe(true);
    expect(runsRecordedCommand(true, true, 0)).toBe(false);
    expect(runsRecordedCommand(false, true, 2)).toBe(false);
  });

  it('leaves every other replayed key as it was', () => {
    expect(runsRecordedCommand(false, false, 0)).toBe(false);
  });
});

describe('where a part shown at the end of its hole ends', () => {
  it('is just before the right placeholder', () => {
    const state = make(
      [`${PLACEHOLDER}abc${PLACEHOLDER}`],
      [hole(0, 0, 5), hole(0, 4, 7)],
    );
    expect(newPartEnd(state, state.doc.line(1))).toBe(4);
  });

  it('is the line end when the line has no right placeholder', () => {
    const state = make([`${PLACEHOLDER}abc`, 'x'], [hole(0, 0, 5)]);
    expect(newPartEnd(state, state.doc.line(1))).toBe(4);
    const empty = make(['', 'x'], []);
    expect(newPartEnd(empty, empty.doc.line(1))).toBe(0);
  });

  it('ignores a hole that is not at the line end', () => {
    const state = make([`ab${PLACEHOLDER}cd`], [hole(0, 2, 5)]);
    expect(newPartEnd(state, state.doc.line(1))).toBe(5);
  });
});

describe('the timer of the kept requests', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the list once, the delay after it was asked for', () => {
    vi.useFakeTimers();
    const runs: boolean[] = [];
    const timer = keptSchedule((released) => runs.push(released));
    timer.schedule(100, false);
    vi.advanceTimersByTime(99);
    expect(runs).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(runs).toEqual([false]);
    vi.advanceTimersByTime(1000);
    expect(runs).toEqual([false]);
  });

  it('makes one run of several asks, released when any was', () => {
    vi.useFakeTimers();
    const runs: boolean[] = [];
    const timer = keptSchedule((released) => runs.push(released));
    timer.schedule(100, false);
    timer.schedule(0, true);
    timer.schedule(100, false);
    vi.advanceTimersByTime(100);
    expect(runs).toEqual([true]);
    timer.schedule(100, false);
    vi.advanceTimersByTime(100);
    expect(runs).toEqual([true, false]);
  });

  it('runs nothing once it is cancelled', () => {
    vi.useFakeTimers();
    const runs: boolean[] = [];
    const timer = keptSchedule((released) => runs.push(released));
    timer.schedule(100, false);
    timer.cancel();
    timer.schedule(100, false);
    vi.advanceTimersByTime(500);
    expect(runs).toEqual([]);
  });
});
