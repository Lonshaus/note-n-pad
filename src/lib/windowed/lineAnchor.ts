// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Keeps the caret in view while CodeMirror redraws a very long wrapped line.
// It stands the undrawn parts of such a line in for gaps whose heights are
// re-estimated after every scroll, and its scroll anchor (the line block at the
// top of the viewport) cannot compensate a shift inside one line.
import type { ChangeDesc, Text } from '@codemirror/state';
/** CodeMirror draws a line in gaps from this many characters on (twice its wrap
 *  margin of 10,000). */
export const GAP_LINE_CHARS = 20000;
/** Whether a line of `doc` that overlaps `[from, to]` has `GAP_LINE_CHARS`
 *  characters or more. */
export function hasGapLine(doc: Text, from: number, to: number): boolean {
  let pos = from;
  while (pos <= to) {
    const line = doc.lineAt(pos);
    if (line.length >= GAP_LINE_CHARS) {
      return true;
    }
    pos = line.to + 1;
  }
  return false;
}
/** Whether any line of `doc` has `GAP_LINE_CHARS` characters or more. */
export function docHasGapLine(doc: Text): boolean {
  for (const line of doc.iterLines()) {
    if (line.length >= GAP_LINE_CHARS) {
      return true;
    }
  }
  return false;
}
/** Whether `newDoc` has a gap line, given that `oldDoc` had one iff `before`.
 *  Only the lines `changes` touched are read; `rescan` runs only when a touched
 *  gap line left no gap line among the lines that replaced it. */
export function gapLineAfter(input: {
  before: boolean;
  oldDoc: Text;
  newDoc: Text;
  changes: ChangeDesc;
  rescan: (doc: Text) => boolean;
}): boolean {
  let newSide = false;
  let oldSide = false;
  input.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (hasGapLine(input.newDoc, fromB, toB)) {
      newSide = true;
    }
    if (input.before && hasGapLine(input.oldDoc, fromA, toA)) {
      oldSide = true;
    }
  });
  if (newSide) {
    return true;
  }
  return oldSide ? input.rescan(input.newDoc) : input.before;
}
/** Whether a scroll to the caret starts, or keeps, the anchor: the window holds
 *  a line CodeMirror draws in gaps, whose redraw can move the text below it. */
export function anchorArms(input: {
  wrapping: boolean;
  windowHasGapLine: boolean;
  scrolled: boolean;
}): boolean {
  return input.wrapping && input.scrolled && input.windowHasGapLine;
}
/** How far the find panel, which floats over the bottom of the editor, covers
 *  it: its height while open. */
export function panelInset(panelOpen: boolean, panelHeight: number): number {
  return panelOpen ? panelHeight : 0;
}
/** Whether the find panel growing from `before` to `after` px covers a caret
 *  that was fully shown above it. Null coordinates: not drawn. */
export function panelGrowthCovers(input: {
  caretTop: number | null;
  caretBottom: number | null;
  viewTop: number;
  viewBottom: number;
  before: number;
  after: number;
}): boolean {
  if (input.caretTop === null || input.caretBottom === null) {
    return false;
  }
  return (
    input.caretTop >= input.viewTop &&
    input.caretBottom <= input.viewBottom - input.before &&
    input.caretBottom > input.viewBottom - input.after
  );
}

export type AnchorStep =
  { kind: 'none' } | { kind: 'scroll'; by: number } | { kind: 'reveal' };
/** What the anchor does about the caret's coordinates. `caretTop` and
 *  `caretBottom` are null while the position is not drawn. `by` is how far
 *  `scrollTop` moves. */
export function anchorStep(input: {
  armed: boolean;
  caretTop: number | null;
  caretBottom: number | null;
  viewTop: number;
  viewBottom: number;
  margin: number;
}): AnchorStep {
  if (!input.armed) {
    return { kind: 'none' };
  }
  if (input.caretTop === null || input.caretBottom === null) {
    return { kind: 'reveal' };
  }
  const above = input.caretTop - (input.viewTop + input.margin);
  if (above < 0) {
    return { kind: 'scroll', by: above };
  }
  const below = input.caretBottom - (input.viewBottom - input.margin);
  if (below > 0) {
    return { kind: 'scroll', by: below };
  }
  return { kind: 'none' };
}

export type AnchorEvent =
  | 'wheel'
  | 'touch'
  | 'scrollbar'
  | 'pointer'
  | 'install'
  | 'blur'
  | 'wrapOff'
  | 'leftLine'
  | 'rearmFalse'
  | 'viewport'
  | 'height';
/** Whether the event ends the anchor. A redraw of the line (viewport or height)
 *  is what the anchor corrects, so it never does. */
export function anchorDisarms(event: AnchorEvent): boolean {
  return event !== 'viewport' && event !== 'height';
}
/** Whether a scroll may load the neighbouring window. Not while a press on the
 *  scroll bar is held over a window with a gap line and word wrap on (the height
 *  map is re-estimated mid-drag), and not while the anchor is armed on a gap
 *  line or a gap line is on screen. The last two count only while armed. */
export function swapAllowed(input: {
  armed: boolean;
  anchoredOnGapLine: boolean;
  gapLineInViewport: boolean;
  scrollbarHeld: boolean;
  gapLineInWindow: boolean;
  wrapping: boolean;
}): boolean {
  if (input.scrollbarHeld && input.wrapping && input.gapLineInWindow) {
    return false;
  }
  return !(input.armed && (input.anchoredOnGapLine || input.gapLineInViewport));
}
export type HeldEvent =
  | 'pointerup'
  | 'pointercancel'
  | 'wheel'
  | 'keydown'
  | 'pointerdown'
  | 'idle'
  | 'scroll';
/** Whether the event ends the hold of a press on the scroll bar; a scroll keeps
 *  it (and restarts its idle timer). */
export function heldEnds(event: HeldEvent): boolean {
  return event !== 'scroll';
}
