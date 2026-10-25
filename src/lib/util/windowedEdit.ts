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
/** A swap leaves the viewport this many lines clear of the threshold behind it,
 *  so the next scroll event cannot swap straight back. */
export const SWAP_SLACK_LINES = 50;

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
/** `docBefore` with `changes` (ascending, non-overlapping) applied. */
function applyChangesToDoc(
  docBefore: string,
  changes: readonly RawChange[],
): string {
  let out = '';
  let prev = 0;
  for (const c of changes) {
    out += docBefore.slice(prev, c.fromA) + c.inserted;
    prev = c.toA;
  }
  return out + docBefore.slice(prev);
}
/** Document indexes of every `\n` in `doc`: where the window's breaks sit. */
function lfPositions(doc: string): number[] {
  const out: number[] = [];
  for (let i = doc.indexOf('\n'); i !== -1; i = doc.indexOf('\n', i + 1)) {
    out.push(i);
  }
  return out;
}
/** For each break after `changes`, the index it had before them, or -1 for a
 *  break the changes inserted. */
function breakOrigins(
  docBefore: string,
  countBefore: number,
  changes: readonly RawChange[],
): number[] {
  const out: number[] = [];
  let next = 0;
  let prevTo = 0;
  for (const c of changes) {
    const keep = countLf(docBefore, prevTo, c.fromA);
    for (let k = 0; k < keep; k += 1) {
      out.push(next + k);
    }
    next += keep + countLf(docBefore, c.fromA, c.toA);
    for (let n = countLf(c.inserted, 0, c.inserted.length); n > 0; n -= 1) {
      out.push(-1);
    }
    prevTo = c.toA;
  }
  for (let k = next; k < countBefore; k += 1) {
    out.push(k);
  }
  return out;
}
/** One lone `\r` an edit would join to a `\n`, to be rewritten to the insert
 *  separator in the same batch. `at` is its byte offset in the window before the
 *  change; `whereBefore` is `'before'` (and `at` is -1) for the byte that sits
 *  just ahead of the window. */
export interface JunctionRewrite {
  at: number;
  whereBefore: 'inside' | 'before';
}
/** What `junctionRewrites` found: the rewrites, the window's breaks after the
 *  change and the rewrites, how far the rewrite of the byte before the window
 *  moves the window start, and whether that byte is still a lone `\r`. */
export interface JunctionResult {
  rewrites: JunctionRewrite[];
  breaksAfter: string[];
  startShift: number;
  prevLoneCr: boolean;
}
/** The rewrites a change set needs so that no lone `\r` break becomes the first
 *  half of a `\r\n`. After the change, a lone-`\r` break that is directly
 *  followed by a break written as a bare `\n` (inside the window; or the byte
 *  just before the window, `prevLoneCr`, with the window now opening on such a
 *  break; or the window's last break with `nextIsLf` for the byte after it)
 *  would be read back as one CRLF, one line short. Inserted text never holds a
 *  lone `\r`, so every such `\r` is one the window already had. For an LF
 *  separator the rewrite also takes the run of `\r` bytes before it (each would
 *  meet the `\n` in turn): the run inside the window is set in `breaksAfter`, and
 *  one that reaches the window start clears `prevLoneCr`, since the core
 *  rewrites the bytes before the window too. */
