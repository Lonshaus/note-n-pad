// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

/** The last segment of `path`, splitting on either separator so a Windows path
 *  reads the same on any platform. Empty when there is no last segment (an empty
 *  path, or one ending in a separator), which leaves the stand-in to the caller:
 *  a tab shows "Untitled", a failure message shows the path it was handed. */
export function fileName(path: string): string {
  return path.split(/[/\\]/).pop() ?? '';
}
