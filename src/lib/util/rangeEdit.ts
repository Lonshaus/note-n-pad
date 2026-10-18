// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Pure helpers for pulling a line range out of the large-file viewer into the
 *  range edit box: byte-range assembly and the size ceiling. Kept free of
 *  Svelte/Tauri so they are unit-testable in isolation. */
import { applyLineEnding, type LineEnding } from './text';
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
/** Whether a source slice ends with a line break (`\n`, or `\r\n`). */
export function sliceEndsWithBreak(slice: string): boolean {
  return slice.endsWith('\n');
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
  const withBreak =
    trailingBreak && buffer !== '' && !buffer.endsWith('\n')
      ? buffer + '\n'
      : buffer;
  return applyLineEnding(withBreak, ending);
}
