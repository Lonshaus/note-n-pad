// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** A fixed scroll-axis ceiling kept well under the browser's ~33.5M px
 *  per-element scroll-height limit. The scroll container's content height is
 *  capped here no matter how many lines the document has; position within the
 *  file is mapped proportionally onto this axis instead of accumulating one
 *  pixel row per line, so every line stays reachable even for GB-scale files. */
export const SAFE_SCROLL_HEIGHT = 4_000_000;

/** The range of equal-height lines a viewport covers, plus an overscan margin.
 *  All line numbers are zero-based; `endLine` is exclusive. */
export interface VisibleWindow {
  firstVisible: number;
  visibleCount: number;
  startLine: number;
  endLine: number;
}

/** Content height of the scroll axis for a document of `totalLines` rows at
 *  `lineHeight` px each, capped at `SAFE_SCROLL_HEIGHT`. */
export function scrollAxisHeight(
  totalLines: number,
  lineHeight: number,
): number {
  return Math.min(Math.max(0, totalLines) * lineHeight, SAFE_SCROLL_HEIGHT);
}

/** Pixel travel of a container whose content is `contentHeight` tall inside a
 *  `viewportHeight` viewport. Never negative. */
function scrollRangeOf(contentHeight: number, viewportHeight: number): number {
  return Math.max(0, contentHeight - viewportHeight);
}

/** Highest line that may sit at the viewport top: scrolling all the way down
 *  shows the last viewport-full of lines with the final line flush against the
 *  viewport bottom, never a lone last line at the top with emptiness below. */
function maxFirstVisible(
  totalLines: number,
  lineHeight: number,
  viewportHeight: number,
): number {
  const rowHeight = lineHeight > 0 ? lineHeight : 1;
  const viewportLines = Math.floor(viewportHeight / rowHeight);
  return Math.max(0, totalLines - viewportLines);
}

/** Map a line number onto the proportional scroll axis: line 0 sits at the top
 *  of the travel and `maxFirstVisible` at the very bottom (so the tail of the
 *  file bottom-aligns instead of over-scrolling past it). Lines beyond that cap
 *  land inside the last screen. Must stay the exact inverse of
 *  `computeVisibleWindow`'s mapping — both use the same denominator. */
export function lineToScrollTop(
  line: number,
  totalLines: number,
  lineHeight: number,
  contentHeight: number,
  viewportHeight: number,
): number {
  const maxFirst = maxFirstVisible(totalLines, lineHeight, viewportHeight);
  const clamped = Math.min(maxFirst, Math.max(0, line));
  const range = scrollRangeOf(contentHeight, viewportHeight);
  const frac = maxFirst > 0 ? clamped / maxFirst : 0;
  return frac * range;
}

/** Given a scroll offset over a proportionally-scaled axis of height
 *  `contentHeight`, compute which line sits at the top of the viewport and the
 *  padded window of equal-height rows to render around it. The first-visible
 *  line is derived by proportion (scrollTop / range ≈ firstVisible / maxFirst),
 *  not by pixel accumulation, so it stays exact at both ends and never exceeds
 *  the browser's scroll-height limit. The row count still uses the fixed line
 *  height. Clamped to `[0, totalLines)`. */
export function computeVisibleWindow(
  scrollTop: number,
  lineHeight: number,
  viewportHeight: number,
  totalLines: number,
  contentHeight: number,
  overscan: number,
): VisibleWindow {
  const rowHeight = lineHeight > 0 ? lineHeight : 1;
  const maxFirst = maxFirstVisible(totalLines, lineHeight, viewportHeight);
  const range = scrollRangeOf(contentHeight, viewportHeight);
  const frac = range > 0 ? Math.min(1, Math.max(0, scrollTop / range)) : 0;
  const firstVisible = Math.min(
    maxFirst,
    Math.max(0, Math.round(frac * maxFirst)),
  );
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + 1;
  const startLine = Math.max(0, firstVisible - overscan);
  const endLine = Math.min(totalLines, firstVisible + visibleCount + overscan);
  return { firstVisible, visibleCount, startLine, endLine };
}
/** Indices of the first and last row lying fully inside the viewport (1 px
 *  tolerance). With no fully visible row, the first row that intersects the
 *  viewport; null when no row does. */
export function fullyVisibleSpan(
  rows: readonly { top: number; bottom: number }[],
  viewTop: number,
  viewBottom: number,
): { first: number; last: number } | null {
  let first = -1;
  let last = -1;
  rows.forEach((r, i) => {
    if (r.top >= viewTop - 1 && r.bottom <= viewBottom + 1) {
      if (first < 0) {
        first = i;
      }
      last = i;
    }
  });
  if (first >= 0) {
    return { first, last };
  }
  const hit = rows.findIndex((r) => r.bottom > viewTop && r.top < viewBottom);
  return hit < 0 ? null : { first: hit, last: hit };
}
/** One rendered row's share of a selection: its text, and the offsets the
 *  selection starts/ends at when it starts/ends inside that row. */
export interface SelectedRow {
  text: string;
  from?: number;
  to?: number;
}
/** The selected text of `rows`, one line per row. A row that still ends in
 *  `\r` has it dropped, to match what an ordinary tab copies. */
export function joinSelectedRows(rows: readonly SelectedRow[]): string {
  return rows
    .map((r) => r.text.slice(r.from ?? 0, r.to).replace(/\r$/, ''))
    .join('\n');
}
