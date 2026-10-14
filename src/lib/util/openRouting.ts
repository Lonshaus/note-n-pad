// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import type { NoteSnapshot } from '../state/stickyNote.svelte';
import { requiresFullEdition } from './keptTabs';

/** How a fresh file-open should be routed once the note store has been consulted:
 *  - 'fresh': no stored tab for this path in another window group; open normally.
 *  - 'switch': the path is already open in another, still-live document window;
 *    focus that window and its tab instead of opening a duplicate.
 *  - 'adopt': the path has a stored tab in another group whose window is gone
 *    (an orphan). Re-home that note into this window, restoring any unsaved edits
 *    it carries — its snapshot wins over disk. */
export type OpenRoute =
  | { kind: 'fresh' }
  | { kind: 'switch'; group: string; tabIndex: number }
  | { kind: 'adopt'; note: NoteSnapshot };

/** Effective window group of a document note: its window_group, or its own id
 *  when unset (a legacy/solo document is its own single-tab window). */
export function documentGroup(note: NoteSnapshot): string {
  return note.window_group ?? note.id;
}

/** Stored document tabs for `path` that live in a different window group than
 *  `thisGroup` — the candidates a fresh open must reconcile against. In lite a
 *  kept tab (one that needs a removed feature) is not a candidate: adopting it
 *  would load it, and its record must stay as it is. */
export function orphanCandidates(
  notes: NoteSnapshot[],
  path: string,
  thisGroup: string,
  lite: boolean,
): NoteSnapshot[] {
  return notes.filter(
    (n) =>
      n.kind === 'document' &&
      n.file_path === path &&
      documentGroup(n) !== thisGroup &&
      !(lite && requiresFullEdition(n)),
  );
}

/** Decide how to route opening `path` in the window owning `thisGroup`, given the
 *  full note list and the set of window groups whose document window is still
 *  live. Among cross-group matches the best is chosen dirty-first (a note with
 *  unsaved edits outranks a clean one), then by input order — the note store
 *  carries no timestamp, so first-seen is the only stable secondary key. The
 *  chosen note routes to 'switch' when its group is still live, else 'adopt'. */
export function routeOpen(
  notes: NoteSnapshot[],
  path: string,
  thisGroup: string,
  liveGroups: ReadonlySet<string>,
  lite: boolean,
): OpenRoute {
  const candidates = orphanCandidates(notes, path, thisGroup, lite);
  if (candidates.length === 0) {
    return { kind: 'fresh' };
  }
  // Dirty-first, otherwise first-seen (stable): the note carrying unsaved edits
  // is the one worth rescuing or jumping to.
  const best = candidates.reduce((a, b) => (b.dirty && !a.dirty ? b : a));
  const group = documentGroup(best);
  if (liveGroups.has(group)) {
    return { kind: 'switch', group, tabIndex: best.tab_index };
  }
  return { kind: 'adopt', note: best };
}
