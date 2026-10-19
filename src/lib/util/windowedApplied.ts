// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** What a windowed editor reports after a result: the session it belongs to,
 *  the fresh totals, whether the content equals the last save, and the
 *  session's content generation (a lower one than already seen is stale). */
export type OnApplied = (
  sessionId: number,
  totalBytes: number,
  totalLines: number,
  clean: boolean,
  generation: number,
) => void;
/** The tab an `onapplied` report applies to: the one that holds the reported
 *  session, never whichever tab is active by the time the result arrives.
 *  Undefined when no tab has that session any more. */
export function appliedTarget<
  T extends { windowed?: { sessionId: number } | undefined },
>(tabs: readonly T[], sessionId: number): T | undefined {
  return tabs.find((t) => t.windowed?.sessionId === sessionId);
}
