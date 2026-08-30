// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Tallest element this engine lays out. Measured in the app's own WebView: a
 *  row asked for 33,554,432px came back 33,554,428 (2^25 − 4, the layout-unit
 *  ceiling), and every larger request clamped to the same value. A document
 *  taller than this cannot address its own tail — at a 23px row that is
 *  1,458,888 rows, which a short-line CSV reaches around 48MB, well under the
 *  100MB that would have sent it to the large-file viewer instead. Past this
 *  the scroll axis is compressed and `computeVisibleWindow` maps onto it
 *  proportionally, the same trade the large-file viewer already makes. */
export const MAX_SCROLL_HEIGHT = 33_554_428;

/** Cached answer: the limit is a property of the engine, not of any one table,
 *  so one probe serves the whole window. */
let probedLimit: number | null = null;

/** Ask the engine directly how tall an element it will lay out, by giving an
 *  offscreen element more than the known ceiling and reading back what it got.
 *
 *  Deliberately not measured off the live table: that reading also moves with
 *  the table's own row height and render timing, and a false "the engine
 *  clamped us" can only ever shrink the axis, so one bad reading would compress
 *  a document that fits perfectly well. This asks the one question that matters
 *  and nothing else. Falls back to the measured constant where there is no
 *  layout to read (a non-browser test environment reports 0). */
export function engineScrollLimit(doc: Document): number {
  if (probedLimit !== null) {
    return probedLimit;
  }
  const probe = doc.createElement('div');
  probe.style.cssText =
    'position:absolute;left:-9999px;top:0;width:1px;visibility:hidden';
  probe.style.height = `${MAX_SCROLL_HEIGHT * 2}px`;
  doc.body.appendChild(probe);
  const got = probe.offsetHeight;
  probe.remove();
  probedLimit = got > 0 ? got : MAX_SCROLL_HEIGHT;
  return probedLimit;
}

/** A cell edit the user has typed but not committed, identified by the cell it
 *  belongs to and the document it was typed against. */
export interface PendingCellEdit<T> {
  r: number;
  c: number;
  document: T;
}

/**
 * Whether a blurred cell should have its input's value written back.
 *
 * Only a cell the user actually typed into: an `<input>` cannot hold a newline,
 * so a cell whose value contains one hands back a copy with the newline stripped.
 * Committing that on a bare focus-and-blur would delete the newline although
 * nothing was edited — and a table with a quoted multi-line field loses it just
 * by being clicked on.
 *
 * The document the edit was typed against must still be the current one. If it
 * changed while the cell had focus, the input was re-rendered from the new
 * content, so the pending text is stale and its row number no longer means what
 * it meant when it was typed.
 */
export function shouldCommitCell<T>(
  pending: PendingCellEdit<T> | null,
  r: number,
  c: number,
  document: T,
): boolean {
  return (
    pending !== null &&
    pending.r === r &&
    pending.c === c &&
    pending.document === document
  );
}

/** Which rows a virtualized table renders, and the empty height standing in
 *  for the rest. */
export interface RowLayout {
  /** Rows before the window that render anyway, ascending. Drawn ahead of the
   *  top spacer, which gives back their height. */
  pinned: number[];
  /** Height of the spacer row before the window, in pixels. */
  topSpacer: number;
  /** Height of the spacer row after the window, in pixels. */
  bottomSpacer: number;
}

/** Where the block of rendered rows starts on the scroll axis.
 *
 *  While the axis is the document's true height this is just `startLine`'s own
 *  offset. Once the axis is compressed the two no longer agree — a pixel of
 *  scroll covers more than a pixel of rows — so the block is placed against the
 *  live scroll position instead, which keeps `firstVisible` at the top of the
 *  viewport whatever the compression ratio. */
export function blockTopFor(
  startLine: number,
  firstVisible: number,
  scrollTop: number,
  rowHeight: number,
  compressed: boolean,
): number {
  if (!compressed) {
    return startLine * rowHeight;
  }
  return Math.max(0, scrollTop - (firstVisible - startLine) * rowHeight);
}

/** Lay out `[startLine, endLine)` over `rowCount` rows of `rowHeight` px on a
 *  scroll axis of `contentHeight`, with the rendered block starting at
 *  `blockTop` and every row in `keep` rendered.
 *
 *  Invariant: top spacer + rendered rows + bottom spacer covers
 *  `contentHeight`, so pinning never shifts the scrollbar. A `keep` entry is
 *  dropped when null, out of range, duplicated, or at/after `startLine` —
 *  pinned rows render before the top spacer, so one from below the window would
 *  land above rows that precede it. */
export function rowLayout(
  startLine: number,
  endLine: number,
  rowCount: number,
  rowHeight: number,
  keep: readonly (number | null)[],
  blockTop: number,
  contentHeight: number,
): RowLayout {
  const start = Math.max(0, Math.min(startLine, rowCount));
  const end = Math.max(start, Math.min(endLine, rowCount));
  const pinned = keep
    .filter((r): r is number => r !== null && r >= 0 && r < start)
    .filter((r, i, all) => all.indexOf(r) === i)
    .sort((a, b) => a - b);
  const rendered = (end - start + pinned.length) * rowHeight;
  const topSpacer = Math.max(0, blockTop - pinned.length * rowHeight);
  return {
    pinned,
    topSpacer,
    bottomSpacer: Math.max(0, contentHeight - topSpacer - rendered),
  };
}
