// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Pure helpers for pulling a line range out of the large-file viewer into the
 *  range edit box: byte-range assembly and the size ceiling. Kept free of
 *  Svelte/Tauri so they are unit-testable in isolation. */
import { applyLineEnding, type LineEnding } from './text';
import type { LineBreak } from './windowedEdit';
/** Largest range (in bytes) that may be pulled into the edit box. A slice this
 *  big is loaded whole into the editor, so allowing more would blow the WebView's
 *  memory and defeat the streaming viewer; extraction above it is refused. */
export const RANGE_EDIT_MAX = 32 * 1024 * 1024;

/** Assemble the byte range `[startByte, endByte)` for a line selection.
 *  `startOffset` is the byte offset of the selection's first line. `endOffset` is
 *  the byte offset of the line *after* the selection's last line, or null when
 *  that line is past the file's end (the selection runs to EOF), in which case the
 *  range ends at `fileSize`. */
export function resolveByteRange(
  startOffset: number,
  endOffset: number | null,
  fileSize: number,
): { startByte: number; endByte: number } {
  return { startByte: startOffset, endByte: endOffset ?? fileSize };
}

/** Whether a byte range is small enough to extract into the edit box. */
export function rangeWithinLimit(
  startByte: number,
  endByte: number,
  max: number,
): boolean {
  return endByte - startByte <= max;
}
/** Whether a source slice ends with a line break (`\n`, `\r\n`, or a lone `\r`). */
export function sliceEndsWithBreak(slice: string): boolean {
  return /[\r\n]$/.test(slice);
}
/** The text the range edit box writes back into its source. A slice that ended with a
 *  line break (`trailingBreak`) gets one in the file's line ending when the
 *  buffer is not empty and does not already end with one, so text typed on the
 *  buffer's last line cannot join the next source line. An empty buffer writes
 *  nothing, which removes the whole span. `buffer` is LF-normalized. */
export function rangeWriteText(
  buffer: string,
  trailingBreak: boolean,
  ending: LineEnding,
): string {
  return applyLineEnding(withTrailingBreak(buffer, trailingBreak), ending);
}
function withTrailingBreak(buffer: string, trailingBreak: boolean): string {
  return trailingBreak && buffer !== '' && !buffer.endsWith('\n')
    ? buffer + '\n'
    : buffer;
}
/** The bytes the range edit box writes back, keeping the line breaks of the
 *  lines the user did not touch. `saved` is the slice as read (LF-normalized)
 *  and `breaks` the separator of each of its breaks, in order; `content` is the
 *  buffer. The lines the buffer shares with the slice at its start and at its
 *  end keep their original separators (a lone `\r` stays a lone `\r`); the
 *  lines between get the file's `ending`, and so does the break added by the
 *  trailing-break rule of `rangeWriteText`. An unchanged buffer writes the
 *  slice's bytes exactly.
 *
 *  A kept lone `\r` that ends up directly in front of a `\n` (an empty line
 *  with an LF break follows it, in the changed lines or in the kept ones) would
 *  be read back as one CRLF, a line short: it is written as `ending` instead,
 *  and for an LF `ending` so is every kept lone `\r` directly before that one
 *  (each would meet the `\n` in turn). */
export function rangeWriteBytes(
  saved: string,
  content: string,
  breaks: readonly LineBreak[],
  trailingBreak: boolean,
  ending: LineEnding,
): string {
  const sep = ending === 'CRLF' ? '\r\n' : '\n';
  const old = saved.split('\n');
  const lines = withTrailingBreak(content, trailingBreak).split('\n');
  let head = 0;
  const most = Math.min(old.length, lines.length);
  while (head < most && old[head] === lines[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < most - head &&
    old[old.length - 1 - tail] === lines[lines.length - 1 - tail]
  ) {
    tail += 1;
  }
  const shift = lines.length - old.length;
  const seps: string[] = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    let kept: string | undefined;
    if (i < head) {
      kept = breaks[i];
    } else if (i >= lines.length - tail) {
      kept = breaks[i - shift];
    }
    seps.push(kept ?? sep);
  }
  for (let i = seps.length - 2; i >= 0; i -= 1) {
    if (seps[i] === '\r' && lines[i + 1] === '' && seps[i + 1] === '\n') {
      seps[i] = sep;
    }
  }
  let out = lines[0] as string;
  for (let i = 0; i < seps.length; i += 1) {
    out += (seps[i] as string) + (lines[i + 1] as string);
  }
  return out;
}
