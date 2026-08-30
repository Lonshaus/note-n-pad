// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Pure helpers for the large-file viewer's goto-line and streaming-search
 *  panels: line-number parsing/clamping and result-list cursor movement. Kept
 *  free of Svelte/Tauri so they are unit-testable in isolation. */

/** Parse a 1-based line number typed into the goto box and convert it to the
 *  0-based line index `scrollToLine` expects. Non-numeric or empty input yields
 *  `null` (nothing to do); a valid number is clamped to `[1, totalLines]` (or
 *  just `>= 1` while the total is still unknown) before the 1→0 shift. */
export function parseGotoLine(
  input: string,
  totalLines: number | null,
): number | null {
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  let n = parseInt(trimmed, 10);
  if (n < 1) {
    n = 1;
  }
  if (totalLines !== null && n > totalLines) {
    n = totalLines;
  }
  return n - 1;
}

export interface LineRange {
  /** 0-based inclusive start line. */
  start: number;
  /** 0-based inclusive end line. */
  end: number;
}

/** Parse the goto box input. A single number is a line jump (`kind: 'line'`, the
 *  0-based line `scrollToLine` expects); an `A-B` pair is a range selection
 *  (`kind: 'range'`, 0-based inclusive, endpoints ordered). Each endpoint reuses
 *  `parseGotoLine` for parsing and clamping. Returns null when the input is empty
 *  or either endpoint is non-numeric. */
export function parseGotoRange(
  input: string,
  totalLines: number | null,
): { kind: 'line'; line: number } | { kind: 'range'; range: LineRange } | null {
  const parts = input.split('-');
  if (parts.length === 2) {
    const a = parseGotoLine(parts[0]!, totalLines);
    const b = parseGotoLine(parts[1]!, totalLines);
    if (a === null || b === null) {
      return null;
    }
    return {
      kind: 'range',
      range: { start: Math.min(a, b), end: Math.max(a, b) },
    };
  }
  const line = parseGotoLine(input, totalLines);
  return line === null ? null : { kind: 'line', line };
}

/** Move a result-list cursor by `delta`, clamped to `[0, count - 1]`. Returns
 *  `-1` when the list is empty. Starting from `-1` (no selection) with a
 *  positive delta lands on the first result. */
export function moveResultCursor(
  current: number,
  count: number,
  delta: number,
): number {
  if (count <= 0) {
    return -1;
  }
  const next = current + delta;
  if (next < 0) {
    return 0;
  }
  if (next >= count) {
    return count - 1;
  }
  return next;
}
