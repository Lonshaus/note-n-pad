// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import type { NoteSnapshot } from '../state/stickyNote.svelte';

/** The first tab index above every stored tab of the group, so a tab opened
 *  later never reuses a stored index. */
export function nextTabIndex(entries: NoteSnapshot[]): number {
  return entries.reduce((max, n) => Math.max(max, n.tab_index + 1), 0);
}
