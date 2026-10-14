// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Pure model of a selection that outlives the sliding window: the editor keeps
 *  the selection's global ends, and only the part inside the loaded window is
 *  live in CodeMirror. Free of CodeMirror/Tauri so it unit-tests in isolation. */
/** A position as a 0-based line and a character column. The line is global in a
 *  global selection and window-local in a live one. */
export interface LinePos {
  line: number;
  col: number;
}

export interface LineSelection {
  anchor: LinePos;
  head: LinePos;
}
/** The loaded window: its first global line, its line count and the length of
 *  each window-local line. */
export interface WindowShape {
  startLine: number;
  lineCount: number;
  lineLength: (local: number) => number;
}

function samePos(a: LinePos, b: LinePos): boolean {
  return a.line === b.line && a.col === b.col;
}

function toLivePos(pos: LinePos, win: WindowShape): LinePos {
  const local = pos.line - win.startLine;
  if (local < 0) {
    return { line: 0, col: 0 };
  }
  if (local >= win.lineCount) {
    const last = win.lineCount - 1;
    return { line: last, col: win.lineLength(last) };
  }
  return { line: local, col: Math.min(pos.col, win.lineLength(local)) };
}

function toGlobalPos(pos: LinePos, startLine: number): LinePos {
  return { line: pos.line + startLine, col: pos.col };
}
/** The global selection intersected with the window: an end outside it sits on
 *  the window edge on its side, so a selection entirely outside becomes a caret
 *  at the nearest edge. */
export function toLiveSelection(
  global: LineSelection,
  win: WindowShape,
): LineSelection {
  return {
    anchor: toLivePos(global.anchor, win),
    head: toLivePos(global.head, win),
  };
}

export function toGlobalSelection(
  live: LineSelection,
  startLine: number,
): LineSelection {
  return {
    anchor: toGlobalPos(live.anchor, startLine),
    head: toGlobalPos(live.head, startLine),
  };
}
/** A window swap: the live selection for the new window. The global selection
 *  is returned unchanged, so a later swap can bring the clamped ends back. */
export function selectionAfterSwap(
  global: LineSelection,
  win: WindowShape,
): { live: LineSelection; global: LineSelection } {
  return { live: toLiveSelection(global, win), global };
}
/** A caret at the start of a global line: the selection after a goto swap. */
export function gotoSelection(line: number): LineSelection {
  const pos = { line, col: 0 };
  return { anchor: pos, head: pos };
}
/** The global selection after the live one changed inside the window. A document
 *  change replaces it with the live selection. A pure selection change replaces
 *  each end the user moved; an end left where it was keeps its remembered global
 *  position, which may lie outside the window. A range collapsing to a caret
 *  drops the remembered ends, since an arrow key collapsing onto a clamped edge
 *  leaves that end unmoved. */
export function selectionAfterChange(
  global: LineSelection,
  prevLive: LineSelection,
  nextLive: LineSelection,
  startLine: number,
  docChanged: boolean,
): LineSelection {
  const next = toGlobalSelection(nextLive, startLine);
  const collapsed =
    !samePos(prevLive.anchor, prevLive.head) &&
    samePos(nextLive.anchor, nextLive.head);
  if (docChanged || collapsed) {
    return next;
  }
  return {
    anchor: samePos(prevLive.anchor, nextLive.anchor)
      ? global.anchor
      : next.anchor,
    head: samePos(prevLive.head, nextLive.head) ? global.head : next.head,
  };
}
