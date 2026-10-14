// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import type { NoteSnapshot } from '../state/stickyNote.svelte';

/** Whether restoring `note` needs a feature the Lite edition removes: the
 *  large-file viewer (`large`), windowed editing (`windowed_index`) or a range
 *  tab (`range_source`). Mirrors `note_store::needs_full_edition` in Rust. */
export function requiresFullEdition(note: NoteSnapshot): boolean {
  return (
    note.kind === 'document' &&
    (note.large !== null ||
      note.windowed_index !== null ||
      note.range_source !== null)
  );
}

/** Split a window group's stored tabs into the ones this session opens and the
 *  kept ones. Full opens everything. In lite a tab that needs a removed feature
 *  is kept: it is not opened, and its record is never written, rewritten or
 *  deleted by this session, because nothing here holds a tab for it. It comes
 *  back, unsaved edits included, once the edition is full. */
export function partitionRestorable(
  entries: NoteSnapshot[],
  lite: boolean,
): { restorable: NoteSnapshot[]; kept: NoteSnapshot[] } {
  if (!lite) {
    return { restorable: entries, kept: [] };
  }
  return {
    restorable: entries.filter((n) => !requiresFullEdition(n)),
    kept: entries.filter(requiresFullEdition),
  };
}

/** The stored tabs of `group` that lite kept and no open tab holds yet: what a
 *  window loads when the edition turns full. Ordered by their stored index. */
export function keptTabsToLoad(
  all: NoteSnapshot[],
  group: string,
  openIds: ReadonlySet<string>,
): NoteSnapshot[] {
  return all
    .filter(
      (n) =>
        n.kind === 'document' &&
        (n.window_group ?? n.id) === group &&
        requiresFullEdition(n) &&
        !openIds.has(n.id),
    )
    .sort((a, b) => a.tab_index - b.tab_index);
}
