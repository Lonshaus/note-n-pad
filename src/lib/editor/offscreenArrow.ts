// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Up and Down (with and without Shift) while a caret is outside the lines
// CodeMirror has rendered. Its vertical move asks for the position at a screen
// point and skips every line whose coordinates are unknown, so from an
// off-screen caret it lands on the first rendered line, far from the caret.
// The main caret is first scrolled into view and then moved by the stock
// vertical move, so it goes by visual row (a wrapped line included). Another
// caret that is still off-screen goes by text line instead.

import { EditorSelection, type SelectionRange } from '@codemirror/state';
import { EditorView, type Command, type KeyBinding } from '@codemirror/view';
/** A text line's document offsets. */
export interface TextLine {
  from: number;
  to: number;
}

export interface OffscreenTarget {
  pos: number;
  goalColumn: number | undefined;
}
/** How many measure passes the move waits for the scroll to render the main
 *  caret's line before it moves that caret by text line like the others. */
const MAX_MEASURE_WAITS = 3;
/** Where the head goes when it moves one text line. `adjacent` is the line
 *  above or below `current`, or null at the document edge, where the head goes
 *  to the edge of its own line. The column is counted in characters. The goal
 *  column is in pixels, so it is passed through unchanged and never set from
 *  the character column: when it is unset CodeMirror measures it on the next
 *  move. */
export function offscreenLineTarget(
  head: number,
  goalColumn: number | undefined,
  current: TextLine,
  adjacent: TextLine | null,
  forward: boolean,
): OffscreenTarget {
  if (adjacent === null) {
    return { pos: forward ? current.to : current.from, goalColumn };
  }
  const column = head - current.from;
  return { pos: Math.min(adjacent.from + column, adjacent.to), goalColumn };
}
/** `pos` moved out of any atomic range (a folded region, a widget) it falls
 *  strictly inside, to the edge in the direction of travel. Same rule as the
 *  stock vertical move. */
function skipAtomic(view: EditorView, pos: number, forward: boolean): number {
  const atoms = view.state
    .facet(EditorView.atomicRanges)
    .map((source) => source(view));
  for (;;) {
    let moved = false;
    for (const set of atoms) {
      set.between(pos - 1, pos + 1, (from, to) => {
        if (pos > from && pos < to) {
          pos = forward ? to : from;
          moved = true;
        }
      });
    }
    if (!moved) {
      return pos;
    }
  }
}

function moveByTextLine(
  view: EditorView,
  range: SelectionRange,
  forward: boolean,
  extend: boolean,
): SelectionRange {
  const { doc } = view.state;
  const line = doc.lineAt(range.head);
  const next = forward ? line.number + 1 : line.number - 1;
  const target = offscreenLineTarget(
    range.head,
    range.goalColumn,
    line,
    next >= 1 && next <= doc.lines ? doc.line(next) : null,
    forward,
  );
  const pos = skipAtomic(view, target.pos, forward);
  const assoc = pos === target.pos ? 0 : pos < target.pos ? 1 : -1;
  return extend
    ? EditorSelection.range(range.anchor, pos, target.goalColumn)
    : EditorSelection.cursor(pos, assoc, undefined, target.goalColumn);
}
/** The stock `cursorLineUp/Down` and `selectLineUp/Down` for one range. */
function moveByStock(
  view: EditorView,
  range: SelectionRange,
  forward: boolean,
  extend: boolean,
): SelectionRange {
  if (!extend) {
    if (!range.empty) {
      return EditorSelection.cursor(forward ? range.to : range.from);
    }
    const moved = view.moveVertically(range, forward);
    return moved.head !== range.head
      ? moved
      : view.moveToLineBoundary(range, forward);
  }
  if (range.undirectional && range.head >= range.anchor !== forward) {
    range = EditorSelection.range(range.head, range.anchor);
  }
  const head = view.moveVertically(range, forward);
  return EditorSelection.range(
    range.anchor,
    head.head,
    head.goalColumn,
    head.bidiLevel || undefined,
    head.assoc,
  );
}

function moveRange(
  view: EditorView,
  range: SelectionRange,
  forward: boolean,
  extend: boolean,
): SelectionRange {
  if (isRendered(view.viewport, range)) {
    return moveByStock(view, range, forward, extend);
  }
  if (!extend && !range.empty) {
    return EditorSelection.cursor(forward ? range.to : range.from);
  }
  // Same as the stock select commands: an undirectional range first takes the
  // direction of the move.
  if (extend && range.undirectional && range.head >= range.anchor !== forward) {
    range = EditorSelection.range(range.head, range.anchor);
  }
  return moveByTextLine(view, range, forward, extend);
}

function isRendered(
  viewport: { from: number; to: number },
  range: SelectionRange,
): boolean {
  return range.head >= viewport.from && range.head <= viewport.to;
}

function moveAll(view: EditorView, forward: boolean, extend: boolean): void {
  const { state } = view;
  const { selection } = state;
  const moved = EditorSelection.create(
    selection.ranges.map((range) => moveRange(view, range, forward, extend)),
    selection.mainIndex,
  );
  if (!moved.eq(selection)) {
    view.dispatch(
      state.update({
        selection: moved,
        scrollIntoView: true,
        userEvent: 'select',
      }),
    );
  }
}
/** Run `run` once the scroll requested so far has been measured and, with it,
 *  the main caret's line rendered. */
function afterMeasure(view: EditorView, run: () => void, waits = 0): void {
  view.requestMeasure({
    read: () => null,
    write: () => {
      if (
        waits < MAX_MEASURE_WAITS &&
        !isRendered(view.viewport, view.state.selection.main)
      ) {
        afterMeasure(view, run, waits + 1);
      } else {
        // The editor refuses layout reads while this update is still running.
        queueMicrotask(run);
      }
    },
  });
}

function offscreenLine(forward: boolean, extend: boolean): Command {
  return (view) => {
    const { selection } = view.state;
    // Every head inside the rendered range leaves the key to the stock command.
    if (selection.ranges.every((range) => isRendered(view.viewport, range))) {
      return false;
    }
    if (isRendered(view.viewport, selection.main)) {
      moveAll(view, forward, extend);
    } else {
      view.dispatch({
        effects: EditorView.scrollIntoView(selection.main.head),
      });
      afterMeasure(view, () => moveAll(view, forward, extend));
    }
    return true;
  };
}
/** ArrowUp and ArrowDown, to be bound above the stock ones. */
export const offscreenArrowKeys: readonly KeyBinding[] = [
  {
    key: 'ArrowUp',
    run: offscreenLine(false, false),
    shift: offscreenLine(false, true),
  },
  {
    key: 'ArrowDown',
    run: offscreenLine(true, false),
    shift: offscreenLine(true, true),
  },
];
