// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import type { NoteSnapshot } from '../state/stickyNote.svelte';

/** One document tab row in the workspace list. */
export interface DocRow {
  id: string;
  group: string;
  tabIndex: number;
  name: string;
  dirty: boolean;
  filePath: string | null;
}

/** A document window's tabs, grouped for the workspace list. */
export interface DocGroup {
  group: string;
  rows: DocRow[];
}

/** Whether a freshly opened single-file window should collapse itself because
 *  the open produced nothing to show. True only when a path was requested but
 *  no tab opened AND nothing is on screen waiting to be read or answered — the
 *  large-file gate, the long-line open dialog, or the failed-open report. Every
 *  such state needs its own flag here; forgetting one destroys the window
 *  mid-dialog (the long-line flash-close bug, then the same again for the
 *  failed-open report). */
export function shouldCollapseEmptyWindow(
  hasInitialPath: boolean,
  tabCount: number,
  pendingLargeOpen: boolean,
  pendingLongLineOpen: boolean,
  openFailed: boolean,
): boolean {
  return (
    hasInitialPath &&
    tabCount === 0 &&
    !pendingLargeOpen &&
    !pendingLongLineOpen &&
    !openFailed
  );
}

/** Basename of a file path, or "Untitled" for an empty/null path. */
function basename(path: string | null): string {
  if (path === null || path === '') {
    return 'Untitled';
  }
  return path.split(/[/\\]/).pop() || 'Untitled';
}

/** Group document-kind notes into their windows (by window_group, falling back
 *  to the note id). Groups keep first-appearance order; rows sort by tab_index.
 *  Stickies and other non-document notes are ignored. */
export function groupOpenDocuments(notes: NoteSnapshot[]): DocGroup[] {
  const order: string[] = [];
  const byGroup = new Map<string, DocRow[]>();
  for (const note of notes) {
    if (note.kind !== 'document') {
      continue;
    }
    const group = note.window_group ?? note.id;
    let rows = byGroup.get(group);
    if (rows === undefined) {
      rows = [];
      byGroup.set(group, rows);
      order.push(group);
    }
    rows.push({
      id: note.id,
      group,
      tabIndex: note.tab_index,
      name: basename(note.file_path),
      dirty: note.dirty,
      filePath: note.file_path,
    });
  }
  return order.map((group) => ({
    group,
    rows: byGroup.get(group)!.sort((a, b) => a.tabIndex - b.tabIndex),
  }));
}

/** The `tab` URL parameter a restored document window was opened with, as a
 *  stored `tab_index`. Null when absent or not an integer — the window then
 *  activates its first tab. Written against the raw string, not a pre-parsed
 *  number: `Number(null)` is 0, which would silently pin every ordinary restore
 *  to tab 0 rather than leaving the choice open. */
export function parseInitialTab(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const value = Number(raw);
  return Number.isInteger(value) ? value : null;
}

/** Array position of the tab carrying `initialTab` among a group's restored
 *  tabs, given their stored `tab_index` values in restore order. Closes and
 *  reorders make position and `tab_index` diverge, so the two are never used
 *  interchangeably. Falls back to the first tab when there is no request or the
 *  requested index is no longer in the group. */
export function resolveTabPosition(
  storedIndices: number[],
  initialTab: number | null,
): number {
  if (initialTab === null) {
    return 0;
  }
  const at = storedIndices.indexOf(initialTab);
  return at === -1 ? 0 : at;
}
