// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Insert a soft break after every this many UTF-16 code units within a single
 *  line. Product rule for the "soft-wrap and open" choice in the open dialog. */
export const SOFT_WRAP_LIMIT = 5_000;

/** Break every line longer than `limit` UTF-16 code units into `limit`-sized
 *  pieces joined by LF, never splitting a surrogate pair. Short lines and the
 *  document's existing line structure are preserved. The buffer is always
 *  LF-normalized before it reaches here; a lone CR left inside a line is treated
 *  as an ordinary character (counted, never a break point). Pure. */
export function softWrapLongLines(
  text: string,
  limit = SOFT_WRAP_LIMIT,
): string {
  return text
    .split('\n')
    .map((line) => (line.length > limit ? breakLongLine(line, limit) : line))
    .join('\n');
}

/** Split one over-long line into `limit`-sized pieces, backing a break off a
 *  trailing surrogate so a pair is never cut across two pieces. */
function breakLongLine(line: string, limit: number): string {
  const parts: string[] = [];
  let start = 0;
  while (start < line.length) {
    let end = Math.min(start + limit, line.length);
    // A break landing on a low (trailing) surrogate would cut the pair; move it
    // back one so the whole pair rides into the next piece.
    if (end < line.length) {
      const code = line.charCodeAt(end);
      if (code >= 0xdc00 && code <= 0xdfff) {
        end -= 1;
      }
    }
    parts.push(line.slice(start, end));
    start = end;
  }
  return parts.join('\n');
}

/** Above this bracket-nesting depth "format" is refused. Pretty-printing indents
 *  each level, so the output grows roughly with depth squared; on JavaScriptCore
 *  (the macOS WebView) `JSON.stringify(…, null, 2)` does not throw on deep input
 *  the way V8 does — it happily builds a multi-gigabyte string and freezes the
 *  window. A file nested past this cap is not human-formattable anyway. */
export const MAX_BEAUTIFY_DEPTH = 500;

/** Maximum `[`/`{` nesting depth of `text`, ignoring brackets inside strings.
 *  Stops early once `cap` is exceeded, so a pathologically deep file costs O(cap)
 *  rather than O(n). Pure. */
export function maxJsonDepth(text: string, cap = MAX_BEAUTIFY_DEPTH): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === '[' || c === '{') {
      depth += 1;
      if (depth > max) {
        max = depth;
        if (max > cap) {
          return max;
        }
      }
    } else if (c === ']' || c === '}') {
      depth -= 1;
    }
  }
  return max;
}

/** Pretty-print JSON with a two-space indent, or null when the text is not JSON
 *  or is nested past MAX_BEAUTIFY_DEPTH. The depth guard runs first (cheap, early
 *  exit) so a pathologically deep single line never reaches JSON.stringify, whose
 *  quadratic indent blowup would freeze the window. The open dialog offers
 *  "format" only when this returns a string. */
export function beautifyJson(text: string): string | null {
  if (maxJsonDepth(text) > MAX_BEAUTIFY_DEPTH) {
    return null;
  }
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}
