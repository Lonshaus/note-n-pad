// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

/** The last segment of `path`, splitting on either separator so a Windows path
 *  reads the same on any platform. Empty when there is no last segment (an empty
 *  path, or one ending in a separator), which leaves the stand-in to the caller:
 *  a tab shows "Untitled", a failure message shows the path it was handed. */
export function fileName(path: string): string {
  return path.split(/[/\\]/).pop() ?? '';
}
/** How this platform compares paths: macOS and Windows ignore case, and only
 *  Windows treats a backslash as a separator (elsewhere it is a name character). */
export interface PathRules {
  caseInsensitive: boolean;
  backslash: boolean;
}

function segmentsOf(path: string, backslash: boolean): RegExpExecArray[] {
  return [...path.matchAll(backslash ? /[^\\/]+/g : /[^/]+/g)];
}
/** `path` with the leading `from` replaced by `to`, when `path` is `from` or lies
 *  below it; otherwise `path` unchanged. Matched by whole segment, so `/a/Tools`
 *  does not match `/a/Tools2`. What follows the moved part is kept verbatim. The
 *  Rust `retarget_path` applies the same rules to the stored records. */
export function retargetPath(
  path: string,
  from: string,
  to: string,
  rules: PathRules,
): string {
  const fromParts = segmentsOf(from, rules.backslash);
  const pathParts = segmentsOf(path, rules.backslash);
  const last = pathParts[fromParts.length - 1];
  if (fromParts.length === 0 || last === undefined) {
    return path;
  }
  const same = (a: string, b: string): boolean =>
    rules.caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
  const inside = fromParts.every((part, i) =>
    same(part[0], pathParts[i]?.[0] ?? ''),
  );
  return inside ? to + path.slice(last.index + last[0].length) : path;
}
