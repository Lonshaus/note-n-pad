// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Pure page-read logic for the large-file viewer: tells a page that lies past
 *  the end of the file (an empty page) apart from a page that could not be read
 *  (a failure). Kept free of Svelte/Tauri so it is unit-testable in isolation. */
/** Text read from the file, and whether the read reached the file's end. */
export interface PageText {
  text: string;
  eof: boolean;
}
export interface PageSource {
  /** Byte offset where `line` begins; `null` when `line` is past the last line.
   *  Rejects on a real failure. */
  lineToOffset: (line: number) => Promise<number | null>;
  /** Text read from `offset`; a bare string is a read that reached the end of
   *  the file. Rejects on a real failure. */
  readText: (offset: number) => Promise<string | PageText>;
}
/** Split read text into lines at `\r\n`, `\r` and `\n`. A `\r` that ends a read
 *  short of the file's end is no break yet (the read may have cut a `\r\n`), and
 *  is left out with the incomplete line it ends. */
export function splitLines(text: string, eof: boolean): string[] {
  const body = !eof && text.endsWith('\r') ? text.slice(0, -1) : text;
  return body.split(/\r\n|\r|\n/);
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
  let read: string | PageText;
  try {
    read = await source.readText(offset);
  } catch {
    return null;
  }
  const { text, eof } =
    typeof read === 'string' ? { text: read, eof: true } : read;
  return splitLines(text, eof).slice(0, pageLines);
}
