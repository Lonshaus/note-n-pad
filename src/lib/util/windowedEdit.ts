// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Pure helpers for the sliding-window editor: mapping a CodeMirror transaction's
 *  changes to the Rust core's global byte edits, and computing which line range a
 *  window should cover. Kept free of CodeMirror/Tauri so they unit-test in
 *  isolation. */

/** A window of this many lines is held in the CM document at once. 2000 lines is
 *  large enough that ordinary scrolling stays inside one window (no swap churn),
 *  yet small enough that per-keystroke byte re-encoding over the window is cheap. */
export const WINDOW_LINES = 2000;
/** Extra lines kept above (and implicitly below) the target when a window is
 *  (re)positioned, so a swap lands the target well inside the window rather than
 *  at its very edge, leaving room to scroll before the next swap. */
export const MARGIN_LINES = 500;
/** When the viewport top/bottom comes within this many lines of the loaded
 *  window's top/bottom, the next window is loaded. Comfortably larger than a
 *  viewport so the swap completes before the user scrolls past the loaded text. */
export const SWAP_THRESHOLD_LINES = 300;

/** Edits made within this many milliseconds of the previous one coalesce into the
 *  same undo group (when the edit kind is unchanged), matching the typical
 *  typing-run granularity of a native editor's undo. */
export const COALESCE_MS = 750;

const encoder = new TextEncoder();

/** UTF-8 byte length of a string. */
export function byteLength(s: string): number {
  return encoder.encode(s).length;
}

/** Number of UTF-16 code units (a CodeMirror position) before global byte offset
 *  `byteOffset` in window text `doc`. Scans code point by code point, accumulating
 *  UTF-8 byte length until the offset is reached; a byte offset landing mid
 *  character (never produced by boundary-respecting edits) rounds up to the next
 *  character boundary. Used to turn the Rust core's global-byte undo edits back
 *  into local CM changes.
 *  ponytail: re-encodes each code point (O(window)) but runs only per undo/redo,
 *  not per keystroke; add a per-line byte index if it ever shows on the profile. */
export function byteToCharIndex(doc: string, byteOffset: number): number {
  if (byteOffset <= 0) {
    return 0;
  }
  let bytes = 0;
  let chars = 0;
  for (const ch of doc) {
    if (bytes >= byteOffset) {
      break;
    }
    bytes += byteLength(ch);
    chars += ch.length;
  }
  return chars;
}

/** The prior applied edit's grouping context: when it landed, its kind, and
 *  whether it was part of an IME composition. */
export interface GroupPrev {
  time: number;
  kind: string | null;
  composing: boolean;
}

/** The current edit's grouping context: when it lands, its kind, whether it is
 *  part of an IME composition, and whether it is that composition's first
 *  transaction. */
export interface GroupCurrent {
  time: number;
  kind: string | null;
  composing: boolean;
  compositionStart: boolean;
}

/** Whether the current edit opens a new undo group (vs. coalescing into the
 *  previous one). An IME composition is always one group: its first transaction
 *  opens the group, every later composing transaction joins it, and the first
 *  edit after the composition ends opens a fresh group. Outside composition, a
 *  new group opens on the very first edit, after a pause longer than `COALESCE_MS`,
 *  or when the edit kind (typing / deleting / pasting) changes. */
export function decideNewGroup(
  prev: GroupPrev,
  current: GroupCurrent,
): boolean {
  if (current.composing) {
    return current.compositionStart;
  }
  if (prev.composing) {
    return true;
  }
  if (prev.kind === null) {
    return true;
  }
  if (current.time - prev.time > COALESCE_MS) {
    return true;
  }
  return current.kind !== prev.kind;
}

/** One change from a CM transaction's `iterChanges`, in the transaction's
 *  pre-change (`A`) coordinate space: `[fromA, toA)` is the replaced char range in
 *  `docBefore`, `inserted` the replacement text. */
export interface RawChange {
  fromA: number;
  toA: number;
  inserted: string;
}

/** A global-byte edit as the Rust `windowed_apply` expects: replace the source
 *  bytes `[start, end)` with `text` (UTF-8). */
export interface ByteEdit {
  start: number;
  end: number;
  text: string;
}

/** Convert one transaction's changes into global byte edits. `docBefore` is the
 *  window text before the transaction; `windowStartOffset` is that window's global
 *  byte offset. Each change's char positions map to global bytes by measuring the
 *  UTF-8 length of the `docBefore` prefix up to the position. Because every change
 *  is expressed against the same pre-change document, `fromA`/`toA` are naturally
 *  non-overlapping and ascending — exactly the "one shared pre-apply coordinate
 *  table" the Rust side requires — so the mapping is a direct 1:1.
 *  ponytail: prefix re-encoding is O(window) per keystroke, acceptable for a 2000-
 *  line window; upgrade path is a per-line byte-offset index if it ever shows. */
export function mapChangesToEdits(
  windowStartOffset: number,
  docBefore: string,
  changes: RawChange[],
): ByteEdit[] {
  return changes.map((c) => ({
    start: windowStartOffset + byteLength(docBefore.slice(0, c.fromA)),
    end: windowStartOffset + byteLength(docBefore.slice(0, c.toA)),
    text: c.inserted,
  }));
}

/** The line range `[startLine, endLine)` (0-based, end exclusive) a window should
 *  cover to hold `targetLine`. The window is `windowLines` tall when the file
 *  allows, anchored `marginLines` above the target, and clamped so it never runs
 *  past either end of the file (a short file yields the whole file). */
export function nextWindow(
  targetLine: number,
  totalLines: number,
  windowLines: number,
  marginLines: number,
): { startLine: number; endLine: number } {
  const maxStart = Math.max(0, totalLines - windowLines);
  const startLine = Math.min(Math.max(0, targetLine - marginLines), maxStart);
  const endLine = Math.min(totalLines, startLine + windowLines);
  return { startLine, endLine };
}
