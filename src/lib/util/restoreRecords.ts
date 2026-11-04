// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import type { NoteSnapshot } from '../state/stickyNote.svelte';
/** Whether `note` is a range tab saved by an earlier version, when a range
 *  opened as a tab of its own. It is not written any more. */
export function isOldRangeRecord(note: NoteSnapshot): boolean {
  return note.kind === 'document' && note.range_source !== null;
}
/** An old range record with nothing unsaved: there is nothing to restore. */
export function isCleanOldRange(note: NoteSnapshot): boolean {
  return isOldRangeRecord(note) && !note.dirty;
}
/** Whether restoring `note` opens an ordinary tab that the stored record does
 *  not describe, so the record is written again right away: an old range
 *  record anywhere, and in the trial a record of the large-file viewer or of
 *  windowed editing (plain or in another encoding), which the trial has none of. */
export function needsRewrite(note: NoteSnapshot, trial: boolean): boolean {
  return (
    isOldRangeRecord(note) ||
    (trial &&
      note.kind === 'document' &&
      (note.large !== null ||
        note.windowed_index !== null ||
        note.windowed_encoding !== null))
  );
}
