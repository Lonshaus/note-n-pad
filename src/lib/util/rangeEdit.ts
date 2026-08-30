// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Pure helpers for pulling a line range out of the large-file viewer into an
 *  editable tab: byte-range assembly and the size ceiling. Kept free of
 *  Svelte/Tauri so they are unit-testable in isolation. */
import { applyLineEnding, type LineEnding } from './text';

/** UTF-8 byte length of a range tab's buffer once its line ending is re-applied.
 *  This is exactly what `splice_file` writes back (the replacement is UTF-8), so
 *  `startByte + this` is the slice's new exclusive end after a successful splice.
 *  The line ending must be restored first: a CRLF source needs its `\r` bytes
 *  counted, or the rebased end would be short by one byte per line. */
export function replacementByteLength(
  content: string,
  ending: LineEnding,
): number {
  return new TextEncoder().encode(applyLineEnding(content, ending)).length;
}

/** Largest range (in bytes) that may be pulled into an editable tab. A slice this
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

/** Whether a byte range is small enough to extract into an editable tab. */
export function rangeWithinLimit(
  startByte: number,
  endByte: number,
  max: number,
): boolean {
  return endByte - startByte <= max;
}
