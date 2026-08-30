// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { invoke } from '@tauri-apps/api/core';
import { debounce } from '../util/debounce';
import { nextSeq } from '../util/seq';
import { settingsState } from './settings.svelte';
import { detectByContent, MAX_HIGHLIGHT_CHARS } from '../editor/language';

/** Sparse line-checkpoint index of a windowed-editing tab, mirroring the Rust
 *  `windowed::CheckpointIndex` (snake_case field as serialized). */
export interface CheckpointIndex {
  checkpoints: [number, number][];
  total_newlines: number;
}

export interface NoteSnapshot {
  id: string;
  content: string;
  file_path: string | null;
  language: string | null;
  /** True once the language was set by hand; a false tab keeps auto-detecting.
   *  Persisted so a manual choice (including plain text) survives restart. */
  explicit: boolean;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  pin_mode: PinMode;
  pin_app: string | null;
  opacity: number;
  paper: string;
  kind: 'sticky' | 'document';
  dirty: boolean;
  window_group: string | null;
  tab_index: number;
  line_ending: 'LF' | 'CRLF';
  had_bom: boolean;
  encoding: string;
  project: string | null;
  /** File size of a read-only large-file tab, so restore reopens it in the
   *  large-file view without re-stat. null for ordinary tabs. */
  large: number | null;
  /** Source file a range-edit tab was sliced from; its presence marks the tab as
   *  a range tab on restore. null for every non-range tab. */
  range_source: string | null;
  /** Byte span [range_start, range_end) of the slice within range_source. */
  range_start: number | null;
  range_end: number | null;
  /** Source fingerprint (size + mtime) captured at slice/last-splice time,
   *  restored as the write-back conflict baseline. null for non-range tabs. */
  range_fp_size: number | null;
  range_fp_mtime: number | null;
  /** 1-based line number of the range's first line, fixed at extraction time;
   *  the tab-bar label's end line is derived from the tab's own content line
   *  count instead (see `rangeDisplayName`). null for a non-range tab, and
   *  for a range tab restored from an older snapshot (its old `range_label`
   *  isn't read back). */
  range_start_line: number | null;
  /** Sparse line-checkpoint index of a windowed-editing tab. Its presence is
   *  what marks the tab as "was unlocked" on restore — there is deliberately
   *  no separate boolean for that fact. null for every non-windowed tab. */
  windowed_index: CheckpointIndex | null;
  /** Fingerprint (size + mtime) `windowed_index` was built against, so restore
   *  can validate it before trusting it verbatim. */
  windowed_fp_size: number | null;
  windowed_fp_mtime: number | null;
  /** Sampled digest checked alongside the fingerprint before trusting the
   *  persisted index verbatim. Carried as a decimal string, not a number:
   *  Tauri IPC responses are decoded via `JSON.parse`, which turns every
   *  number into an `f64`, and FNV-1a's 64-bit output loses precision the
   *  large majority of the time under that. A string round-trips exactly. */
  windowed_digest: string | null;
  /** 0-based top-of-viewport line at snapshot time, fed back through
   *  `initialTopLine` on restore. */
  windowed_top_line: number | null;
}

export type PinMode = 'none' | 'top' | 'app';

/** Owns the single note bound to this sticky window. */
class StickyNoteState {
  note = $state<NoteSnapshot | null>(null);
  /** Last upsert, so flush() can await delivery before the window is destroyed. */
  private lastSave: Promise<void> = Promise.resolve();
  /** Set once the user picks a language explicitly; suppresses auto-detection. */
  private explicit = false;
  /** True when the most recent snapshot write did not reach disk. `persist`
   *  never lets a write's rejection propagate through `lastSave` — a stuck
   *  `flush()` would wedge a quit or close — so this is the only surviving
   *  signal that a save failed; cleared by the next write that succeeds. No
   *  UI reads this yet (see the follow-up issue) — it exists so a failure is
   *  not swallowed into nothing. */
  snapshotFailed = $state(false);

  private persist = debounce(() => {
    if (this.note === null) {
      return;
    }
    this.autoDetectContent();
    this.lastSave = invoke<void>('upsert_note', {
      note: { ...this.note },
      seq: nextSeq(),
    })
      .then(() => {
        this.snapshotFailed = false;
      })
      .catch((error: unknown) => {
        this.snapshotFailed = true;
        console.error('upsert_note failed', error);
      });
  }, 500);

  /** Content-based detection for a pathless note the user hasn't overridden. */
  private autoDetectContent(): void {
    const note = this.note;
    if (note === null || note.file_path !== null || this.explicit) {
      return;
    }
    if (note.content.length > MAX_HIGHLIGHT_CHARS) {
      return;
    }
    note.language = detectByContent(note.content);
  }

  async init(id: string): Promise<void> {
    const loaded = await invoke<NoteSnapshot | null>('get_note', { id });
    this.note = loaded;
    if (loaded !== null && loaded.language !== null) {
      this.explicit = true;
    }
  }

  get isEmpty(): boolean {
    return (this.note?.content ?? '').length === 0;
  }

  updateContent(content: string): void {
    if (this.note === null) {
      return;
    }
    this.note.content = content;
    this.persist();
  }

  setLanguage(name: string | null): void {
    if (this.note === null) {
      return;
    }
    this.note.language = name;
    this.explicit = true;
    this.persist();
  }

  /** Logical window bounds captured after a move or resize. */
  setBounds(x: number, y: number, width: number, height: number): void {
    if (this.note === null) {
      return;
    }
    const sizeChanged =
      this.note.width !== width || this.note.height !== height;
    this.note.x = x;
    this.note.y = y;
    this.note.width = width;
    this.note.height = height;
    this.persist();
    if (sizeChanged) {
      // The last-resized sticky size becomes the default for new stickies.
      void settingsState.save({
        default_sticky_width: width,
        default_sticky_height: height,
      });
    }
  }

  setPinMode(mode: PinMode, app: string | null = null): void {
    if (this.note === null) {
      return;
    }
    this.note.pin_mode = mode;
    this.note.pin_app = mode === 'app' ? app : null;
    this.persist();
  }

  setOpacity(opacity: number): void {
    if (this.note === null) {
      return;
    }
    this.note.opacity = opacity;
    this.persist();
  }

  setPaper(paper: string): void {
    if (this.note === null) {
      return;
    }
    this.note.paper = paper;
    this.persist();
  }

  /** Push any pending upsert and wait until it reaches disk. */
  async flush(): Promise<void> {
    this.persist.flush();
    await this.lastSave;
  }

  /** Drop any pending upsert so a following delete can't be undone by it. */
  discard(): void {
    this.persist.cancel();
  }
}

export const stickyNote = new StickyNoteState();
