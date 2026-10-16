// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
import { MARGIN_LINES, WINDOW_LINES } from './windowedEdit';
import type { LinePos, LineSelection } from './windowSelection';
/** Pure helpers for find, replace and go-to-line in the editing mode of a large
 *  file. The search itself runs in the Rust core; these turn its answers into
 *  the global selection the editor keeps. Free of Svelte and Tauri so they
 *  unit-test in isolation. */
/** A match from the core: where it starts and ends as 0-based line and UTF-16
 *  column (CodeMirror's unit). */
export interface FindHit {
  start: LinePos;
  end: LinePos;
}
/** The selection that covers a hit, anchored at its start. */
export function hitSelection(hit: FindHit): LineSelection {
  return {
    anchor: { line: hit.start.line, col: hit.start.col },
    head: { line: hit.end.line, col: hit.end.col },
  };
}
/** Where a match of `needle` starting at `start` ends. Columns count UTF-16
 *  units, and a newline in the needle moves the end to a later line. */
export function endOfMatch(start: LinePos, needle: string): LinePos {
  const parts = needle.split('\n');
  const last = parts[parts.length - 1] ?? '';
  if (parts.length === 1) {
    return { line: start.line, col: start.col + needle.length };
  }
  return { line: start.line + parts.length - 1, col: last.length };
}
/** Whether `text` is a match for `query`: byte for byte, or with ASCII letters
 *  folded when the search ignores case. This is the core's matching rule
 *  (non-ASCII letters compare as they are), so a selection the core found
 *  still matches until the text under it changes. */
export function textMatchesQuery(
  text: string,
  query: string,
  caseSensitive: boolean,
): boolean {
  if (query === '' || text.length !== query.length) {
    return false;
  }
  if (caseSensitive) {
    return text === query;
  }
  const fold = (s: string): string =>
    s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return fold(text) === fold(query);
}
/** The most lines one window can hold a selection across, with its margins. */
export const MAX_SELECTION_SPAN = WINDOW_LINES - 2 * MARGIN_LINES;
/** The selection for "go to lines A-B" (0-based, inclusive): it spans whole
 *  lines but only as many as one window holds, so it can be shown and edited.
 *  The head sits at the start so revealing the selection shows its first line.
 *  A column past the end of a line clamps to that line's end. */
export function gotoRangeSelection(start: number, end: number): LineSelection {
  const last = Math.min(end, start + MAX_SELECTION_SPAN);
  return {
    anchor: { line: last, col: Number.MAX_SAFE_INTEGER },
    head: { line: start, col: 0 },
  };
}
/** `template` (the "Replaced $ matches" phrase) with `$` set to `count`. */
export function formatReplaced(template: string, count: number): string {
  return template.replace('$', String(count));
}
/** The smaller and larger of two positions, in document order. */
export function orderedPositions(sel: LineSelection): {
  first: LinePos;
  last: LinePos;
} {
  const { anchor, head } = sel;
  const anchorFirst =
    anchor.line < head.line ||
    (anchor.line === head.line && anchor.col <= head.col);
  return anchorFirst
    ? { first: anchor, last: head }
    : { first: head, last: anchor };
}
