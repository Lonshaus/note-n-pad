// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Pure page-read logic for the large-file viewer: tells a page that lies past
 *  the end of the file (an empty page) apart from a page that could not be read
 *  (a failure). Kept free of Svelte/Tauri so it is unit-testable in isolation. */

export interface PageSource {
  /** Byte offset where `line` begins; `null` when `line` is past the last line.
   *  Rejects on a real failure. */
  lineToOffset: (line: number) => Promise<number | null>;
  /** Text read from `offset`. Rejects on a real failure. */
  readText: (offset: number) => Promise<string>;
}
/** The lines of page `page` (`pageLines` lines each): `[]` for a page past the
 *  end of the file, `null` only when a read really failed. */
export async function readPageLines(
  page: number,
  pageLines: number,
  source: PageSource,
): Promise<string[] | null> {
  let offset: number | null;
  try {
    offset = await source.lineToOffset(page * pageLines);
  } catch {
    return null;
  }
  if (offset === null) {
    return [];
  }
  let text: string;
  try {
    text = await source.readText(offset);
  } catch {
    return null;
  }
  return text.split('\n').slice(0, pageLines);
}
