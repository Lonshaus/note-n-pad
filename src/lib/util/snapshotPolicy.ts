// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** How a tab's buffer should be treated when persisting its snapshot. Snapshot
 *  content exists only to carry unsaved edits across a restart:
 *  - 'full': the tab is dirty and within the ceiling, so serialize the whole
 *    buffer — restoring it is the only way its edits survive a quit.
 *  - 'empty': the tab is clean (any size), so persist an empty string; the
 *    restore path re-reads a clean tab from disk (or, for a range tab, from the
 *    source slice) anyway, and storing megabytes is wasted IPC.
 *  - 'skip': the tab is dirty and over the ceiling, so its buffer is too big to
 *    ride along in a snapshot. The debounced auto-persist skips it (paying the
 *    IPC cost on every keystroke pause is the main large-file editing stall),
 *    and the quit gate blocks exit until the user saves or discards it, so the
 *    unsaved edits are never silently persisted-as-empty and lost. */
export type SnapshotContentPolicy = 'full' | 'empty' | 'skip';

/** Character-count ceiling above which a dirty tab's buffer is too big to keep
 *  in a snapshot. ~16M chars (~32 MB UTF-16 in the WebView) keeps ordinary
 *  files fully persisted while sparing genuinely huge edit-mode opens (up to the
 *  512 MB edit cap) the per-keystroke serialization cost; above it the quit gate
 *  forces the user to save or discard the buffer instead. */
export const SNAPSHOT_CONTENT_MAX = 16_000_000;

/** Character-count ceiling above which a dirty tab's buffer is too big to
 *  re-serialize on every typing pause. At ~1M chars (~2 MB UTF-16) the debounced
 *  auto-persist's whole-buffer IPC write already costs enough to show up as a
 *  periodic mid-size typing stall, so from here up the debounce skips the content
 *  write entirely — see `debounceContentPolicy`. Much lower than
 *  `SNAPSHOT_CONTENT_MAX`: this bounds per-keystroke cost, that bounds what can
 *  ride along in a snapshot at all. */
export const SNAPSHOT_DEBOUNCE_MAX = 1_000_000;

/** Decide how the given tab's content participates in a *full* snapshot — the
 *  flush/close/quit path that runs once per tab switch or exit, where writing the
 *  whole dirty buffer is the only way its unsaved edits survive. A clean tab
 *  always persists empty (disk is the source of truth). A dirty tab persists in
 *  full up to the ceiling (exclusive: content exactly at the ceiling still
 *  persists in full), and 'skip' above it (the quit gate then forces save/discard).
 *  This is the write-in-full authority; `debounceContentPolicy` governs the
 *  high-frequency auto-persist and never widens what this path persists. */
export function snapshotContentPolicy(
  dirty: boolean,
  length: number,
): SnapshotContentPolicy {
  if (!dirty) {
    return 'empty';
  }
  return length <= SNAPSHOT_CONTENT_MAX ? 'full' : 'skip';
}

/** Decide how a tab's content participates in the *debounced* auto-persist — the
 *  high-frequency write triggered while the user is typing. It differs from
 *  `snapshotContentPolicy` on exactly one band: a dirty buffer over
 *  `SNAPSHOT_DEBOUNCE_MAX` (but still within the full-snapshot ceiling) returns
 *  'skip' here where the full path returns 'full'. The debounce skips its whole
 *  upsert for such a tab, so a keystroke pause never serializes 1–16M chars over
 *  IPC; the full flush on tab-switch/close/quit still persists it in full.
 *  Tradeoff: for a dirty mid-to-large tab, a crash *while editing* can lose the
 *  edits made since the last full flush — a normal switch or quit is unaffected.
 *  Clean tabs stay 'empty' and tiny tabs (≤ `SNAPSHOT_DEBOUNCE_MAX`) stay 'full',
 *  so ordinary editing keeps persisting on every pause as before. */
export function debounceContentPolicy(
  dirty: boolean,
  length: number,
): SnapshotContentPolicy {
  if (dirty && length > SNAPSHOT_DEBOUNCE_MAX) {
    return 'skip';
  }
  return snapshotContentPolicy(dirty, length);
}

/** The content to restore into a range tab. A tab left dirty restores its
 *  stored (edited) buffer; a clean range tab defers to the current on-disk
 *  source slice, falling back to the stored buffer only when the source is gone
 *  (`diskSlice` null) — where a clean tab's stored buffer is itself empty,
 *  matching an ordinary tab whose file has vanished. */
export function restoredRangeContent(
  dirty: boolean,
  storedContent: string,
  diskSlice: string | null,
): string {
  if (dirty) {
    return storedContent;
  }
  return diskSlice ?? storedContent;
}
