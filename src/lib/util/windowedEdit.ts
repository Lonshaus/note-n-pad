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
/** A line break as it sits in the file's bytes. */
export type LineBreak = '\r\n' | '\n' | '\r';

const BREAK_RE = /\r\n|\n|\r/g;
/** The separator of every line break in a raw window text, in order, using the
 *  same split rule as CodeMirror (`\r\n`, `\n` or a lone `\r`). CodeMirror's
 *  document holds each break as one `\n`, so these are what tell a position in
 *  the document apart from a byte offset in the file. */
export function scanBreaks(raw: string): LineBreak[] {
  return (raw.match(BREAK_RE) ?? []) as LineBreak[];
}

function countLf(doc: string, from: number, to: number): number {
  let n = 0;
  let i = doc.indexOf('\n', from);
  while (i !== -1 && i < to) {
    n += 1;
    i = doc.indexOf('\n', i + 1);
  }
  return n;
}
/** Global-window byte offset of CodeMirror position `pos` in the normalized `doc`,
 *  whose k-th line break is the file's `breaks[k]` (a CRLF takes two bytes). */
export function charToByte(
  doc: string,
  breaks: readonly string[],
  pos: number,
): number {
  const lines = countLf(doc, 0, pos);
  let extra = 0;
  for (let k = 0; k < lines; k += 1) {
    if (breaks[k] === '\r\n') {
      extra += 1;
    }
  }
  return byteLength(doc.slice(0, pos)) + extra;
}
/** Number of UTF-16 code units (a CodeMirror position) before byte offset
 *  `byteOffset` of the raw window whose normalized text is `doc` and whose line
 *  breaks are `breaks`. A byte offset landing mid character (never produced by
 *  boundary-respecting edits) rounds up to the next character boundary. Returns
 *  null for an offset strictly inside a two-byte `\r\n`: no document position
 *  matches it (a reload can merge a lone `\r` and a `\n` into one break).
 *  ponytail: re-encodes each code point (O(window)) but runs only per undo/redo,
 *  not per keystroke; add a per-line byte index if it ever shows on the profile. */
export function byteToChar(
  doc: string,
  breaks: readonly string[],
  byteOffset: number,
): number | null {
  if (byteOffset <= 0) {
    return 0;
  }
  let bytes = 0;
  let chars = 0;
  let k = 0;
  for (const ch of doc) {
    if (bytes >= byteOffset) {
      break;
    }
    let width: number;
    if (ch === '\n') {
      width = (breaks[k] ?? '\n').length;
      k += 1;
      if (width === 2 && bytes + 1 === byteOffset) {
        return null;
      }
    } else {
      width = byteLength(ch);
    }
    bytes += width;
    chars += ch.length;
  }
  return chars;
}
/** The window's break list after one change set (positions in `docBefore`, the
 *  pre-change normalized text): breaks inside a replaced range are dropped, every
 *  `\n` of the inserted text becomes `insertSep`. Changes must be ascending and
 *  non-overlapping, as `iterChanges` yields them. */
export function applyBreaks(
  docBefore: string,
  breaks: readonly string[],
  changes: readonly RawChange[],
  insertSep: string,
): string[] {
  const out: string[] = [];
  let next = 0;
  let prevTo = 0;
  for (const c of changes) {
    const keep = countLf(docBefore, prevTo, c.fromA);
    out.push(...breaks.slice(next, next + keep));
    next += keep + countLf(docBefore, c.fromA, c.toA);
    for (let n = countLf(c.inserted, 0, c.inserted.length); n > 0; n -= 1) {
      out.push(insertSep);
    }
    prevTo = c.toA;
  }
  out.push(...breaks.slice(next));
  return out;
}
/** The break list after replacing `[from, to)` of `doc` with text whose own line
 *  breaks are `inserted` (already raw, e.g. scanned from an undo edit's text). */
export function replaceBreaks(
  doc: string,
  breaks: readonly string[],
  from: number,
  to: number,
  inserted: readonly string[],
): string[] {
  const before = countLf(doc, 0, from);
  const removed = countLf(doc, from, to);
  return [
    ...breaks.slice(0, before),
    ...inserted,
    ...breaks.slice(before + removed),
  ];
}
/** The line-ending style of a raw text sample: `lineEnding` for display and
 *  `insert` (the separator typed line breaks get) both follow the majority of
 *  `\r\n` against lone `\n` (a tie is LF; lone `\r` is not counted). Null when
 *  the sample has no line break at all. */
export function detectBreakStyle(
  raw: string,
): { lineEnding: 'LF' | 'CRLF'; insert: '\r\n' | '\n' } | null {
  let crlf = 0;
  let lf = 0;
  let any = false;
  for (const b of scanBreaks(raw)) {
    any = true;
    if (b === '\r\n') {
      crlf += 1;
    } else if (b === '\n') {
      lf += 1;
    }
  }
  if (!any) {
    return null;
  }
  return crlf > lf
    ? { lineEnding: 'CRLF', insert: '\r\n' }
    : { lineEnding: 'LF', insert: '\n' };
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
 *  normalized window text before the transaction and `breaks` its real line
 *  separators; `windowStartOffset` is that window's global byte offset. Each
 *  change's char positions map to bytes with the real separator lengths, and
 *  every `\n` of the inserted text is written as `insertSep`. Because every change
 *  is expressed against the same pre-change document, `fromA`/`toA` are naturally
 *  non-overlapping and ascending — exactly the "one shared pre-apply coordinate
 *  table" the Rust side requires — so the mapping is a direct 1:1.
 *  ponytail: prefix re-encoding is O(window) per keystroke, acceptable for a 2000-
 *  line window; upgrade path is a per-line byte-offset index if it ever shows. */
export function mapChangesToEdits(
  windowStartOffset: number,
  docBefore: string,
  breaks: readonly string[],
  insertSep: string,
  changes: RawChange[],
): ByteEdit[] {
  return changes.map((c) => ({
    start: windowStartOffset + charToByte(docBefore, breaks, c.fromA),
    end: windowStartOffset + charToByte(docBefore, breaks, c.toA),
    text:
      insertSep === '\n' ? c.inserted : c.inserted.replaceAll('\n', insertSep),
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
/** The document span from the first to the last line block lying fully inside
 *  the viewport (1 px tolerance). With no fully visible block, the first block
 *  that intersects the viewport; null when none does. */
export function fullyVisibleLineSpan(
  blocks: readonly { from: number; to: number; top: number; bottom: number }[],
  viewTop: number,
  viewBottom: number,
): { from: number; to: number } | null {
  const inside = blocks.filter(
    (b) => b.top >= viewTop - 1 && b.bottom <= viewBottom + 1,
  );
  const first = inside[0];
  const last = inside[inside.length - 1];
  if (first !== undefined && last !== undefined) {
    return { from: first.from, to: last.to };
  }
  const hit = blocks.find((b) => b.bottom > viewTop && b.top < viewBottom);
  return hit === undefined ? null : { from: hit.from, to: hit.to };
}
/** Whether a transaction must be dropped during a window swap: a user-originated
 *  (userEvent-annotated) document change. Our own dispatches carry no userEvent. */
export function rejectDuringSwap(
  swapping: boolean,
  docChanged: boolean,
  userEvent: string | undefined,
): boolean {
  return swapping && docChanged && userEvent !== undefined;
}
