// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

/** Rust `fs_ops::stage` refuses to write over a file the user may not write to
 *  with this exact error string, reaching every save path (ordinary save,
 *  `windowed_save`, `splice_file`) (protocol value, matches the Rust
 *  `fs_ops::READ_ONLY_DESTINATION` constant).
 *
 *  Its own module rather than `documentWindow.svelte.ts`, where it used to
 *  live: the sticky window needs it too, and that module ends in a
 *  `new DocumentWindowState()` the sticky bundle would then carry for the sake
 *  of one string. */
export const READ_ONLY_DESTINATION = 'read-only-destination';

/** Why the core could not load one file in a data folder. Matches the Rust
 *  `fs_ops::SkipReason`; the wording for each case lives in the locales. */
export type SkipReason =
  | 'notJson'
  | 'unreadable'
  | 'unparsable'
  | 'invalid'
  | 'foreignId'
  | 'duplicateId';

/** One file a loader passed over, as the core reports it. The file name is all
 *  that crosses: every action offered on it goes back through a command that
 *  resolves the folder itself (Rust `data_files`). */
export interface SkippedFile {
  name: string;
  reason: SkipReason;
}

/** What a list command returns: what loaded, and what did not. */
export interface Loaded<T> {
  items: T[];
  skipped: SkippedFile[];
}

/** Which data folder a `SkippedFile` came from, for `delete_data_file` and
 *  `reveal_data_file`. Matches the Rust `data_files::DataKind`. */
export type DataKind = 'snapshots' | 'themes' | 'locales';