export function junctionRewrites(
  docBefore: string,
  breaksBefore: readonly string[],
  changes: readonly RawChange[],
  insertSep: string,
  prevLoneCr: boolean,
  nextIsLf: boolean,
): JunctionResult {
  const breaksAfter = applyBreaks(docBefore, breaksBefore, changes, insertSep);
  if (!prevLoneCr && !breaksBefore.includes('\r')) {
    return { rewrites: [], breaksAfter, startShift: 0, prevLoneCr };
  }
  const docAfter = applyChangesToDoc(docBefore, changes);
  const lf = lfPositions(docAfter);
  const rewrites: JunctionRewrite[] = [];
  const found: number[] = [];
  let startShift = 0;
  let stillPrevCr = prevLoneCr;
  if (prevLoneCr) {
    const opensOnLf =
      docAfter.length === 0
        ? nextIsLf
        : docAfter.charCodeAt(0) === 10 && breaksAfter[0] === '\n';
    if (opensOnLf) {
      rewrites.push({ at: -1, whereBefore: 'before' });
      stillPrevCr = false;
      startShift = insertSep.length - 1;
    }
  }
  for (let i = 0; i < breaksAfter.length; i += 1) {
    if (breaksAfter[i] !== '\r') {
      continue;
    }
    const at = lf[i] as number;
    const joins =
      i + 1 < breaksAfter.length
        ? lf[i + 1] === at + 1 && breaksAfter[i + 1] === '\n'
        : at === docAfter.length - 1 && nextIsLf;
    if (joins) {
      found.push(i);
    }
  }
  const out = [...breaksAfter];
  if (found.length > 0) {
    const origins = breakOrigins(docBefore, breaksBefore.length, changes);
    const lfBefore = lfPositions(docBefore);
    for (const i of found) {
      const k = origins[i] as number;
      rewrites.push({
        at: charToByte(docBefore, breaksBefore, lfBefore[k] as number),
        whereBefore: 'inside',
      });
      if (insertSep !== '\n') {
        out[i] = insertSep;
        continue;
      }
      let j = i;
      out[j] = '\n';
      while (
        j > 0 &&
        breaksAfter[j - 1] === '\r' &&
        (lf[j - 1] as number) === (lf[j] as number) - 1
      ) {
        j -= 1;
        out[j] = '\n';
      }
      if (j === 0 && lf[0] === 0 && stillPrevCr) {
        stillPrevCr = false;
      }
    }
  }
  return { rewrites, breaksAfter: out, startShift, prevLoneCr: stillPrevCr };
}
/** A window's breaks after the core rewrote the bytes `[from, to)` (offsets in
 *  the window's raw text) to the break byte `byte`: the break list changes,
 *  the document text does not. */
export function fillBreaks(
  doc: string,
  breaks: readonly string[],
  from: number,
  to: number,
  byte: string,
): string[] {
  const out = [...breaks];
  let bytes = 0;
  let k = 0;
  for (const ch of doc) {
    if (bytes >= to) {
      break;
    }
    if (ch === '\n') {
      if (bytes >= from) {
        out[k] = byte;
      }
      bytes += (breaks[k] ?? '\n').length;
      k += 1;
    } else {
      bytes += byteLength(ch);
    }
  }
  return out;
}
/** An edit of the core's undo or redo result, as `ByteEdit` without the flags
 *  only a forward apply sends. */
export type UndoEdit = Pick<ByteEdit, 'start' | 'end' | 'text'> &
  Pick<ByteEdit, 'keep_start' | 'fill'>;
/** How one undo/redo edit lands in a window holding `doc` with `breaks` that
 *  starts at byte `windowStart`: the document change to dispatch (none for a
 *  `fill` edit, which only turns break bytes into other break bytes) and the
 *  break list after it. Null when a boundary falls inside a `\r\n`, which has
 *  no document position. */
