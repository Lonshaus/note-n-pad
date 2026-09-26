// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

export interface MatchSegment {
  text: string;
  hit: boolean;
}

/** ASCII-only lowercase, the same folding the Rust stream search uses
 *  (`eq_ignore_ascii_case`), so every highlighted span is one it matched. */
function foldAscii(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Split `text` into alternating plain and matching runs of `query`,
 *  non-overlapping, left to right. An empty query yields the text unmarked. */
export function matchSegments(
  text: string,
  query: string,
  caseSensitive: boolean,
): MatchSegment[] {
  if (query === '') {
    return text === '' ? [] : [{ text, hit: false }];
  }
  const hay = caseSensitive ? text : foldAscii(text);
  const needle = caseSensitive ? query : foldAscii(query);
  const out: MatchSegment[] = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) {
      break;
    }
    if (at > from) {
      out.push({ text: text.slice(from, at), hit: false });
    }
    out.push({ text: text.slice(at, at + needle.length), hit: true });
    from = at + needle.length;
  }
  if (from < text.length) {
    out.push({ text: text.slice(from), hit: false });
  }
  return out;
}
