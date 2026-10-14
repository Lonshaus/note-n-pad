// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** A line index kept alive on a large-file viewer tab: the Rust index id plus
 *  the file's size and mtime when the scan started. */
export interface LargeIndexRef {
  id: string;
  size: number;
  mtimeMs: number;
}
/** What `index_line_count` answers, or `unknown` when the id is gone. */
export type IndexScanState = 'running' | 'done' | 'failed' | 'unknown';
/** Whether a kept index can serve a remounted viewer: the file is unchanged
 *  since the scan started and the scan is running or finished. A changed file,
 *  a dropped id or a failed scan means the index is rebuilt. */
export function canReuseIndex(
  kept: LargeIndexRef | undefined,
  current: { size: number; mtimeMs: number } | null,
  scan: IndexScanState,
): boolean {
  if (kept === undefined || current === null) {
    return false;
  }
  if (kept.size !== current.size || kept.mtimeMs !== current.mtimeMs) {
    return false;
  }
  return scan === 'running' || scan === 'done';
}
/** The line a remounted view opens at: the line it was last scrolled to, else
 *  the line the tab was opened or restored at, else the first. */
export function remountTopLine(
  viewTop: number | undefined,
  openedAt: number | undefined,
): number {
  return viewTop ?? openedAt ?? 0;
}