export function mirrorStep(
  doc: string,
  breaks: readonly string[],
  windowStart: number,
  edit: UndoEdit,
): {
  change: { from: number; to: number; insert: string } | null;
  breaks: string[];
} | null {
  if ((edit.fill ?? null) !== null) {
    return {
      change: null,
      breaks: fillBreaks(
        doc,
        breaks,
        edit.start - windowStart,
        edit.end - windowStart,
        edit.fill as string,
      ),
    };
  }
  const from = byteToChar(doc, breaks, edit.start - windowStart);
  const to = byteToChar(doc, breaks, edit.end - windowStart);
  if (from === null || to === null) {
    return null;
  }
  return {
    change: { from, to, insert: edit.text },
    breaks: replaceBreaks(doc, breaks, from, to, scanBreaks(edit.text)),
  };
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
 *  bytes `[start, end)` with `text` (UTF-8). `keep_start` marks the rewrite of a
 *  lone `\r` an edit would join to a `\n` (an offset at `start` stays there) and
 *  `cascade` asks the core to rewrite the run of `\r` before it too. `fill`
 *  (undo and redo results only) says the range's bytes became that break byte,
 *  with `text` empty. */
export interface ByteEdit {
  start: number;
  end: number;
  text: string;
  keep_start?: boolean;
  cascade?: boolean;
  fill?: string | null;
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
/** A global byte offset after one edit: unchanged before the edit's start, moved
 *  by the length change at or after its end, and put after the inserted text when
 *  it lay inside the replaced range. A `fill` edit and a same-length `keep_start`
 *  edit only change break bytes, so every offset stays; any `keep_start` edit
 *  keeps an offset at its start there. */
export function mapOffset(offset: number, edit: ByteEdit): number {
  if (offset < edit.start || (edit.fill ?? null) !== null) {
    return offset;
  }
  const inserted = byteLength(edit.text);
  if (
    edit.keep_start === true &&
    (offset === edit.start || inserted === edit.end - edit.start)
  ) {
    return offset;
  }
  if (offset >= edit.end) {
    return offset + inserted - (edit.end - edit.start);
  }
  return edit.start + inserted;
}
/** A global byte offset after edits applied one after another, each in the
 *  frame the one before it left (the order the core applies them in). */
export function mapThrough(offset: number, edits: readonly ByteEdit[]): number {
  let mapped = offset;
  for (const edit of edits) {
    mapped = mapOffset(mapped, edit);
  }
  return mapped;
}
/** The edits of one forward apply in the order the core applies them: from the
 *  highest `(start, end)` down, so every edit still sits where its coordinates
 *  say. Of an insertion and a rewrite starting at the same byte, the rewrite
 *  goes first and the inserted text lands before it. */
export function inApplyOrder(edits: readonly ByteEdit[]): ByteEdit[] {
  return [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
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
/** The target line to swap the window to (for `nextWindow`) when the viewport,
 *  global lines `top` to `bottom`, nears the loaded window's start (checked
 *  first) or end; null when it does not. Either way the new window holds the
 *  viewport `SWAP_SLACK_LINES` clear of the threshold behind it, leaving the
 *  same room ahead in both directions. A viewport too tall for that never
 *  swaps. */
export function swapTarget(
  top: number,
  bottom: number,
  windowStartLine: number,
  windowEndLine: number,
  totalLines: number,
): number | null {
  const clear = SWAP_THRESHOLD_LINES + SWAP_SLACK_LINES;
  if (bottom - top >= WINDOW_LINES - SWAP_THRESHOLD_LINES - clear) {
    return null;
  }
  if (windowStartLine > 0 && top - windowStartLine < SWAP_THRESHOLD_LINES) {
    // The window ends `clear` lines below the viewport.
    return bottom + clear - WINDOW_LINES + MARGIN_LINES;
  }
  if (
    windowEndLine < totalLines &&
    windowEndLine - bottom < SWAP_THRESHOLD_LINES
  ) {
    // The window starts `clear` lines above the viewport.
    return top - clear + MARGIN_LINES;
  }
  return null;
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
/** Whether a DOM-derived selection sync must be dropped during a window swap.
 *  A composition captured in the swap back to the caret keeps its syncs:
 *  dropping one makes CodeMirror write its own selection back into the DOM,
 *  and WebKit ends the composition. */
export function dropSwapSelect(
  swapping: boolean,
  docChanged: boolean,
  userEvent: string | undefined,
  composingKept: boolean,
): boolean {
  return swapping && !docChanged && userEvent === 'select' && !composingKept;
}
