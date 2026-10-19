// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';
import { debounce } from '../util/debounce';
import { nextSeq } from '../util/seq';
import {
  detectByFilename,
  docHasLongLine,
  restoredLanguage,
} from '../editor/language';
import { beautifyJson, softWrapLongLines } from '../util/longLine';
import {
  KeptRestore,
  UnreadableRestore,
  activePositionAfterRestore,
  restoreOutcome,
} from '../util/restoreOutcome';
import { saveDialogOptions, suggestedName } from '../util/saveDialog';
import { Text } from '@codemirror/state';
import {
  detectLineEnding,
  normalizeToLf,
  applyLineEnding,
  textFromString,
  textEq,
  type LineEnding,
} from '../util/text';
import {
  rangeWriteText,
  replacementByteLength,
  sliceEndsWithBreak,
} from '../util/rangeEdit';
import { detectBreakStyle } from '../util/windowedEdit';
import { createOpGate, type OpGate } from '../util/windowedGate';
import {
  routeOpen,
  orphanCandidates,
  documentGroup,
  type OpenRoute,
} from '../util/openRouting';
import type { CheckpointIndex, NoteSnapshot } from './stickyNote.svelte';
import { settingsState } from './settings.svelte';
import { editionState, isLite } from './edition.svelte';
import {
  keptTabsToLoad,
  partitionRestorable,
  windowBoundsRecord,
} from '../util/keptTabs';
import { isOrdinaryTab, pickHeldTab, touchMru } from './heldTab';
import type { LargeIndexRef } from '../util/largeIndex';
import {
  snapshotContentPolicy,
  debounceContentPolicy,
  restoredRangeContent,
} from '../util/snapshotPolicy';
import { t } from '../i18n';
import { rangeLabel } from '../util/rangeLabel';
import { READ_ONLY_DESTINATION, isLiteRefusal } from '../util/protocol';
import { appliedTarget } from '../util/windowedApplied';

/** Rust `splice_file` rejects an out-of-band-edited source with this exact error
 *  string; the write-back keys its conflict flow off it (protocol value). */
const FINGERPRINT_MISMATCH = 'fingerprint-mismatch';

/** Cross-window broadcast: a source file was rewritten by a splice, so any large
 *  viewer showing it must rebuild its line index. Carries the affected path. */
export const RANGE_SPLICED_EVENT = 'range-spliced';

/** Rust `windowed_open` rejects a non-UTF-8 file with this exact error string;
 *  the open flow surfaces it as a refusal (protocol value). */
const WINDOWED_NOT_UTF8 = 'not-utf8';

/** Rust `windowed_open` / `windowed_reopen` reject a file at or above
 *  `LARGE_EDIT_MAX` with this exact error string (protocol value, matches the
 *  Rust `TOO_LARGE` constant). */
const WINDOWED_TOO_LARGE = 'too-large';

/** Reason `unlockLargeTab` and the lazy restore path both key their disabled
 *  lock message off, so an oversized file and a non-UTF-8 file are explained
 *  the same way regardless of which entry point hit the refusal. */
type WindowedRefusalReason = 'notUtf8' | 'tooLarge' | 'cannot';

/** Map a windowed unlock/reopen failure to its reason (see
 *  `WindowedRefusalReason`). Pure: no i18n lookup here, just the dispatch on
 *  the protocol error string, so it is unit-testable without the translation
 *  table. */
export function windowedRefusalReason(error: string): WindowedRefusalReason {
  if (error === WINDOWED_NOT_UTF8) {
    return 'notUtf8';
  }
  if (error === WINDOWED_TOO_LARGE) {
    return 'tooLarge';
  }
  return 'cannot';
}
/** Whether `tab` is a read-only large view, a windowed-editing tab or one about to
 *  become one: its bytes stay as they are on disk, so its line ending and
 *  encoding are not changeable. */
function isLargeKind(tab: DocTab): boolean {
  return (
    tab.large !== undefined ||
    tab.windowed !== undefined ||
    tab.windowedRestore !== undefined
  );
}

/** `windowedRefusalReason` resolved to its `doc.edit.*` translation, the
 *  message shown on a tab's disabled lock (see `DocTab.large.unlockRefused`). */
function windowedRefusalMessage(error: string): string {
  switch (windowedRefusalReason(error)) {
    case 'notUtf8':
      return t('doc.edit.notUtf8');
    case 'tooLarge':
      return t('doc.edit.tooLarge');
    case 'cannot':
      return t('doc.edit.cannot');
  }
}

/** A windowed tab's snapshot is always clean, regardless of
 *  `liveDirty` (the live quit-gate flag `firstOversizedDirtyIndex` reads
 *  straight off state, correctly untouched by this). Its unsaved edits live
 *  only in the Rust piece table and never ride along in the JSON snapshot
 *  (`content` stays `''`), so persisting `dirty: true` next to that empty
 *  content would advertise edits nothing can restore — what cannot be
 *  restored must not be advertised as pending. Pure so the always-clean rule
 *  is unit-tested independent of the live tab/session plumbing. */
export function windowedSnapshotDirty(
  isWindowed: boolean,
  liveDirty: boolean,
): boolean {
  return isWindowed ? false : liveDirty;
}

/** A snapshot's `large` field prefers the on-disk size a windowed
 *  tab's fingerprint carries (`windowedFingerprintSize`) over its live,
 *  possibly post-edit `windowedTotalBytes`. Persisting `totalBytes` instead
 *  could disable the restore lock for a file that had actually shrunk back
 *  under the windowed-editing size ceiling after edits, since restore would
 *  then see a size under the threshold and treat it as an ordinary tab.
 *  Pure so the priority order is unit-tested independent of the live
 *  tab/session plumbing. */
export function windowedSnapshotLarge(
  plainLargeSize: number | null,
  windowedFingerprintSize: number | null,
  windowedTotalBytes: number | null,
): number | null {
  return (
    plainLargeSize ?? windowedFingerprintSize ?? windowedTotalBytes ?? null
  );
}

/** How long a lazy windowed restore waits before falling back to the read-only
 *  viewer while `windowed_reopen` is still in flight. The fast path (index,
 *  fingerprint, and digest all match) resolves in microseconds and always wins
 *  this race; only a genuine rescan (the file changed on disk while the app was
 *  closed) is still pending when it fires, and only then does the tab drop to
 *  the honest read-only/indexing state instead of blocking the switch. */
const WINDOWED_RESTORE_GRACE_MS = 120;

/** Rust `windowed_save` rejects an out-of-band-edited source with an error string
 *  containing this token; the save flow keys its conflict modal off it. */
const WINDOWED_FINGERPRINT_MISMATCH = 'fingerprint-mismatch';

/** Result of a windowed-save/apply/conflict write-back: written, refused for a
 *  conflict (the conflict modal is now up), or failed for another reason. */
export type WindowedSaveResult = 'ok' | 'mismatch' | 'error';

/** Result of the Rust `windowed_open` command (snake_case as serialized). */
interface WindowedOpen {
  session_id: number;
  total_bytes: number;
  total_lines: number;
  fingerprint: Fingerprint;
}

/** Result of the Rust `windowed_save` command. */
interface WindowedSaved {
  fingerprint: Fingerprint;
  total_bytes: number;
  total_lines: number;
  clean: boolean;
  generation: number;
}

/** Result of the Rust `windowed_reopen` command. `rescanned` is true when a
 *  full rescan ran (the persisted index couldn't be trusted verbatim) — the
 *  restore path uses it to decide whether the fast path already won the race
 *  against `WINDOWED_RESTORE_GRACE_MS` or a real rescan is under way. */
interface WindowedReopened {
  session_id: number;
  total_bytes: number;
  total_lines: number;
  fingerprint: Fingerprint;
  rescanned: boolean;
}

/** Result of the Rust `windowed_index` command: a live session's checkpoint
 *  index plus the fingerprint and digest it was built against, for persisting
 *  (see `snapshot()`) and later handing back to `windowed_reopen`. */
interface WindowedIndexSnapshot {
  index: CheckpointIndex;
  fingerprint: Fingerprint;
  /** Decimal string, not a number — see `NoteSnapshot.windowed_digest`. */
  digest: string;
}

/** Result of a range-tab write-back: written, refused for a conflict (the
 *  conflict modal is now up), or failed for another reason. */
export type SpliceResult = 'ok' | 'mismatch' | 'error';

/** A byte slice decoded as text plus whether the decode was lossy (invalid
 *  UTF-8 replaced), mirroring the Rust `ReadRange`. */
interface RangeRead {
  text: string;
  lossy: boolean;
}

/** Result of a Rust decode command; content is BOM-free, line endings intact. */
interface Decoded {
  content: string;
  encoding: string;
  had_bom: boolean;
  lossy: boolean;
}

interface FileStat {
  size: number;
}

/** Cheap on-disk identity of the source file at the moment a range was read,
 *  mirroring the Rust `Fingerprint` (snake_case fields as serialized). The next
 *  step keys the splice write-back's conflict check off this. */
export interface Fingerprint {
  size: number;
  mtime_ms: number;
}

/** Above this size an open routes to the read-only large-file view instead of a
 *  full decode. A constant for now; a future setting can override it. */
export const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024;
/** Hard ceiling for offering "open in edit mode" on a large file: loading a file
 *  this big whole would blow the WebView's memory, so above it the confirm only
 *  offers the read-only view. */
export const LARGE_EDIT_MAX = 512 * 1024 * 1024;

/** Whether a file of `size` bytes opens in the read-only large-file viewer. The
 *  Lite edition has no viewer: every size opens in the ordinary editor. */
export function opensInLargeViewer(size: number, lite: boolean): boolean {
  return !lite && size > LARGE_FILE_THRESHOLD;
}

/** One open document tab. The buffer (`content`) is always LF-normalized. It is a
 *  CodeMirror `Text` (rope), not a string, so a keystroke costs O(edit) instead of
 *  copying the whole buffer; string materialization happens only at flush points
 *  (save, snapshot, splice). `savedContent` is the saved baseline it is diffed
 *  against; a save shares one rope between the two, making the dirty check O(1). */
export interface DocTab {
  id: string;
  path: string;
  /** Whether a save aimed at `path` would be refused by the OS/filesystem
   *  permissions, per Rust `path_writable`. False for a tab with no path yet
   *  (untitled). Drives the disabled pen and the status-bar read-only badge,
   *  and is set true if a save is ever refused with `read-only-destination`
   *  (the file can turn read-only while open). */
  readOnlyFile: boolean;
  content: Text;
  savedContent: Text;
  language: string | null;
  explicit: boolean;
  lineEnding: LineEnding;
  savedLineEnding: LineEnding;
  /** Large and windowed tabs only: the separator typed line breaks are written
   *  with, set together with `lineEnding` once the file's own ending has been
   *  read. Undefined means not detected yet. Never persisted: a restored tab
   *  detects again from its first window. */
  insertLineEnding?: '\r\n' | '\n';
  hadBom: boolean;
  encoding: string;
  /** Transient: set when the last decode produced replacement characters. */
  lossy: boolean;
  tabIndex: number;
  /** Present only on a read-only large-file tab: its content is never loaded,
   *  it is never dirty, and it does not participate in snapshots. `unlockRefused`
   *  is set (to the reason shown on the tab lock) once an in-place unlock is
   *  refused, e.g. a non-UTF-8 file; the lock then stays disabled. */
  large?: { size: number; unlockRefused?: string };
  /** Present only on a range tab: an ordinary editable buffer seeded from a byte
   *  slice of `sourcePath`. Cmd+S splices the edited buffer back into the source
   *  over `[startByte, endByte)`, using `fingerprint` as the conflict baseline. A
   *  successful splice rebases `endByte` and refreshes `fingerprint`. */
  range?: {
    sourcePath: string;
    startByte: number;
    endByte: number;
    fingerprint: Fingerprint | null;
    /** 1-based line number of the range's first line, fixed at extraction
     *  time: nothing before this tab's content can shift while it stays open,
     *  so unlike `endByte`/`endLine` this never needs rebasing after a splice.
     *  Null only for a tab restored from an older snapshot that persisted a
     *  formatted label instead of a line number — see `rangeDisplayName`. */
    startLine: number | null;
    /** Whether the source slice ended with a line break. `splice` adds one to
     *  what it writes when the buffer ended up without one, so text typed on the
     *  last line cannot join the next source line. */
    trailingBreak: boolean;
  };
  /** Present only on a windowed-editing tab: the buffer lives in the Rust core,
   *  streamed a window at a time by the WindowedEditor. `content`/`savedContent`
   *  stay empty (isDirty for this tab reads `windowed.dirty`, set by the first
   *  successful apply and cleared on save/discard). `sessionId` identifies the
   *  Rust session; `fingerprint` is the save conflict baseline. */
  windowed?: {
    sessionId: number;
    totalBytes: number;
    totalLines: number;
    fingerprint: Fingerprint | null;
    dirty: boolean;
    /** The 0-based top-of-viewport line, live-mirrored from the WindowedEditor
     *  (see `windowedTopLineChanged`) so a full snapshot can persist it as
     *  `windowed_top_line` — restore feeds it back through `initialLine`. */
    topLine: number;
    /** The 0-based line the WindowedEditor should open its first window at: an
     *  in-place unlock seeds it from the line being viewed, a lazy restore seeds
     *  it from the persisted `windowed_top_line`. Not itself persisted — it is
     *  read once at construction time; `snapshot()` derives the persisted value
     *  fresh from the live WindowedEditor instead (see `windowedInfo`). */
    initialLine?: number;
  };
  /** Present only right after a restart, on a tab that was a windowed-editing
   *  tab last session: it "knows it was unlocked" but carries no live Rust
   *  session yet. `beginWindowedRestore` consumes this once (clearing it) to
   *  reopen the session and swap the tab over to `windowed`, lazily — see the
   *  class doc for the fast/slow-path contract. Never persisted itself (the
   *  snapshot fields it was built from are what's persisted; see `snapshot()`). */
  windowedRestore?: {
    index: CheckpointIndex;
    fingerprint: Fingerprint;
    /** Decimal string, not a number — see `NoteSnapshot.windowed_digest`. */
    digest: string;
    topLine: number;
    /** On-disk size at snapshot time, the fallback tab's `large.size` if the
     *  restore falls back to the read-only viewer. */
    size: number;
  };
  /** True when this tab's most recent snapshot write attempted its full
   *  content (not the size-ceiling 'skip' path) and failed to reach disk —
   *  the snapshot folder missing/unwritable, the disk full, made read-only.
   *  Cleared by the next write that succeeds. See `firstUnwritableDirtyIndex`. */
  writeFailed?: boolean;
}

/** The tab-bar/window-title label for a range tab: "{name} (lines X–Y)"
 *  through `t()`, so a language change or a locale edit is reflected the next
 *  time this is called rather than frozen at extraction time. The end line is
 *  derived from the tab's own content line count, so it stays correct after an
 *  edit that changes the line count (`splice` rebases `endByte` but has
 *  nothing else to keep in sync); `snapshot()` persists it as `range_end_line`
 *  for views that do not open the tab. Returns null for
 *  a non-range tab, or for a range tab restored from an older snapshot that
 *  carries no start line (its formatted label wasn't persisted in a form line
 *  numbers can be recovered from) — the caller's own fallback (the file name)
 *  covers that case, matching a fresh range tab's degraded display. */
export function rangeDisplayName(tab: DocTab): string | null {
  const r = tab.range;
  const endLine = rangeEndLine(tab);
  if (r === undefined || r.startLine === null || endLine === null) {
    return null;
  }
  return rangeLabel(r.sourcePath, r.startLine, endLine);
}
/** 1-based line number of a range tab's last line, from its live content: the
 *  start line plus the lines the buffer covers. Null for a non-range tab and
 *  for a range tab with no start line (restored from an older snapshot). */
export function rangeEndLine(tab: DocTab): number | null {
  const r = tab.range;
  if (r === undefined || r.startLine === null) {
    return null;
  }
  return r.startLine + rangeLineCount(tab) - 1;
}
/** Number of source lines a range tab's buffer covers (at least 1). The slice's
 *  end offset is the start of the line *after* the last selected line (see
 *  `LargeFileView.svelte`'s `selectionByteRange`), so the content almost always
 *  ends with the last selected line's trailing newline. `Text.lines` counts the
 *  empty line that trailing newline opens, so it overcounts by one versus the
 *  real number of selected lines, except for the one case where the extraction
 *  reached EOF of a file with no final newline. Detect that trailing newline
 *  directly instead of assuming either shape, so an empty range (`Text.empty`,
 *  no trailing newline) still yields a single displayed line. */
function rangeLineCount(tab: DocTab): number {
  const content = tab.content;
  const endsWithNewline =
    content.length > 0 && content.sliceString(content.length - 1) === '\n';
  return content.lines - (endsWithNewline ? 1 : 0);
}

interface Bounds {
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
}

/** Owns every tab living in one document window (grouped by window_group).
 *
 * Restoring a windowed-editing tab (`DocTab.windowedRestore`, see
 * `beginWindowedRestore`) is lazy: the tab restores knowing it was unlocked
 * but with no live Rust session, and reopening happens once it becomes the
 * active tab. `windowed_reopen`'s fast path (persisted index/fingerprint/
 * digest all still match) resolves in microseconds and always wins the race
 * against `WINDOWED_RESTORE_GRACE_MS`, so the tab swaps straight to `windowed`
 * having rendered neither the read-only viewer nor the pen icon for a single
 * frame. Only a genuine rescan (the file changed on disk while the app was
 * closed) is still pending when the grace timer fires, and only then does the
 * tab fall back to the read-only viewer — the existing large-index-progress
 * indicator is what shows that honestly, not a new one. */
class DocumentWindowState {
  group = '';
  /** Project root this window is bound to, or null for a projectless window.
   *  Set from the URL on a fresh window; adopted from the group's notes on
   *  restore. Every tab snapshot persists it, isolating tree-opens per project. */
  project: string | null = null;
  tabs = $state<DocTab[]>([]);
  #activeIndexState = $state(0);
  /** Index of the active tab. This is the single funnel every code path that
   *  changes which tab is active must write through: the setter always re-
   *  checks whether the newly active tab needs its windowed session lazily
   *  reopened (`ensureWindowedRestore`), even when the numeric index is
   *  unchanged (e.g. closing tab 0 while it was active leaves `activeIndex`
   *  at 0, but the tab now living at that index is a different one). */
  get activeIndex(): number {
    return this.#activeIndexState;
  }

  set activeIndex(index: number) {
    this.noteOrdinary(this.activeTab);
    this.#activeIndexState = index;
    this.noteOrdinary(this.activeTab);
    this.ensureWindowedRestore(this.activeTab);
  }
  /** Ids of ordinary tabs, most recently active first: the editor keeps the
   *  latest one mounted while a windowed or large-file tab is shown. */
  ordinaryMru = $state<string[]>([]);
  private noteOrdinary(tab: DocTab | null): void {
    if (tab !== null && isOrdinaryTab(tab)) {
      this.ordinaryMru = touchMru(this.ordinaryMru, tab.id);
    }
  }
  /** The ordinary tab the editor holds (see `pickHeldTab`). */
  get heldTab(): DocTab | null {
    return pickHeldTab(this.tabs, this.activeIndex, this.ordinaryMru);
  }
  /** Where each windowed tab was last looking, by tab id: the viewport's top
   *  line and the caret (global, 1-based line and column). In memory only and
   *  not reactive: it is read when an editor remounts, never rendered. */
  private viewPos = new Map<
    string,
    { top?: number; caretLine?: number; caretCol?: number }
  >();
  /** The line index each large-file viewer tab keeps alive across tab
   *  switches, by tab id. Dropped when the tab closes, the window closes, the
   *  file is rewritten or the tab unlocks. */
  private largeIndexes = new Map<string, LargeIndexRef>();
  /** The pending-operation gate of each windowed session, by session id: a
   *  replace all (or its undo or redo) runs in the Rust core and can outlive
   *  the editor that started it, since the editor is mounted only for the
   *  active tab. Not reactive; an editor reads it when it mounts. */
  private windowedGates = new Map<number, OpGate>();
  /** The newest content generation each windowed session has reported, by
   *  session id: a result with a lower one is stale and changes nothing. */
  private windowedGenerations = new Map<number, number>();
  viewTopLine(id: string): number | undefined {
    return this.viewPos.get(id)?.top;
  }
  setViewTopLine(id: string, line: number): void {
    this.viewPos.set(id, { ...this.viewPos.get(id), top: line });
  }
  viewCaret(id: string): { line: number; col: number } | undefined {
    const pos = this.viewPos.get(id);
    return pos?.caretLine === undefined || pos.caretCol === undefined
      ? undefined
      : { line: pos.caretLine, col: pos.caretCol };
  }
  setViewCaret(id: string, line: number, col: number): void {
    this.viewPos.set(id, {
      ...this.viewPos.get(id),
      caretLine: line,
      caretCol: col,
    });
  }
  largeIndex(id: string): LargeIndexRef | undefined {
    return this.largeIndexes.get(id);
  }
  /** Record (or, with null, forget) a viewer tab's kept line index. An index
   *  reported for a tab that is gone or no longer a viewer is released. */
  setLargeIndex(id: string, ref: LargeIndexRef | null): void {
    if (ref === null) {
      this.largeIndexes.delete(id);
      return;
    }
    const tab = this.tabs.find((t) => t.id === id);
    if (tab?.large === undefined) {
      if (!__LITE__) {
        void invoke('drop_line_index', { id: ref.id });
      }
      return;
    }
    this.largeIndexes.set(id, ref);
  }
  private dropLargeIndex(id: string): void {
    const ref = this.largeIndexes.get(id);
    if (ref !== undefined) {
      this.largeIndexes.delete(id);
      if (!__LITE__) {
        void invoke('drop_line_index', { id: ref.id });
      }
    }
  }
  private releaseTabView(id: string): void {
    this.viewPos.delete(id);
    this.dropLargeIndex(id);
  }
  /** Cursor position of the active tab, mirrored into the status bar. */
  line = $state(1);
  col = $state(1);
  /** Gate rendering the editor until the initial tabs have loaded. */
  ready = $state(false);
  /** Bumped to force the editor to reload the active tab's buffer from state,
   *  e.g. after re-decoding under a new encoding (content changed externally). */
  reloadSeq = $state(0);
  /** The id of the tab the last `reloadSeq` bump was meant for. */
  reloadTargetId = '';
  /** Bumped after a splice rewrites a source file whose large-file viewer tab is
   *  in this window, so the keyed view remounts and rebuilds its line index. */
  largeReloadSeq = $state(0);
  /** The range tab whose splice hit a fingerprint conflict, awaiting the user's
   *  choice (force-write / save-as / cancel). Null when no conflict is pending;
   *  DocumentApp renders the conflict modal off this. */
  rangeConflict = $state<DocTab | null>(null);
  /** The windowed tab whose save hit a fingerprint conflict, awaiting the user's
   *  choice (force-write / save-as / cancel). Null when none is pending. */
  windowedConflict = $state<DocTab | null>(null);
  /** Set while an over-threshold file awaits the open-mode confirm. The window
   *  shows the confirm modal; resolving it opens the view, the editor, or
   *  nothing (cancel). */
  pendingLargeOpen = $state<{ path: string; size: number } | null>(null);
  /** Set while a freshly opened file with an over-threshold line awaits the
   *  open-mode confirm. Carries the path and whether the "format" choice
   *  applies (the content beautifies as JSON). The loaded tab itself is staged
   *  off the reactive graph in `pendingLongLineTab` (it holds a large rope). */
  pendingLongLineOpen = $state<{
    path: string;
    formatAvailable: boolean;
  } | null>(null);
  /** Path of a fresh open that could not be read — deleted, unreadable, or
   *  named in bytes this side cannot address. Reported rather than opened as a
   *  blank tab, which would save over a path the user never chose. */
  openFailed = $state<string | null>(null);
  /** Paths of restored clean tabs that exist but could not be read. They are
   *  not opened (a blank tab would pass for the file); reported once. */
  restoreUnreadable = $state<string[]>([]);
  /** How many of this window's stored tabs a lite session left closed: the ones
   *  that need the large-file viewer, windowed editing or range editing. Their
   *  records are not touched, and they open once the edition is full. Shown once
   *  as a notice; zero otherwise. */
  keptTabs = $state(0);
  /** True when the most recent snapshot write did not reach disk. `upsertTab`
   *  never lets a write's rejection propagate (see its own comment), so this
   *  is the only surviving signal that a save failed; cleared by the next
   *  write that succeeds. No UI reads this yet (see the follow-up issue) —
   *  it exists so a failure is not swallowed into nothing. */
  snapshotFailed = $state(false);

  /** Dismiss the kept-tabs notice. */
  dismissKeptTabs(): void {
    this.keptTabs = 0;
  }
  /** Dismiss the kept-tabs notice of a window that is about to close. When no
   *  tab is left the core is told to hold the group back, so it returns when
   *  the edition is full; resolves `true` then, and the window should be
   *  destroyed. Nothing else holds a group back. */
  async dismissKeptTabsAndHoldBack(): Promise<boolean> {
    this.dismissKeptTabs();
    if (this.tabs.length > 0) {
      return false;
    }
    await invoke('hold_back_group', { group: this.group });
    return true;
  }

  /** Dismiss the unreadable-restore report. */
  dismissRestoreUnreadable(): void {
    this.restoreUnreadable = [];
  }

  /** Dismiss the failed-open report. */
  dismissOpenFailed(): void {
    this.openFailed = null;
  }

  /** Set when a write to disk (save, save-as, or a range-conflict save-as)
   *  rejects. Carries the path and the error text so the user learns which
   *  file failed and why, rather than the save silently doing nothing. The
   *  tab itself is left dirty by the caller, exactly as an unhandled
   *  rejection would have — this only makes the failure observable. */
  saveFailed = $state<{ path: string; error: string } | null>(null);

  /** Dismiss the failed-save report. */
  dismissSaveFailed(): void {
    this.saveFailed = null;
  }

  /** Path of a clean tab whose re-decode (`setEncoding`) failed — deleted,
   *  unreadable, or a permissions change since it was opened. Reported rather
   *  than swallowed, which used to leave the encoding picker silently
   *  snapping back with no explanation. */
  encodingFailed = $state<string | null>(null);

  /** Dismiss the failed-encoding-change report. */
  dismissEncodingFailed(): void {
    this.encodingFailed = null;
  }

  private bounds: Bounds = { x: null, y: null, width: null, height: null };
  /** The decoded-but-not-yet-committed tab behind `pendingLongLineOpen`. */
  private pendingLongLineTab: DocTab | null = null;
  /** The beautified JSON for that pending tab, computed once at open, or null
   *  when the content does not beautify (not JSON, or too deeply nested to
   *  pretty-print). `formatAvailable` mirrors `!== null`. */
  private pendingLongLineFormatted: string | null = null;
  private nextIndex = 0;
  private lastSave: Promise<void> = Promise.resolve();
  /** Tab ids with a `beginWindowedRestore` in flight, so re-activating a tab
   *  mid-restore (switch away and back) never starts a second reopen. Plain
   *  (non-reactive) Set: it is a dedupe guard, not render state. */
  private restoringWindowedIds = new Set<string>();
  /** `rescanned` from the most recently completed `windowed_reopen` call, or
   *  null before any restore has completed. E2E-only: the fast/slow-path
   *  outcome isn't otherwise observable from the automation surface (a poll on
   *  `isWindowedTab()` alone passes on either path — see
   *  `scripts/e2e/e2e-windowed.sh`), so this is what lets a restart-restore
   *  test assert the fast path actually fired instead of a rescan that merely
   *  finished in time. */
  private lastWindowedRestoreRescanned: boolean | null = null;

  private persistActive = debounce(() => {
    const tab = this.activeTab;
    if (tab === null) {
      return;
    }
    // Skip the debounced auto-persist for a dirty buffer past the debounce
    // ceiling (mid-size 1–16M chars and up): serializing the whole buffer over
    // IPC on every typing pause is the periodic mid-size typing stall, and for a
    // truly oversized buffer it is unaffordable outright. Skipping the whole
    // upsert — never writing empty content — leaves the last full snapshot intact
    // so restore never mistakes an unsaved edit for a saved-empty tab. The full
    // flush on switch/close/quit (upsertTab via snapshotContentPolicy) still
    // persists the dirty buffer in full up to the snapshot ceiling; above that
    // ceiling the quit gate (firstOversizedDirtyIndex) blocks exit until the user
    // saves or discards. Only a crash while editing such a tab mid-stroke drops
    // the edits since the last full flush.
    if (
      debounceContentPolicy(this.isDirty(tab), tab.content.length) === 'skip'
    ) {
      return;
    }
    void this.upsertTab(tab);
  }, 500);

  get activeTab(): DocTab | null {
    return this.tabs[this.activeIndex] ?? null;
  }

  isLarge(tab: DocTab): boolean {
    return tab.large !== undefined;
  }

  isDirty(tab: DocTab): boolean {
    if (tab.large !== undefined) {
      return false;
    }
    // A windowed tab's buffer lives in the Rust core; dirtiness is tracked as a
    // flag (set by the first apply, cleared on save/discard), not by comparing
    // its (always-empty) content against a saved baseline.
    if (tab.windowed !== undefined) {
      return tab.windowed.dirty;
    }
    return (
      !textEq(tab.content, tab.savedContent) ||
      tab.lineEnding !== tab.savedLineEnding
    );
  }

  isWindowed(tab: DocTab): boolean {
    return tab.windowed !== undefined;
  }

  private async snapshot(tab: DocTab): Promise<NoteSnapshot> {
    // A windowed tab's edits live in the Rust piece table, never in `content`
    // (which stays the empty rope it was constructed with). Its checkpoint
    // index/fingerprint/digest, read fresh here, are what let restore rebuild
    // the session with no rescan (see `windowed_index`); the on-disk size the
    // fingerprint carries is also what `large` persists (persisting
    // `totalBytes`, the post-edit size, could disable the restore lock for a
    // file that had actually shrunk back under the ceiling). A session that
    // vanished between the dirty check and this fetch (closed mid-flush)
    // degrades to no index rather than throwing; `windowed?.totalBytes` is a
    // last-resort fallback so the tab still restores as *something* large.
    let windowedIndexSnap: WindowedIndexSnapshot | null = null;
    if (!__LITE__ && tab.windowed !== undefined) {
      try {
        windowedIndexSnap = await invoke<WindowedIndexSnapshot>(
          'windowed_index',
          { sessionId: tab.windowed.sessionId },
        );
      } catch {
        windowedIndexSnap = null;
      }
    }
    // A tab mid-restore (`windowedRestore` set, neither `windowed` nor `large`
    // yet — see the class doc) has no live session to query `windowed_index`
    // against, but it already carries everything a live windowed tab's
    // snapshot needs: the persisted index/fingerprint/digest/topLine it was
    // itself restored from. Without this, any snapshot taken before
    // `beginWindowedRestore` finishes (e.g. a window move/resize going through
    // `setBounds`) would persist `windowed_index: null` and wipe the only
    // marker that the tab was ever unlocked.
    const pendingRestore = tab.windowedRestore;
    const windowedIndex =
      windowedIndexSnap?.index ?? pendingRestore?.index ?? null;
    const windowedFpSize =
      windowedIndexSnap?.fingerprint.size ??
      pendingRestore?.fingerprint.size ??
      null;
    const windowedFpMtime =
      windowedIndexSnap?.fingerprint.mtime_ms ??
      pendingRestore?.fingerprint.mtime_ms ??
      null;
    const windowedDigest =
      windowedIndexSnap?.digest ?? pendingRestore?.digest ?? null;
    const windowedTopLine =
      tab.windowed?.topLine ?? pendingRestore?.topLine ?? null;
    // Snapshot content exists only to carry unsaved edits across a restart, and
    // the policy applies to every tab (range tabs included). A clean tab
    // persists empty content — loadTab re-reads it from disk (a range tab from
    // its source slice), so serializing the whole thing is wasted IPC. A dirty
    // tab within the ceiling writes its full buffer; a dirty tab over the
    // ceiling ('skip') is too big to snapshot, so it persists empty too and the
    // quit gate forces the user to save or discard it before exit.
    //
    // A windowed tab is never dirty here, regardless of
    // `windowed.dirty` (the live quit-gate flag, read straight off live state
    // and correctly untouched — see `firstOversizedDirtyIndex`). Its unsaved
    // edits live only in the Rust piece table and cannot ride along in a JSON
    // snapshot; persisting `dirty: true` next to `content: ''` would advertise
    // edits nothing can restore, so a windowed tab always snapshots clean —
    // what cannot be restored must not be advertised as pending.
    const dirty = windowedSnapshotDirty(
      tab.windowed !== undefined,
      this.isDirty(tab),
    );
    // Flush point: a full snapshot materializes the rope to a string for IPC. This
    // path already pays the whole-buffer cost, so the toString is not new overhead.
    const content =
      snapshotContentPolicy(dirty, tab.content.length) === 'full'
        ? tab.content.toString()
        : '';
    return {
      id: tab.id,
      content,
      file_path: tab.path,
      language: tab.language,
      explicit: tab.explicit,
      x: this.bounds.x,
      y: this.bounds.y,
      width: this.bounds.width,
      height: this.bounds.height,
      pin_mode: 'none',
      pin_app: null,
      opacity: 1,
      paper: 'classic',
      kind: 'document',
      dirty,
      window_group: this.group,
      tab_index: tab.tabIndex,
      line_ending: tab.lineEnding,
      had_bom: tab.hadBom,
      encoding: tab.encoding,
      project: this.project,
      // A large-file tab persists its size (empty content, never dirty) so
      // restore reopens it in the view without re-stat. A windowed tab persists
      // its on-disk size the same way (see the fingerprint above), so a
      // restored-but-not-yet-reopened tab looks and behaves like a large tab
      // until `beginWindowedRestore` swaps it over.
      large: windowedSnapshotLarge(
        tab.large?.size ?? null,
        windowedFpSize,
        tab.windowed?.totalBytes ?? null,
      ),
      // A range tab persists its source, byte span, and conflict fingerprint so
      // restore rebuilds the splice write-back baseline (buffer from `content`).
      range_source: tab.range?.sourcePath ?? null,
      range_start: tab.range?.startByte ?? null,
      range_end: tab.range?.endByte ?? null,
      range_fp_size: tab.range?.fingerprint?.size ?? null,
      range_fp_mtime: tab.range?.fingerprint?.mtime_ms ?? null,
      range_start_line: tab.range?.startLine ?? null,
      range_end_line: rangeEndLine(tab),
      range_trailing_break: tab.range?.trailingBreak ?? null,
      // A windowed tab persists what `beginWindowedRestore` needs to rebuild the
      // session with no rescan (see `windowed_reopen`); its presence is what
      // marks the tab as "was unlocked" on restore.
      windowed_index: windowedIndex,
      windowed_fp_size: windowedFpSize,
      windowed_fp_mtime: windowedFpMtime,
      windowed_digest: windowedDigest,
      windowed_top_line: windowedTopLine,
    };
  }

  // Not `async`: `flush(); await this.lastSave` (see `switchTo`/`flushAll`)
  // depends on `this.lastSave` being assigned to the promise this call just
  // started, synchronously, before the caller regains control. `snapshot()`
  // is itself async (it awaits `windowed_index`), so an `async` upsertTab
  // would only assign `this.lastSave` after that first await — by which time
  // `debounce.flush()` (which invokes its callback synchronously) has already
  // returned to its caller, so `await this.lastSave` would resolve whatever
  // the *previous* upsert left behind, not the one just flushed. Building the
  // promise with `.then()` instead keeps the whole chain, including the
  // `snapshot()` call, synchronous up to `this.lastSave`'s assignment.
  //
  // The promise this assigns to `this.lastSave` never rejects: `lastSave`
  // exists only to sequence later operations (a tab switch, a flush, a
  // close) after this write, and every caller of `await this.lastSave` needs
  // to run regardless of whether the write succeeded — a stuck tab switch or
  // a stuck close is strictly worse than a lost snapshot, and a stuck
  // `flushAll` is a lost snapshot anyway (the quit handshake times out and
  // exits without it). Failure is recorded on `snapshotFailed` instead of
  // being silently dropped.
  private upsertTab(tab: DocTab): Promise<void> {
    // Captured before `snapshot()` (async) rather than inside the `.then()`
    // below: `snapshot()`'s duration varies (it awaits `windowed_index`), so
    // two overlapping calls could otherwise resolve in a different order than
    // they were issued in, handing the backend a `seq` that no longer
    // reflects true call order.
    const seq = nextSeq();
    const promise = this.snapshot(tab)
      .then((note) => invoke<void>('upsert_note', { note, seq }))
      .then(() => {
        this.snapshotFailed = false;
        tab.writeFailed = false;
      })
      .catch((error: unknown) => {
        this.snapshotFailed = true;
        tab.writeFailed = true;
        console.error('upsert_note failed', error);
      });
    this.lastSave = promise;
    return promise;
  }

  /** Read a file from disk and build a tab, honouring a restored snapshot when
   *  it carries unsaved edits (snapshot wins over disk, matching stickies). */
  private async loadTab(
    path: string,
    snap: NoteSnapshot | null,
  ): Promise<DocTab> {
    // Known up front so every branch below (windowed/large restore, or an
    // ordinary decode) can stamp it on the tab it builds. A range restore's
    // `path` argument is always '' (its real file lives in `range_source`); the
    // range branch below computes its own answer against that instead of this
    // one. A thrown check must never block the open, so it degrades to false.
    const readOnlyFile =
      path === ''
        ? false
        : await invoke<boolean>('path_writable', { path })
            .then((writable) => !writable)
            .catch(() => false);
    // A restored range tab rebuilds from the snapshot. A clean range tab persists
    // empty content, so its buffer and saved baseline both come from the current
    // on-disk slice; a dirty one restores its stored (edited) buffer against that
    // slice as the saved baseline, so dirty is derived exactly as an ordinary tab
    // is (buffer vs disk). If the source is gone the tab still opens (empty for a
    // clean tab, its stored edits for a dirty one). A changed source shows as
    // dirty and trips the conflict flow on save; the stored fingerprint is the
    // conflict baseline either way.
    if (snap !== null && snap.range_source !== null) {
      const source = snap.range_source;
      if (__LITE__) {
        throw new KeptRestore();
      }
      // Shadows the outer `readOnlyFile`: a range tab's write-back target is
      // `source`, not the tab's own (always-empty) `path`.
      const readOnlyFile = await invoke<boolean>('path_writable', {
        path: source,
      })
        .then((writable) => !writable)
        .catch(() => false);
      const startByte = snap.range_start ?? 0;
      const endByte = snap.range_end ?? 0;
      let diskSlice: string | null = null;
      let rangeReadError: string | null = null;
      try {
        const r = await invoke<RangeRead>('read_range', {
          path: source,
          start: startByte,
          end: endByte,
        });
        diskSlice = r.text;
      } catch (e) {
        diskSlice = null;
        rangeReadError = String(e);
      }
      // The edition turned lite while this restore ran and the core refused the
      // read: that says nothing about the file, and the record needs full.
      if (
        rangeReadError !== null &&
        (isLite() || isLiteRefusal(rangeReadError))
      ) {
        throw new KeptRestore();
      }
      if (restoreOutcome(snap.dirty, rangeReadError) === 'unreadable') {
        throw new UnreadableRestore(source);
      }
      const normalizedSlice =
        diskSlice !== null ? normalizeToLf(diskSlice) : null;
      const savedContent = textFromString(normalizedSlice ?? snap.content);
      const savedLineEnding =
        diskSlice !== null ? detectLineEnding(diskSlice) : snap.line_ending;
      const fingerprint =
        snap.range_fp_size !== null && snap.range_fp_mtime !== null
          ? { size: snap.range_fp_size, mtime_ms: snap.range_fp_mtime }
          : null;
      return {
        id: snap.id,
        path: '',
        readOnlyFile,
        content: textFromString(
          restoredRangeContent(snap.dirty, snap.content, normalizedSlice),
        ),
        savedContent,
        language: restoredLanguage(snap.language, snap.explicit, null),
        explicit: snap.explicit,
        lineEnding: snap.line_ending,
        savedLineEnding,
        hadBom: false,
        encoding: settingsState.defaultEncoding,
        lossy: false,
        tabIndex: snap.tab_index,
        // An older snapshot has no start line (only the now-removed
        // formatted `range_label`); `startLine: null` here is what makes
        // `rangeDisplayName` fall back to the bare file name for it, matching
        // a fresh tab's own degraded display rather than showing a stale or
        // nonsensical line span.
        range: {
          sourcePath: source,
          startByte,
          endByte,
          fingerprint,
          startLine: snap.range_start_line ?? null,
          trailingBreak:
            snap.range_trailing_break ??
            (diskSlice !== null ? sliceEndsWithBreak(diskSlice) : false),
        },
      };
    }
    // A restored windowed-editing tab knows it was unlocked (the persisted
    // checkpoint index is the marker — see `NoteSnapshot.windowed_index`) but
    // has no live Rust session yet: it carries the data `beginWindowedRestore`
    // needs to reopen one lazily once this tab becomes active. Until then it
    // has neither `windowed` nor `large` set, so DocumentApp renders nothing
    // for it rather than flashing the read-only viewer for a fast-path restore
    // (see the class doc and `beginWindowedRestore`).
    if (snap !== null && snap.windowed_index !== null && snap.large !== null) {
      return {
        id: snap.id,
        path,
        readOnlyFile,
        content: Text.empty,
        savedContent: Text.empty,
        language: null,
        explicit: false,
        lineEnding: settingsState.defaultLineEnding,
        savedLineEnding: settingsState.defaultLineEnding,
        hadBom: false,
        encoding: settingsState.defaultEncoding,
        lossy: false,
        tabIndex: snap.tab_index,
        windowedRestore: {
          index: snap.windowed_index,
          fingerprint: {
            size: snap.windowed_fp_size ?? snap.large,
            mtime_ms: snap.windowed_fp_mtime ?? 0,
          },
          digest: snap.windowed_digest ?? '0',
          topLine: snap.windowed_top_line ?? 0,
          size: snap.large,
        },
      };
    }
    // A restored large-file tab reopens straight in the read-only view: the user
    // already consented, so no re-stat and no confirm. Its size comes from the
    // snapshot; if the file has since vanished the tab still opens (matching an
    // ordinary tab, which survives a missing file) and the view surfaces reads.
    if (snap !== null && snap.large !== null) {
      return {
        id: snap.id,
        path,
        readOnlyFile,
        content: Text.empty,
        savedContent: Text.empty,
        language: null,
        explicit: false,
        lineEnding: settingsState.defaultLineEnding,
        savedLineEnding: settingsState.defaultLineEnding,
        hadBom: false,
        encoding: settingsState.defaultEncoding,
        lossy: false,
        tabIndex: snap.tab_index,
        large: { size: snap.large },
      };
    }
    // Size gate: a snapshot that lost its `large`/`windowed_index` markers (for
    // any reason) must still degrade to the read-only viewer rather than
    // decoding a huge file whole into the WebView — the same ceiling `openTab`
    // enforces before a fresh open ever reaches a full decode.
    // Lite has no viewer to degrade to, so it neither stats nor gates.
    if (path !== '' && !__LITE__ && !isLite()) {
      let size: number | null = null;
      try {
        size = (await invoke<FileStat>('stat_file', { path })).size;
      } catch {
        size = null;
      }
      if (size !== null && opensInLargeViewer(size, false)) {
        return {
          id: snap?.id ?? crypto.randomUUID(),
          path,
          readOnlyFile,
          content: Text.empty,
          savedContent: Text.empty,
          language: null,
          explicit: false,
          lineEnding: settingsState.defaultLineEnding,
          savedLineEnding: settingsState.defaultLineEnding,
          hadBom: false,
          encoding: settingsState.defaultEncoding,
          lossy: false,
          tabIndex: snap?.tab_index ?? this.nextIndex++,
          large: { size },
        };
      }
    }
    // A restored tab reads with its stored encoding; a fresh open auto-detects.
    // Decode strips any BOM but preserves the file's line endings.
    let decoded: Decoded | null = null;
    let readError: string | null = null;
    try {
      decoded = snap?.encoding
        ? await invoke<Decoded>('read_file_as', {
            path,
            encoding: snap.encoding,
          })
        : await invoke<Decoded>('read_file_auto', { path });
    } catch (e) {
      decoded = null;
      readError = String(e);
    }
    if (
      snap !== null &&
      restoreOutcome(snap.dirty, readError) === 'unreadable'
    ) {
      throw new UnreadableRestore(path);
    }
    const fileExists = decoded !== null;
    // A fresh open names a file that is supposed to be there; a restore does
    // not, and must keep tolerating a file that has since been deleted so the
    // snapshot's unsaved content survives. Treating an unreadable fresh open as
    // a new empty buffer is what let a failed open present as a blank document
    // and then, on save, write to a path the user never chose.
    if (!fileExists && snap === null && path !== '') {
      throw new Error(`cannot read ${path}`);
    }
    const diskRaw = decoded?.content ?? '';
    const diskContent = normalizeToLf(diskRaw);
    const diskEnding = detectLineEnding(diskRaw);
    const id = snap?.id ?? crypto.randomUUID();
    const tabIndex = snap?.tab_index ?? this.nextIndex++;
    const detected = detectByFilename(path);
    // Existing files keep their detected/stored encoding; a file that never
    // existed on disk (no decode, no snapshot) falls back to the user default.
    const encoding =
      decoded?.encoding ?? snap?.encoding ?? settingsState.defaultEncoding;
    const lossy = decoded?.lossy ?? false;
    const hadBom = fileExists ? decoded!.had_bom : (snap?.had_bom ?? false);
    if (snap !== null && snap.dirty) {
      return {
        id,
        path,
        readOnlyFile,
        content: textFromString(snap.content),
        savedContent: textFromString(fileExists ? diskContent : ''),
        language: restoredLanguage(snap.language, snap.explicit, detected),
        explicit: snap.explicit,
        lineEnding: snap.line_ending,
        savedLineEnding: fileExists ? diskEnding : snap.line_ending,
        hadBom,
        encoding,
        lossy,
        tabIndex,
      };
    }
    // A clean tab shares one rope between buffer and saved baseline, so its dirty
    // check stays O(1) (reference-equal) until the first edit forks the buffer.
    const content = textFromString(
      fileExists ? diskContent : (snap?.content ?? ''),
    );
    const lineEnding = fileExists
      ? diskEnding
      : (snap?.line_ending ?? settingsState.defaultLineEnding);
    return {
      id,
      path,
      readOnlyFile,
      content,
      savedContent: content,
      language: restoredLanguage(
        snap?.language ?? null,
        snap?.explicit ?? false,
        detected,
      ),
      explicit: snap?.explicit ?? false,
      lineEnding,
      savedLineEnding: lineEnding,
      hadBom,
      encoding,
      lossy,
      tabIndex,
    };
  }

  /** Load every tab for this window's group, or open a single fresh tab when a
   *  brand-new window carries only an initial path. */
  async init(
    group: string,
    initialPath: string | null,
    project: string | null,
    initialTab: number | null = null,
  ): Promise<void> {
    this.group = group;
    // A fresh window takes its project from the URL; a restored window adopts it
    // from the group's stored notes (set below), ignoring the URL value.
    this.project = project;
    // The edition decides how a snapshot may be restored, so it is settled
    // before the first tab is loaded.
    await editionState.ready();
    const all = await invoke<NoteSnapshot[]>('list_notes');
    const entries = all
      .filter(
        (n) => n.kind === 'document' && (n.window_group ?? n.id) === group,
      )
      .sort((a, b) => a.tab_index - b.tab_index);
    if (entries.length > 0) {
      // Restore: adopt the project the group's tabs were saved with.
      this.project = entries[0]!.project;
      // A lite session does not open a tab that needs a removed feature. It has
      // no tab object for it, so nothing below can write, rewrite or delete its
      // record (every snapshot write and delete goes through a tab in `tabs`);
      // it is counted and noticed instead.
      const { restorable, kept } = partitionRestorable(entries, isLite());
      this.keptTabs = kept.length;
      const dropped = new Set<number>(kept.map((n) => n.tab_index));
      for (const entry of restorable) {
        try {
          this.tabs.push(await this.loadTab(entry.file_path ?? '', entry));
        } catch (e) {
          if (e instanceof KeptRestore) {
            this.keptTabs += 1;
            dropped.add(entry.tab_index);
            continue;
          }
          if (!(e instanceof UnreadableRestore)) {
            throw e;
          }
          // Deleted so the note is not retried (and re-reported) every launch.
          // A failed delete only means the notice repeats next launch; it must
          // not abort restoring the rest of the window.
          await invoke('delete_note', { id: entry.id }).catch(() => {});
          this.restoreUnreadable.push(e.path);
          dropped.add(entry.tab_index);
        }
      }
      const lowest = windowBoundsRecord(entries, isLite());
      this.bounds = {
        x: lowest.x,
        y: lowest.y,
        width: lowest.width,
        height: lowest.height,
      };
      this.nextIndex = Math.max(...entries.map((e) => e.tab_index)) + 1;
      // Writing `activeIndex` (even to its already-current value of 0) is what
      // kicks off the lazy reopen if the initial active tab is itself a
      // restored windowed tab — see the `activeIndex` setter. `initialTab` is a
      // stored `tab_index`, not an array position: closes and reorders make the
      // two diverge, so it is resolved against the restored entries.
      this.activeIndex = activePositionAfterRestore(
        entries.map((e) => e.tab_index),
        dropped,
        initialTab,
      );
    } else if (initialPath !== null) {
      // A fresh window opened for one file routes through the same open gate, so
      // an over-threshold file prompts before loading (and may leave the window
      // empty if cancelled — DocumentApp collapses it then).
      this.nextIndex = 0;
      await this.openTab(initialPath);
      if (this.tabs.length > 0) {
        // The window now shows a document, so it can no longer be a launch
        // window that collapses.
        void invoke('launch_window_loaded', { label: `doc-${group}` });
      }
      // `switchTo(0)` returns early when the index is already active, so the
      // setter — and the restore it kicks — never fires for a fresh window's
      // first tab, which an adopted orphan can be. Kick it directly: writing
      // `activeIndex` here would instead reset a tab that another open switched
      // to while this init was awaiting, leaving the window on the wrong tab.
      this.ensureWindowedRestore(this.activeTab);
    }
    this.ready = true;
    // The edition turned full while the tabs above were loading.
    if (this.keptTabs > 0 && !isLite()) {
      await this.restoreKeptTabs();
    }
  }

  /** The edition turned full: open the tabs of this window that lite kept, from
   *  their stored records exactly as a startup restore would, so a range tab
   *  comes back with its unsaved edits. Tabs keep their stored order. */
  restoreKeptTabs(): Promise<void> {
    // One at a time: two flips in quick succession would otherwise both read
    // the store before either had opened a tab, and open every one twice.
    const run = this.keptRestore.then(() => this.restoreKeptTabsNow());
    this.keptRestore = run.catch(() => {});
    return run;
  }

  private keptRestore: Promise<void> = Promise.resolve();

  private async restoreKeptTabsNow(): Promise<void> {
    if (!this.ready || isLite()) {
      return;
    }
    let all: NoteSnapshot[];
    try {
      all = await invoke<NoteSnapshot[]>('list_notes');
    } catch {
      return;
    }
    const kept = keptTabsToLoad(
      all,
      this.group,
      new Set(this.tabs.map((tab) => tab.id)),
    );
    const activeId = this.activeTab?.id ?? null;
    let stillKept = 0;
    for (const entry of kept) {
      try {
        this.tabs.push(await this.loadTab(entry.file_path ?? '', entry));
      } catch (e) {
        if (e instanceof KeptRestore) {
          // Lite again before this one could be read: it stays kept.
          stillKept += 1;
          continue;
        }
        if (!(e instanceof UnreadableRestore)) {
          throw e;
        }
        await invoke('delete_note', { id: entry.id }).catch(() => {});
        this.restoreUnreadable.push(e.path);
      }
    }
    this.keptTabs = stillKept;
    if (kept.length === 0) {
      return;
    }
    this.tabs.sort((a, b) => a.tabIndex - b.tabIndex);
    const at = this.tabs.findIndex((tab) => tab.id === activeId);
    // Written even when unchanged: the setter is what starts the lazy reopen of
    // a restored windowed tab that is now the active one.
    this.activeIndex = at === -1 ? 0 : at;
  }
  /** Set by the window: ends an IME composition in the active editor and
   *  resolves once its text is in the tab. A switch waits for it. */
  endComposition: (() => Promise<void>) | null = null;

  /** Switch tabs, flushing the outgoing tab's pending upsert first. */
  async switchTo(index: number): Promise<void> {
    if (index === this.activeIndex || index < 0 || index >= this.tabs.length) {
      return;
    }
    const from = this.activeIndex;
    await this.endComposition?.();
    // Another switch or a close may have moved on while waiting.
    if (this.activeIndex !== from || index >= this.tabs.length) {
      return;
    }
    this.persistActive.flush();
    await this.lastSave;
    this.activeIndex = index;
  }

  /** Kick off `beginWindowedRestore` for `tab` if it is a restored-but-not-yet-
   *  reopened windowed tab and no restore is already in flight for it (switching
   *  away and back must not scan or re-open anything). No-op otherwise. Fire-
   *  and-forget: the tab's own fields (`windowedRestore`/`windowed`/`large`)
   *  drive its render state as the restore progresses. */
  private ensureWindowedRestore(tab: DocTab | null): void {
    if (
      tab?.windowedRestore === undefined ||
      this.restoringWindowedIds.has(tab.id)
    ) {
      return;
    }
    void this.beginWindowedRestore(tab);
  }

  /** Lazily reopen a restored windowed tab's Rust session from its persisted
   *  checkpoint index. Two outcomes, both ending with `windowedRestore` cleared:
   *
   *  - Fast path (index/fingerprint/digest all still match): `windowed_reopen`
   *    resolves in microseconds, almost always before `WINDOWED_RESTORE_GRACE_MS`
   *    elapses, so the tab swaps `windowed` in having never rendered the
   *    read-only viewer for a single frame.
   *  - Slow path (the file changed on disk, so Rust falls back to a full
   *    rescan): the grace-period timer fires first and sets `large`, so
   *    DocumentApp falls back to the read-only viewer instead of blocking the
   *    tab switch for however long the rescan takes. `LargeFileView`'s own
   *    `onMount` then starts its own line-index build over the same file
   *    (concurrently with the still-running Rust-side rescan) and that build
   *    is what drives the `large-index-progress` → `status.indexing`
   *    indicator — `windowed_reopen` itself reports no progress; there is no
   *    listener that could match it (`LargeFileView`'s listener keys on the
   *    `start_line_index` session id, never the reopened file's path).
   *    Reopen still swaps `windowed` in on completion.
   *  - Refusal (non-UTF-8 / too-large / any other error): falls back to the
   *    read-only viewer with the reason surfaced via `unlockRefused`, the same
   *    way `unlockLargeTab` surfaces one — a failed restore never leaves the
   *    tab broken or blank. */
  private async beginWindowedRestore(tab: DocTab): Promise<void> {
    const wr = tab.windowedRestore;
    if (__LITE__ || wr === undefined) {
      return;
    }
    this.restoringWindowedIds.add(tab.id);
    const graceTimer = window.setTimeout(() => {
      if (tab.windowedRestore !== undefined && tab.windowed === undefined) {
        tab.large = { size: wr.size };
      }
    }, WINDOWED_RESTORE_GRACE_MS);
    let reopened: WindowedReopened;
    try {
      reopened = await invoke<WindowedReopened>('windowed_reopen', {
        path: tab.path,
        index: wr.index,
        fingerprint: wr.fingerprint,
        digest: wr.digest,
      });
    } catch (e) {
      window.clearTimeout(graceTimer);
      delete tab.windowedRestore;
      tab.large = {
        size: wr.size,
        unlockRefused: windowedRefusalMessage(String(e)),
      };
      this.restoringWindowedIds.delete(tab.id);
      return;
    }
    window.clearTimeout(graceTimer);
    this.restoringWindowedIds.delete(tab.id);
    this.lastWindowedRestoreRescanned = reopened.rescanned;
    // The tab was closed while this restore was in flight: release the session
    // just opened rather than leaking it, and don't resurrect the deleted note
    // by upserting a tab no longer in this window.
    if (!this.tabs.includes(tab)) {
      if (!__LITE__) {
        void invoke('windowed_close', { sessionId: reopened.session_id });
      }
      return;
    }
    delete tab.large;
    delete tab.windowedRestore;
    this.releaseTabView(tab.id);
    tab.windowed = {
      sessionId: reopened.session_id,
      totalBytes: reopened.total_bytes,
      totalLines: reopened.total_lines,
      fingerprint: reopened.fingerprint,
      dirty: false,
      topLine: wr.topLine,
      initialLine: wr.topLine,
    };
    await this.upsertTab(tab);
  }

  /** Live-mirror the WindowedEditor's current top-of-viewport line onto the
   *  active windowed tab, so a later snapshot persists it as `windowed_top_line`
   *  (restore feeds it back through `initialLine`). No-op if the active tab is
   *  not (still) a windowed tab, e.g. a stray late event after a tab switch. */
  windowedTopLineChanged(topLine: number): void {
    const tab = this.activeTab;
    if (tab?.windowed === undefined) {
      return;
    }
    tab.windowed.topLine = topLine;
    this.persistActive();
  }

  cycle(delta: number): void {
    const count = this.tabs.length;
    if (count < 2) {
      return;
    }
    void this.switchTo((this.activeIndex + delta + count) % count);
  }

  /** Open a fresh untitled tab (no path, empty buffer) and switch to it. */
  async newTab(): Promise<void> {
    const lineEnding = settingsState.defaultLineEnding;
    const tab: DocTab = {
      id: crypto.randomUUID(),
      path: '',
      readOnlyFile: false,
      content: Text.empty,
      savedContent: Text.empty,
      language: null,
      explicit: false,
      lineEnding,
      savedLineEnding: lineEnding,
      hadBom: false,
      encoding: settingsState.defaultEncoding,
      lossy: false,
      tabIndex: this.nextIndex++,
    };
    this.tabs.push(tab);
    await this.switchTo(this.tabs.length - 1);
    await this.upsertTab(tab);
  }

  /** Open `path` as a new tab, or activate its existing tab (dedupe by path).
   *  Untitled tabs carry an empty path and must never match this dedupe.
   *  Over-threshold files stat once here and raise the open-mode confirm instead
   *  of loading; a live tab never changes mode afterwards (size changes ignored).
   *  The `large_open_mode` setting ('ask' | 'view' | 'edit') decides the outcome
   *  below: 'ask' raises the confirm, 'view'/'edit' skip it and open straight in
   *  that mode. The confirm itself never auto-picks edit mode — that would load a
   *  GB file whole; view is always the safe default. */
  async openTab(path: string): Promise<void> {
    this.openFailed = null;
    await this.route(path);
    // Recorded after the open rather than before it: a path that cannot be read
    // would otherwise enter the recent-files menu, where picking it fails again.
    // This is the single chokepoint every open funnels through — the Open
    // dialog, the workspace tree, a fresh window's init, and Open Recent itself.
    // Untitled tabs (empty path) are skipped.
    if (path !== '' && this.openFailed === null) {
      void invoke('add_recent_file', { path });
    }
  }

  private async route(path: string): Promise<void> {
    // Both the large-file gate below and the long-line gate in openNormal branch
    // on a setting, and a fresh window opens its file in parallel with loading
    // them. Waiting here — the one chokepoint every open funnels through — is
    // what keeps those decisions from reading constructor defaults.
    await settingsState.ready;
    // Reconcile against a stored tab of the same file living in another window,
    // so a snapshot always wins over disk regardless of which window group holds
    // it. Every fresh-open entry point (menu Open, workspace tree, a fresh
    // window's own init) funnels through here, so the routing is global.
    const route: OpenRoute =
      path === '' ? { kind: 'fresh' } : await this.routeFor(path);
    const existing =
      path === '' ? -1 : this.tabs.findIndex((t) => t.path === path);
    if (existing !== -1) {
      await this.switchTo(existing);
      // A dirty orphan of a file this window already shows clean: pull its
      // unsaved edits in (snapshot wins over disk) and retire the orphan record.
      // A dirty local tab is left untouched — two-sided edits are not merged.
      if (route.kind === 'adopt' && route.note.dirty) {
        await this.adoptIntoExisting(existing, route.note);
      }
      return;
    }
    // Already open in another live window: focus it instead of duplicating.
    if (route.kind === 'switch') {
      await invoke('focus_doc_tab', {
        group: route.group,
        tabIndex: route.tabIndex,
      });
      return;
    }
    // Orphaned in a dead window group: re-home it here, restoring its edits.
    if (route.kind === 'adopt') {
      await this.adoptOrphan(path, route.note);
      return;
    }
    let size = 0;
    // Lite has no large-file viewer, so it does not even ask for the size.
    if (!__LITE__ && !isLite()) {
      try {
        size = (await invoke<FileStat>('stat_file', { path })).size;
      } catch {
        size = 0;
      }
    }
    if (opensInLargeViewer(size, isLite())) {
      this.pendingLargeOpen = { path, size };
      // 'ask' raises the confirm; 'view'/'edit' skip it and open straight in the
      // chosen mode (edit falls back to the read-only view for a non-UTF-8 or
      // oversized file, handled inside confirmLargeOpen).
      const mode = settingsState.largeOpenMode;
      if (mode !== 'ask') {
        this.confirmLargeOpen(mode === 'edit');
      }
      return;
    }
    await this.openNormal(path);
  }

  /** Open `path` as an ordinary editable tab (full decode), bypassing the
   *  large-file gate. Used by the normal path and by the edit-mode confirm. */
  private async openNormal(path: string): Promise<void> {
    let tab: DocTab;
    try {
      tab = await this.loadTab(path, null);
    } catch {
      this.openFailed = path;
      return;
    }
    // A freshly opened file whose longest line is over the threshold can
    // stall synchronous syntax parsing on every keystroke. When the ask setting
    // is on, stage the open and let the user pick how to open it (as-is,
    // formatted, or soft-wrapped) instead of committing the tab straight away.
    if (settingsState.askLongLineOpen && docHasLongLine(tab.content)) {
      // Compute the beautified form once here (a full round-trip): "format" is
      // offered only when the whole pretty-print succeeds, so the button never
      // appears for content that parses but is too deeply nested to stringify.
      const formatted = beautifyJson(tab.content.toString());
      this.pendingLongLineTab = tab;
      this.pendingLongLineFormatted = formatted;
      this.pendingLongLineOpen = { path, formatAvailable: formatted !== null };
      return;
    }
    this.tabs.push(tab);
    await this.switchTo(this.tabs.length - 1);
    await this.upsertTab(tab);
  }

  /** Open-dialog choice. 'asis' commits the buffer unchanged (it opens in the
   *  long-line gate mode); 'format' swaps in the pre-computed beautified JSON;
   *  'softwrap' inserts a break every SOFT_WRAP_LIMIT code units. The
   *  transforming choices mutate the buffer while its saved baseline stays the
   *  on-disk content, so the tab opens dirty (unsaved) and is never written to
   *  disk automatically. */
  confirmLongLineOpen(mode: 'asis' | 'format' | 'softwrap'): void {
    const tab = this.pendingLongLineTab;
    if (tab === null) {
      return;
    }
    const formatted = this.pendingLongLineFormatted;
    this.pendingLongLineOpen = null;
    this.pendingLongLineTab = null;
    this.pendingLongLineFormatted = null;
    if (mode === 'format' && formatted !== null) {
      tab.content = textFromString(formatted);
    } else if (mode === 'softwrap') {
      tab.content = textFromString(softWrapLongLines(tab.content.toString()));
    }
    this.tabs.push(tab);
    void (async (): Promise<void> => {
      await this.switchTo(this.tabs.length - 1);
      await this.upsertTab(tab);
    })();
  }

  /** Open-dialog cancel: drop the staged open as if it never happened. */
  cancelLongLineOpen(): void {
    this.pendingLongLineOpen = null;
    this.pendingLongLineTab = null;
    this.pendingLongLineFormatted = null;
  }

  /** Consult the note store for a stored tab of `path` in another window group.
   *  Returns how the open should route: focus a still-live window, adopt an
   *  orphaned snapshot, or open fresh. Any command failure degrades to 'fresh'. */
  private async routeFor(path: string): Promise<OpenRoute> {
    let all: NoteSnapshot[];
    try {
      all = await invoke<NoteSnapshot[]>('list_notes');
    } catch {
      return { kind: 'fresh' };
    }
    const groups = [
      ...new Set(
        orphanCandidates(all, path, this.group, isLite()).map(documentGroup),
      ),
    ];
    // Common case: no other group holds this path, so skip the liveness probe.
    if (groups.length === 0) {
      return { kind: 'fresh' };
    }
    let live: string[];
    try {
      live = await invoke<string[]>('live_doc_groups', { groups });
    } catch {
      live = [];
    }
    return routeOpen(all, path, this.group, new Set(live), isLite());
  }

  /** Re-home an orphaned stored tab (its window group is gone) into this window:
   *  rebuild it via loadTab so a dirty snapshot restores its unsaved edits over
   *  disk, keep its note id, but give it a fresh tab index in this window. The
   *  upsert re-tags the note with this window's group and project, so the
   *  orphan's old group keeps only its remaining tabs (restored as usual next
   *  launch). */
  private async adoptOrphan(path: string, note: NoteSnapshot): Promise<void> {
    let tab: DocTab;
    try {
      tab = await this.loadTab(path, note);
    } catch (e) {
      if (e instanceof KeptRestore) {
        this.keptTabs += 1;
        return;
      }
      if (!(e instanceof UnreadableRestore)) {
        throw e;
      }
      // Reported like any other failed open; the stale record would only fail
      // the same way next time.
      await invoke('delete_note', { id: note.id }).catch(() => {});
      this.openFailed = path;
      return;
    }
    tab.tabIndex = this.nextIndex++;
    this.tabs.push(tab);
    await this.switchTo(this.tabs.length - 1);
    await this.upsertTab(tab);
  }

  /** Bring a dirty orphan's unsaved edits into an existing clean tab for the same
   *  file (snapshot wins over disk), then delete the orphan record so it stops
   *  haunting the store. No-op when the local tab is itself dirty — a genuine
   *  two-sided edit is left for the user and the orphan is preserved. */
  private async adoptIntoExisting(
    index: number,
    note: NoteSnapshot,
  ): Promise<void> {
    const tab = this.tabs[index];
    if (tab === undefined || this.isDirty(tab)) {
      return;
    }
    // savedContent stays the on-disk baseline, so forking content marks the tab
    // dirty exactly as an ordinary edit would.
    tab.content = textFromString(note.content);
    tab.lineEnding = note.line_ending;
    await invoke('delete_note', { id: note.id });
    this.reloadTargetId = tab.id;
    this.reloadSeq += 1;
    await this.upsertTab(tab);
  }

  /** Confirm choice: open the pending file in the read-only large-file view.
   *  With `edit` true (the confirm's Edit button, or 'edit' open mode) an editable
   *  file unlocks straight into in-place editing right after the tab opens. */
  confirmLargeOpen(edit = false): void {
    const pending = this.pendingLargeOpen;
    if (pending === null) {
      return;
    }
    this.pendingLargeOpen = null;
    // The edition turned lite while the question was up: no viewer to open in.
    if (isLite()) {
      void this.openNormal(pending.path);
      return;
    }
    const tab: DocTab = {
      id: crypto.randomUUID(),
      path: pending.path,
      // Filled in below, right after the tab is pushed: the large-file lock
      // wording wins over this regardless, but the badge/pen still want the
      // right answer once the file is unlocked.
      readOnlyFile: false,
      content: Text.empty,
      savedContent: Text.empty,
      language: null,
      explicit: false,
      lineEnding: settingsState.defaultLineEnding,
      savedLineEnding: settingsState.defaultLineEnding,
      hadBom: false,
      encoding: settingsState.defaultEncoding,
      lossy: false,
      tabIndex: this.nextIndex++,
      large: { size: pending.size },
    };
    this.tabs.push(tab);
    const index = this.tabs.length - 1;
    void (async (): Promise<void> => {
      await this.switchTo(index);
      try {
        tab.readOnlyFile = !(await invoke<boolean>('path_writable', {
          path: tab.path,
        }));
      } catch {
        tab.readOnlyFile = false;
      }
      await this.upsertTab(tab);
      // Edit choice: unlock straight into in-place editing right after the tab
      // opens, so an editable large file lands the user directly in edit mode. A
      // non-UTF-8 or oversized file silently stays in the read-only view (the tab
      // lock explains why). ponytail: reuses the in-place unlock path, no second
      // open route.
      if (edit && tab.large !== undefined && tab.large.size < LARGE_EDIT_MAX) {
        await this.unlockLargeTab(0);
      }
    })();
  }

  /** Unlock the active read-only large-file tab into an editable one, in place:
   *  attach a Rust windowed session and swap the tab's `large` field for a
   *  `windowed` field (same tab id, so the view swaps from LargeFileView to
   *  WindowedEditor without a new tab). `topLine` is the 0-based line the user was
   *  viewing, so editing continues from there. Returns null on success, or a short
   *  reason when the file cannot be edited (non-UTF-8); the tab stays read-only. */
  async unlockLargeTab(topLine: number): Promise<string | null> {
    const tab = this.activeTab;
    if (tab?.large === undefined) {
      return null;
    }
    // Lite has no editing session to start. Nothing is asked of the core, and
    // nothing is recorded on the tab: its lock must be as it was when the
    // edition is full again.
    if (__LITE__ || isLite()) {
      return null;
    }
    let open: WindowedOpen;
    try {
      open = await invoke<WindowedOpen>('windowed_open', { path: tab.path });
    } catch (e) {
      // Record the refusal on the tab so its lock stays disabled with the reason
      // (the tab may not be active, so the state must live on the tab, not the view).
      // Not one the edition caused (it turned lite while the open was in
      // flight): that is not a property of the file and would outlive the edition.
      const reason = windowedRefusalMessage(String(e));
      if (tab.large !== undefined && !isLite() && !isLiteRefusal(e)) {
        tab.large.unlockRefused = reason;
      }
      return reason;
    }
    delete tab.large;
    this.releaseTabView(tab.id);
    const seedLine = Math.max(0, Math.round(topLine));
    tab.windowed = {
      sessionId: open.session_id,
      totalBytes: open.total_bytes,
      totalLines: open.total_lines,
      fingerprint: open.fingerprint,
      dirty: false,
      topLine: seedLine,
      initialLine: seedLine,
    };
    await this.upsertTab(tab);
    return null;
  }

  /** Confirm choice: cancel the pending open (as if it never happened). */
  cancelLargeOpen(): void {
    this.pendingLargeOpen = null;
  }

  updateActiveContent(content: Text): void {
    const tab = this.activeTab;
    if (tab === null) {
      return;
    }
    // Zero-copy: store the editor's own rope reference, not a string snapshot.
    tab.content = content;
    this.persistActive();
  }
  /** Store the editor's document for the tab with `id`, whichever tab is
   *  active: a hidden editor must never write into the active tab. */
  updateContentById(id: string, content: Text): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (tab === undefined) {
      return;
    }
    tab.content = content;
    if (tab === this.activeTab) {
      this.persistActive();
    } else {
      void this.upsertTab(tab);
    }
  }

  setActiveLanguage(name: string | null): void {
    const tab = this.activeTab;
    if (tab === null) {
      return;
    }
    tab.language = name;
    tab.explicit = true;
    this.persistActive();
  }

  /** Toggle the active tab's line ending; the buffer stays LF, save writes the
   *  chosen ending. Dirty is tracked against savedLineEnding, so this marks it. */
  setLineEnding(ending: LineEnding): void {
    const tab = this.activeTab;
    // A large tab's ending is the file's own (read by detection) and saving
    // never rewrites it, so there is nothing to choose.
    if (tab === null || isLargeKind(tab) || tab.lineEnding === ending) {
      return;
    }
    tab.lineEnding = ending;
    this.persistActive();
  }

  toggleLineEnding(): void {
    const tab = this.activeTab;
    if (tab === null) {
      return;
    }
    this.setLineEnding(tab.lineEnding === 'LF' ? 'CRLF' : 'LF');
  }

  /** Save the active tab. An untitled tab (empty path) first asks for a target
   *  via the native save dialog; `pathOverride` skips it (automation/E2E).
   *  Returns false when the dialog was cancelled (no side effects). */
  async saveActive(pathOverride?: string): Promise<boolean> {
    const tab = this.activeTab;
    if (tab === null) {
      return false;
    }
    // A windowed tab saves its Rust-side buffer through windowed_save; only a
    // clean write counts as saved (a conflict raises the modal).
    if (tab.windowed !== undefined) {
      return (await this.saveWindowed(tab, false)) === 'ok';
    }
    // A range tab never touches the save dialog: Cmd+S splices its buffer back
    // into the source over the recorded byte span. Only a clean write counts as
    // saved (a conflict raises the modal; any other failure raises the
    // save-failure dialog -- `splice` reports rather than throwing).
    if (tab.range !== undefined) {
      return (await this.splice(tab, tab.range.fingerprint)) === 'ok';
    }
    if (tab.path === '') {
      const chosen =
        pathOverride ??
        (await save(saveDialogOptions(tab.language, 'Untitled')));
      if (chosen === null) {
        return false;
      }
      tab.path = chosen;
      // Adopt the language implied by the new name unless the user pinned one.
      if (!tab.explicit) {
        tab.language = detectByFilename(chosen);
      }
    }
    // Apply the line ending on the LF buffer, then let Rust encode (BOM handled
    // there: UTF-8 honours hadBom, UTF-16 always writes one, legacy ignores it).
    // Flush point: materialize the rope to a string for the write.
    const out = applyLineEnding(tab.content.toString(), tab.lineEnding);
    try {
      await invoke('write_file_encoded', {
        path: tab.path,
        content: out,
        encoding: tab.encoding,
        withBom: tab.hadBom,
      });
    } catch (e) {
      // Left dirty (the assignments below never run) and reported, rather than
      // silently doing nothing. A file can turn read-only while open, so the
      // tab's own flag catches up here too, so the pen says so.
      if (String(e) === READ_ONLY_DESTINATION) {
        tab.readOnlyFile = true;
      }
      this.saveFailed = { path: tab.path, error: String(e) };
      return false;
    }
    tab.savedContent = tab.content;
    tab.savedLineEnding = tab.lineEnding;
    await this.upsertTab(tab);
    return true;
  }

  /** File > Save As: always prompt for a new path and write the active tab's
   *  buffer there, turning the tab into an ordinary saved document at that path.
   *  A range tab sheds its range identity (like the range save-as conflict path);
   *  a windowed tab is written by its Rust session and retargeted to the new path.
   *  `pathOverride` skips the dialog (automation/E2E). Returns false on cancel. */
  async saveAs(pathOverride?: string): Promise<boolean> {
    const tab = this.activeTab;
    if (tab === null) {
      return false;
    }
    const chosen =
      pathOverride ??
      (await save(saveDialogOptions(tab.language, suggestedName(tab.path))));
    if (chosen === null) {
      return false;
    }
    // A windowed tab's buffer lives in the Rust core, not this rope: Rust
    // writes the chosen path and retargets its session.
    if (tab.windowed !== undefined) {
      return this.windowedSaveTo(tab, chosen);
    }
    // Flush point: materialize the rope for the save-as write.
    const out = applyLineEnding(tab.content.toString(), tab.lineEnding);
    try {
      await invoke('write_file_encoded', {
        path: chosen,
        content: out,
        encoding: tab.encoding,
        withBom: tab.hadBom,
      });
    } catch (e) {
      // The tab keeps its old path and stays dirty; report the failure rather
      // than pretending the save-as went through.
      this.saveFailed = { path: chosen, error: String(e) };
      return false;
    }
    tab.path = chosen;
    delete tab.range;
    if (!tab.explicit) {
      tab.language = detectByFilename(chosen);
    }
    tab.savedContent = tab.content;
    tab.savedLineEnding = tab.lineEnding;
    await this.upsertTab(tab);
    void invoke('add_recent_file', { path: chosen });
    return true;
  }

  /** Splice a range tab's buffer back into its source over `[startByte, endByte)`.
   *  The line ending is restored first (a CRLF source must get its `\r` bytes back
   *  before the byte length is computed, or the rebased end drifts). On success it
   *  rebases `endByte` and refreshes the fingerprint from the rewritten file, marks
   *  the tab clean, persists it, and asks any large viewer of the source to reindex.
   *  `expected` is the conflict baseline (null force-writes past the check). */
  private async splice(
    tab: DocTab,
    expected: Fingerprint | null,
  ): Promise<SpliceResult> {
    const r = tab.range;
    if (__LITE__ || r === undefined) {
      return 'error';
    }
    // Flush point: materialize the rope for the splice write-back. A slice that
    // ended with a line break gets one back if the buffer lost it.
    const out = rangeWriteText(
      tab.content.toString(),
      r.trailingBreak,
      tab.lineEnding,
    );
    let fingerprint: Fingerprint;
    try {
      fingerprint = await invoke<Fingerprint>('splice_file', {
        path: r.sourcePath,
        start: r.startByte,
        end: r.endByte,
        replacement: out,
        expected,
      });
    } catch (e) {
      if (String(e) === FINGERPRINT_MISMATCH) {
        this.rangeConflict = tab;
        return 'mismatch';
      }
      // Every failure past the conflict check is reported: the write-back is a
      // save, and a save that did not happen has to say so or the tab is left
      // dirty with nothing on screen to explain it. The target is the source
      // file, not the range tab's own (empty) path. A read-only source also
      // marks the tab, so the padlock catches up without a reopen.
      if (String(e) === READ_ONLY_DESTINATION) {
        tab.readOnlyFile = true;
      }
      this.saveFailed = { path: r.sourcePath, error: String(e) };
      return 'error';
    }
    r.endByte = r.startByte + replacementByteLength(out, tab.lineEnding);
    r.fingerprint = fingerprint;
    tab.savedContent = tab.content;
    tab.savedLineEnding = tab.lineEnding;
    this.rangeConflict = null;
    await this.upsertTab(tab);
    // Broadcast (all windows, including this one) so a large viewer of the now-
    // rewritten source rebuilds its stale line index.
    void emit(RANGE_SPLICED_EVENT, r.sourcePath);
    return 'ok';
  }

  /** DEV/E2E: run the active range tab's write-back and report the outcome. */
  async rangeSave(): Promise<SpliceResult> {
    const tab = this.activeTab;
    if (tab === null || tab.range === undefined) {
      return 'error';
    }
    return this.splice(tab, tab.range.fingerprint);
  }

  /** Whether the write-back conflict modal is up (DEV/E2E surface). */
  rangeConflictVisible(): boolean {
    return this.rangeConflict !== null;
  }

  /** Conflict choice: write back anyway, ignoring the changed source. */
  async rangeConflictForce(): Promise<SpliceResult> {
    const tab = this.rangeConflict;
    if (tab === null) {
      return 'error';
    }
    return this.splice(tab, null);
  }

  /** Conflict choice: abandon the splice and save the edited buffer as a new file.
   *  The tab sheds its range identity and becomes an ordinary saved document. */
  async rangeConflictSaveAs(pathOverride?: string): Promise<boolean> {
    const tab = this.rangeConflict;
    if (tab === null) {
      return false;
    }
    // A range tab has no path of its own; start from the source file's name.
    const chosen =
      pathOverride ??
      (await save(
        saveDialogOptions(
          tab.language,
          suggestedName(tab.range?.sourcePath ?? ''),
        ),
      ));
    if (chosen === null) {
      return false;
    }
    // Flush point: materialize the rope for the save-as write.
    const out = applyLineEnding(tab.content.toString(), tab.lineEnding);
    try {
      await invoke('write_file_encoded', {
        path: chosen,
        content: out,
        encoding: tab.encoding,
        withBom: tab.hadBom,
      });
    } catch (e) {
      // The conflict modal stays up (rangeConflict is untouched) and the tab
      // keeps its range identity; report the failure rather than nothing.
      this.saveFailed = { path: chosen, error: String(e) };
      return false;
    }
    tab.path = chosen;
    delete tab.range;
    if (!tab.explicit) {
      tab.language = detectByFilename(chosen);
    }
    tab.savedContent = tab.content;
    tab.savedLineEnding = tab.lineEnding;
    this.rangeConflict = null;
    await this.upsertTab(tab);
    return true;
  }

  /** Conflict choice: dismiss the modal, leaving the tab unsaved. */
  rangeConflictCancel(): void {
    this.rangeConflict = null;
  }

  /** Rebuild the line index of any large-file viewer of `path` open in this window
   *  by remounting its keyed view. Called on the local window and by the
   *  cross-window `range-spliced` listener after a source is rewritten. */
  refreshLargeTabs(path: string): void {
    const stale = this.tabs.filter(
      (t) => t.large !== undefined && t.path === path,
    );
    if (stale.length > 0) {
      // The rewritten file's kept index describes bytes that are gone.
      for (const tab of stale) {
        this.dropLargeIndex(tab.id);
      }
      this.largeReloadSeq += 1;
    }
  }

  /** Extract a byte slice of `sourcePath` into a fresh, ordinary editable tab.
   *  The byte offsets are resolved by the caller (the large-file view, which owns
   *  the line index); this reads the slice, captures the source's fingerprint as
   *  the splice write-back's conflict-check baseline, and builds the tab. The
   *  tab's `path` stays empty (only `range.sourcePath` names the real file); Cmd+S
   *  on it splices the edited buffer back into that source over the recorded byte
   *  span instead of going through the save dialog (see `saveActive`, `splice`).
   *
   *  Returns `null` on success, or a message when the range is refused (lossy,
   *  non-UTF-8 content). A genuine read failure — the file was deleted,
   *  permissions changed, the volume went away — is not swallowed: it throws,
   *  so the caller can tell "opened" and "refused" apart from "failed" instead
   *  of all three collapsing onto the same `null`. */
  async createRangeTab(
    sourcePath: string,
    info: {
      startByte: number;
      endByte: number;
      startLine: number;
      endLine: number;
    },
  ): Promise<string | null> {
    if (__LITE__) {
      return null;
    }
    const read = await invoke<RangeRead>('read_range', {
      path: sourcePath,
      start: info.startByte,
      end: info.endByte,
    });
    // A lossy decode means the slice has bytes UTF-8 can't represent; splicing a
    // re-encoded buffer back would corrupt the file, so refuse the edit tab. The
    // byte-faithful "save range" path stays available for such ranges.
    if (read.lossy) {
      return t('doc.range.lossyRefusal');
    }
    let fingerprint: Fingerprint | null;
    try {
      fingerprint = await invoke<Fingerprint>('file_fingerprint', {
        path: sourcePath,
      });
    } catch {
      fingerprint = null;
    }
    // Clean range tab: one shared rope keeps its dirty check O(1) until edited.
    const content = textFromString(normalizeToLf(read.text));
    const lineEnding = detectLineEnding(read.text);
    // The splice write-back targets `sourcePath`, not this tab's own (always
    // empty) `path`, so that's what the pen needs to know about up front.
    const readOnlyFile = await invoke<boolean>('path_writable', {
      path: sourcePath,
    })
      .then((writable) => !writable)
      .catch(() => false);
    const tab: DocTab = {
      id: crypto.randomUUID(),
      path: '',
      readOnlyFile,
      content,
      savedContent: content,
      language: null,
      explicit: false,
      lineEnding,
      savedLineEnding: lineEnding,
      hadBom: false,
      encoding: settingsState.defaultEncoding,
      lossy: false,
      tabIndex: this.nextIndex++,
      // `info.endLine` is not kept: the end line is derived from the tab's
      // content line count and persisted by `snapshot()` as `range_end_line`.
      range: {
        sourcePath,
        startByte: info.startByte,
        endByte: info.endByte,
        fingerprint,
        startLine: info.startLine,
        trailingBreak: sliceEndsWithBreak(read.text),
      },
    };
    this.tabs.push(tab);
    await this.switchTo(this.tabs.length - 1);
    await this.upsertTab(tab);
    return null;
  }

  /** Read a byte slice of `sourcePath` and save it straight to a new file, without
   *  opening a tab (the "save range" lightweight path). `pathOverride` skips the save
   *  dialog (automation/E2E).
   *
   *  Returns `false` only when the dialog was cancelled, `true` on success. A
   *  genuine write failure — disk full, permissions, volume gone — is not
   *  swallowed into that same `false`: it throws, so the caller can tell
   *  "cancelled" and "failed" apart. */
  async saveRangeAs(
    sourcePath: string,
    info: { startByte: number; endByte: number; pathOverride?: string },
  ): Promise<boolean> {
    if (__LITE__) {
      return false;
    }
    // The slice is copied byte-for-byte, so it keeps the source file's type;
    // its name is the natural starting point for the copy.
    const chosen =
      info.pathOverride ??
      (await save(
        saveDialogOptions(
          detectByFilename(sourcePath),
          suggestedName(sourcePath),
        ),
      ));
    if (chosen === null) {
      return false;
    }
    // Copy the original bytes straight through (no decode/re-encode), so a slice
    // with non-UTF-8 content is preserved exactly — this is why "save range" stays
    // available even when the range is too lossy to open as an edit tab.
    await invoke('copy_range', {
      path: sourcePath,
      start: info.startByte,
      end: info.endByte,
      dest: chosen,
    });
    return true;
  }

  /** DEV/E2E: byte-faithful save of the active range tab's source span to `path`,
   *  exercising the same `copy_range` write "save range" uses. */
  async saveRangeBytes(pathOverride: string): Promise<boolean> {
    const tab = this.activeTab;
    if (tab === null || tab.range === undefined) {
      return false;
    }
    return this.saveRangeAs(tab.range.sourcePath, {
      startByte: tab.range.startByte,
      endByte: tab.range.endByte,
      pathOverride,
    });
  }

  /** Whether the active tab is a range tab (DEV/E2E surface). */
  isRangeTab(): boolean {
    return this.activeTab?.range !== undefined;
  }

  /** The active range tab's source and byte span, or null (DEV/E2E surface). */
  rangeInfo(): {
    sourcePath: string;
    startByte: number;
    endByte: number;
  } | null {
    const r = this.activeTab?.range;
    return r === undefined
      ? null
      : {
          sourcePath: r.sourcePath,
          startByte: r.startByte,
          endByte: r.endByte,
        };
  }

  /** Open `path` as a windowed-editing tab: the Rust core opens a session and
   *  streams the file a window at a time (the WindowedEditor owns the CM view).
   *  Returns a message when the open is refused (a non-UTF-8 file), else null.
   *  ponytail: DEV/__auto entry only this segment; the normal open gate keeps
   *  routing oversized files to the read-only viewer until the final step. */
  async openWindowedTab(path: string): Promise<string | null> {
    if (__LITE__) {
      return t('doc.unlock.cannot');
    }
    let open: WindowedOpen;
    try {
      open = await invoke<WindowedOpen>('windowed_open', { path });
    } catch (e) {
      if (String(e) === WINDOWED_NOT_UTF8) {
        return t('doc.unlock.notUtf8');
      }
      return t('doc.unlock.cannot');
    }
    // No displayName suffix: to the user a windowed-edited file is just an
    // editable file (the "windowed" mechanism name is never surfaced in UI).
    const readOnlyFile = await invoke<boolean>('path_writable', { path })
      .then((writable) => !writable)
      .catch(() => false);
    const tab: DocTab = {
      id: crypto.randomUUID(),
      path,
      readOnlyFile,
      content: Text.empty,
      savedContent: Text.empty,
      language: null,
      explicit: false,
      lineEnding: settingsState.defaultLineEnding,
      savedLineEnding: settingsState.defaultLineEnding,
      hadBom: false,
      encoding: settingsState.defaultEncoding,
      lossy: false,
      tabIndex: this.nextIndex++,
      windowed: {
        sessionId: open.session_id,
        totalBytes: open.total_bytes,
        totalLines: open.total_lines,
        fingerprint: open.fingerprint,
        dirty: false,
        topLine: 0,
      },
    };
    this.tabs.push(tab);
    await this.switchTo(this.tabs.length - 1);
    await this.upsertTab(tab);
    return null;
  }
  /** The gate of a windowed session: pending while one of its whole-file
   *  operations runs, whichever editor started it. */
  windowedGate(sessionId: number): OpGate {
    let gate = this.windowedGates.get(sessionId);
    if (gate === undefined) {
      gate = createOpGate(null);
      this.windowedGates.set(sessionId, gate);
    }
    return gate;
  }
  /** Run a whole-file operation (`run` starts the Rust command) for a windowed
   *  session. The session's gate is pending until it has finished, including
   *  this bookkeeping, so an editor mounted meanwhile reads no stale content.
   *  The tab's totals and dirty flag follow the result even when the editor
   *  that asked has been unmounted by then. `changed` says whether the result
   *  changed the content. */
  runWindowedOp<
    T extends {
      total_bytes: number;
      total_lines: number;
      clean: boolean;
      generation: number;
    },
  >(
    sessionId: number,
    run: () => Promise<T>,
    changed: (result: T) => boolean,
  ): Promise<T> {
    const op = run().then((result) => {
      if (changed(result)) {
        this.windowedApplied(
          sessionId,
          result.total_bytes,
          result.total_lines,
          result.clean,
          result.generation,
        );
      }
      return result;
    });
    this.windowedGate(sessionId).begin(op);
    return op;
  }

  /** Called by the WindowedEditor after each successful apply, undo or redo:
   *  record the fresh totals and set the session's tab dirty unless the content
   *  equals the last save. A result older than one already seen is dropped. */
  windowedApplied(
    sessionId: number,
    totalBytes: number,
    totalLines: number,
    clean: boolean,
    generation: number,
  ): void {
    const tab = this.tabOfWindowedSession(sessionId);
    if (
      tab?.windowed === undefined ||
      !this.noteWindowedGeneration(sessionId, generation)
    ) {
      return;
    }
    tab.windowed.totalBytes = totalBytes;
    tab.windowed.totalLines = totalLines;
    tab.windowed.dirty = !clean;
    this.persistActive();
  }
  /** The tab that holds windowed session `sessionId` right now, if any. */
  private tabOfWindowedSession(sessionId: number): DocTab | undefined {
    return appliedTarget(this.tabs, sessionId);
  }
  /** Take a finished save's result into the windowed state `w`. The
   *  fingerprint always follows; the totals and the dirty flag only when no
   *  newer result has been seen. */
  private applyWindowedSaved(
    w: NonNullable<DocTab['windowed']>,
    saved: WindowedSaved,
  ): void {
    w.fingerprint = saved.fingerprint;
    if (this.noteWindowedGeneration(w.sessionId, saved.generation)) {
      w.totalBytes = saved.total_bytes;
      w.totalLines = saved.total_lines;
      w.dirty = !saved.clean;
    }
  }
  /** Record `generation` as the newest seen for a session. False when it is
   *  older than one already seen. */
  private noteWindowedGeneration(
    sessionId: number,
    generation: number,
  ): boolean {
    const seen = this.windowedGenerations.get(sessionId);
    if (seen !== undefined && generation < seen) {
      return false;
    }
    this.windowedGenerations.set(sessionId, generation);
    return true;
  }
  /** Record the line ending read from a large tab's first text. `style` is null
   *  when the sample had no line break, which falls back to the user's default.
   *  Returns the separator typed line breaks get. */
  private setDetectedEnding(
    tab: DocTab,
    style: ReturnType<typeof detectBreakStyle>,
  ): '\r\n' | '\n' {
    const lineEnding = style?.lineEnding ?? settingsState.defaultLineEnding;
    tab.lineEnding = lineEnding;
    tab.savedLineEnding = lineEnding;
    tab.insertLineEnding = lineEnding === 'CRLF' ? '\r\n' : '\n';
    return tab.insertLineEnding;
  }
  /** A windowed tab's editor read its first window: detect the file's line
   *  ending now unless the tab already has one. */
  windowedEndingDetected(
    sessionId: number,
    style: ReturnType<typeof detectBreakStyle>,
  ): '\r\n' | '\n' {
    const tab = this.tabs.find((t) => t.windowed?.sessionId === sessionId);
    if (tab === undefined) {
      return settingsState.defaultLineEnding === 'CRLF' ? '\r\n' : '\n';
    }
    return tab.insertLineEnding ?? this.setDetectedEnding(tab, style);
  }
  /** The viewer's first chunk arrived. A sample without a line break leaves the
   *  tab undetected so the editor decides from its own first window. */
  largeEndingDetected(
    path: string,
    style: ReturnType<typeof detectBreakStyle>,
  ): void {
    const tab = this.tabs.find((t) => t.large !== undefined && t.path === path);
    if (tab === undefined || style === null || tab.insertLineEnding) {
      return;
    }
    this.setDetectedEnding(tab, style);
  }

  /** Save a windowed tab back to disk. `force` skips the fingerprint check; a
   *  conflict raises the conflict modal instead of writing. On success the
   *  fingerprint refreshes, totals update, and the tab goes clean. */
  async saveWindowed(tab: DocTab, force: boolean): Promise<WindowedSaveResult> {
    const w = tab.windowed;
    if (__LITE__ || w === undefined) {
      return 'error';
    }
    let saved: WindowedSaved;
    try {
      saved = await invoke<WindowedSaved>('windowed_save', {
        sessionId: w.sessionId,
        expected: force ? null : w.fingerprint,
        pathOverride: null,
      });
    } catch (e) {
      if (String(e).includes(WINDOWED_FINGERPRINT_MISMATCH)) {
        this.windowedConflict = tab;
        return 'mismatch';
      }
      // Reported for the same reason as `splice`'s: past the conflict check
      // every failure means the save did not happen, and the tab is left dirty
      // either way. This call always writes to `tab.path` (pathOverride is
      // always null here), so that is the target that refused. A read-only
      // destination also marks the tab, so the padlock catches up.
      if (String(e) === READ_ONLY_DESTINATION) {
        tab.readOnlyFile = true;
      }
      this.saveFailed = { path: tab.path, error: String(e) };
      return 'error';
    }
    // The tab may have been closed, or reopened under a new session, while
    // the write ran: the result belongs to the tab that has this session now.
    const live = this.tabOfWindowedSession(w.sessionId);
    if (live?.windowed === undefined) {
      return 'ok';
    }
    this.applyWindowedSaved(live.windowed, saved);
    this.windowedConflict = null;
    await this.upsertTab(live);
    return 'ok';
  }

  /** Discard a windowed tab's unsaved edits: close its session and reopen a fresh
   *  one at the on-disk baseline. The new sessionId remounts the WindowedEditor
   *  (keyed on it), reloading the window from disk. */
  async discardWindowed(tab: DocTab): Promise<void> {
    const w = tab.windowed;
    if (__LITE__ || w === undefined) {
      return;
    }
    // The fresh session is opened before the old one is let go: when the open
    // is refused (lite) or fails, the tab keeps the session it has.
    let open: WindowedOpen | null = null;
    if (!isLite()) {
      try {
        open = await invoke<WindowedOpen>('windowed_open', { path: tab.path });
      } catch {
        if (!isLite()) {
          return;
        }
      }
    }
    // Lite cannot start a session, but the tab already has one and the file's
    // baseline index is all a reopen needs: the quit and close gates' Discard
    // has to be able to clear the edits there too.
    if (open === null) {
      try {
        open = await this.reopenAtBaseline(tab.path, w.sessionId);
      } catch {
        return;
      }
    }
    if (!__LITE__) {
      void invoke('windowed_close', { sessionId: w.sessionId });
    }
    this.windowedGates.delete(w.sessionId);
    this.windowedGenerations.delete(w.sessionId);
    tab.windowed = {
      sessionId: open.session_id,
      totalBytes: open.total_bytes,
      totalLines: open.total_lines,
      fingerprint: open.fingerprint,
      dirty: false,
      topLine: 0,
    };
    this.windowedConflict = null;
    await this.upsertTab(tab);
  }

  /** A fresh session on `path` at its on-disk baseline, made from the index of
   *  the live session `sessionId` through `windowed_reopen` instead of
   *  `windowed_open`. */
  private async reopenAtBaseline(
    path: string,
    sessionId: number,
  ): Promise<WindowedOpen> {
    if (__LITE__) {
      throw new Error('windowed editing is not in this build');
    }
    const base = await invoke<WindowedIndexSnapshot>('windowed_index', {
      sessionId,
    });
    const r = await invoke<WindowedReopened>('windowed_reopen', {
      path,
      index: base.index,
      fingerprint: base.fingerprint,
      digest: base.digest,
    });
    return {
      session_id: r.session_id,
      total_bytes: r.total_bytes,
      total_lines: r.total_lines,
      fingerprint: r.fingerprint,
    };
  }

  /** DEV/E2E: save the active windowed tab (fingerprint-checked). */
  async saveWindowedActive(): Promise<WindowedSaveResult> {
    const tab = this.activeTab;
    if (tab?.windowed === undefined) {
      return 'error';
    }
    return this.saveWindowed(tab, false);
  }

  /** DEV/E2E: force-save the active windowed tab past the fingerprint check. */
  async saveWindowedForce(): Promise<WindowedSaveResult> {
    const tab = this.activeTab;
    if (tab?.windowed === undefined) {
      return 'error';
    }
    return this.saveWindowed(tab, true);
  }

  /** DEV/E2E: discard the active windowed tab's unsaved edits. */
  async discardWindowedActive(): Promise<void> {
    const tab = this.activeTab;
    if (tab?.windowed === undefined) {
      return;
    }
    await this.discardWindowed(tab);
  }

  /** Whether the active tab is a windowed tab (DEV/E2E surface). */
  isWindowedTab(): boolean {
    return this.activeTab?.windowed !== undefined;
  }

  /** Whether the windowed save-conflict modal is up (DEV/E2E surface). */
  windowedConflictVisible(): boolean {
    return this.windowedConflict !== null;
  }

  /** `rescanned` from the most recently completed `windowed_reopen` (DEV/E2E
   *  surface — see `lastWindowedRestoreRescanned`). Null before any restore
   *  has completed in this window. */
  windowedRestoreRescanned(): boolean | null {
    return this.lastWindowedRestoreRescanned;
  }

  /** Conflict choice: write back anyway, ignoring the changed source. */
  async windowedConflictForce(): Promise<WindowedSaveResult> {
    const tab = this.windowedConflict;
    if (tab === null) {
      return 'error';
    }
    return this.saveWindowed(tab, true);
  }

  /** Conflict choice: save the current buffer to a chosen path instead. The
   *  session and the tab both move to the chosen path. */
  async windowedConflictSaveAs(pathOverride?: string): Promise<boolean> {
    const tab = this.windowedConflict;
    if (tab?.windowed === undefined) {
      return false;
    }
    const chosen =
      pathOverride ??
      (await save(saveDialogOptions(tab.language, suggestedName(tab.path))));
    if (chosen === null) {
      return false;
    }
    return this.windowedSaveTo(tab, chosen);
  }
  /** Write a windowed tab's buffer to `chosen` and retarget the tab to it.
   *  `expected` is null, so Rust checks nothing against the destination: the
   *  user chose it in the dialog. A failure retargets nothing and is reported
   *  with `chosen`; it never raises the conflict modal, whose Force button
   *  writes the old path. */
  private async windowedSaveTo(tab: DocTab, chosen: string): Promise<boolean> {
    const w = tab.windowed;
    if (__LITE__ || w === undefined) {
      return false;
    }
    let saved: WindowedSaved;
    try {
      saved = await invoke<WindowedSaved>('windowed_save', {
        sessionId: w.sessionId,
        expected: null,
        pathOverride: chosen,
      });
    } catch (e) {
      // The user picked this path by hand, so every failure here is reported
      // rather than handing back a dialog that looks like it did nothing.
      // `chosen` is the target, not `tab.path`, which is still the old file.
      this.saveFailed = { path: chosen, error: String(e) };
      return false;
    }
    // The tab may have been closed, or reopened under a new session, while
    // the write ran: the result belongs to the tab that has this session now.
    const live = this.tabOfWindowedSession(w.sessionId);
    if (live?.windowed === undefined) {
      return true;
    }
    // Rust has already moved the session to `chosen`; mirror that here.
    live.path = chosen;
    if (!live.explicit) {
      live.language = detectByFilename(chosen);
    }
    this.applyWindowedSaved(live.windowed, saved);
    this.windowedConflict = null;
    await this.upsertTab(live);
    void invoke('add_recent_file', { path: chosen });
    return true;
  }

  /** Conflict choice: dismiss the modal, leaving the tab unsaved. */
  windowedConflictCancel(): void {
    this.windowedConflict = null;
  }

  /** Change the active tab's encoding. A clean tab re-decodes from disk under
   *  the new encoding (fresh content, saved baseline reset); a dirty tab keeps
   *  its buffer and only changes the encoding used at save time (stays dirty). */
  async setEncoding(label: string): Promise<void> {
    const tab = this.activeTab;
    // A large tab's bytes are never re-decoded (the editor takes UTF-8 only
    // and the viewer decodes lossily), and the re-decode below would read the
    // whole file into memory.
    if (tab === null || isLargeKind(tab) || tab.encoding === label) {
      return;
    }
    if (this.isDirty(tab)) {
      tab.encoding = label;
      this.persistActive();
      return;
    }
    let decoded: Decoded;
    try {
      decoded = await invoke<Decoded>('read_file_as', {
        path: tab.path,
        encoding: label,
      });
    } catch {
      this.encodingFailed = tab.path;
      return;
    }
    // Re-decode replaces the buffer wholesale; one shared rope keeps the fresh
    // clean tab's dirty check O(1).
    const content = textFromString(normalizeToLf(decoded.content));
    tab.content = content;
    tab.savedContent = content;
    tab.lineEnding = detectLineEnding(decoded.content);
    tab.savedLineEnding = tab.lineEnding;
    tab.hadBom = decoded.had_bom;
    tab.encoding = decoded.encoding;
    tab.lossy = decoded.lossy;
    // The editor doc for this tab is already mounted, so push the new buffer in.
    this.reloadTargetId = tab.id;
    this.reloadSeq += 1;
    this.persistActive();
  }

  /** Persist all logical bounds onto every tab so the lowest-index one (used on
   *  restore) always carries fresh bounds. */
  setBounds(x: number, y: number, width: number, height: number): void {
    this.bounds = { x, y, width, height };
    for (const tab of this.tabs) {
      // Same stall-avoidance as the edit debounce: don't serialize a large dirty
      // buffer just to record a window drag. Uses the debounce policy so a
      // mid-size dirty tab is skipped here too; its fresh bounds land at the quit
      // flush, which always writes dirty tabs in full.
      if (
        debounceContentPolicy(this.isDirty(tab), tab.content.length) === 'skip'
      ) {
        continue;
      }
      void this.upsertTab(tab);
    }
  }

  /** Drop a pending active-tab upsert so a following delete can't be undone. */
  cancelPending(): void {
    this.persistActive.cancel();
  }

  /** Index of the first dirty tab whose unsaved buffer is too large to ride
   *  along in a snapshot ('skip'), or -1. The quit gate blocks on such a tab:
   *  its edits cannot be restored after exit, so the user must save or discard
   *  it before the app can quit. */
  firstOversizedDirtyIndex(): number {
    return this.tabs.findIndex((t) =>
      t.windowed !== undefined
        ? t.windowed.dirty
        : this.isDirty(t) &&
          snapshotContentPolicy(true, t.content.length) === 'skip',
    );
  }

  /** Index of the first dirty tab, within the snapshot size ceiling, whose
   *  most recent full-content write failed to reach disk (the snapshot folder
   *  missing/unwritable, the disk full, made read-only, ...). Unlike
   *  `firstOversizedDirtyIndex`, this is discovered only by actually
   *  attempting the write, not known in advance from the content size. Such
   *  an edit exists only in memory: exiting now loses it with no snapshot to
   *  restore from. Windowed tabs are excluded — a dirty one is already caught
   *  by `firstOversizedDirtyIndex` regardless of write outcome (see its
   *  class-doc note on `snapshot()`). */
  firstUnwritableDirtyIndex(): number {
    return this.tabs.findIndex(
      (t) =>
        t.windowed === undefined && this.isDirty(t) && t.writeFailed === true,
    );
  }

  /** The tab the quit/close gate must block on right now, if any. An oversized
   *  dirty tab takes priority — it is known before a write is even attempted —
   *  then a dirty tab whose write actually failed. `oversized` tells the
   *  caller which condition applies, since the two need different wording and
   *  a different save action. */
  firstBlockingDirty(): { index: number; oversized: boolean } | null {
    const oversized = this.firstOversizedDirtyIndex();
    if (oversized !== -1) {
      return { index: oversized, oversized: true };
    }
    const unwritable = this.firstUnwritableDirtyIndex();
    return unwritable === -1 ? null : { index: unwritable, oversized: false };
  }

  /** Discard a tab's unsaved edits, reverting it to its last saved state so it
   *  no longer blocks the quit gate. The buffer becomes clean (the on-disk
   *  content for a path/range tab, empty for an untitled one), the change is
   *  persisted, and the active tab's editor is refreshed. */
  discardChanges(index: number): void {
    const tab = this.tabs[index];
    if (tab === undefined) {
      return;
    }
    tab.content = tab.savedContent;
    tab.lineEnding = tab.savedLineEnding;
    if (index === this.activeIndex) {
      this.reloadTargetId = tab.id;
      this.reloadSeq += 1;
    }
    void this.upsertTab(tab);
  }

  /** Remove a tab's store entry and drop it from the window. */
  async deleteTab(index: number): Promise<void> {
    const tab = this.tabs[index];
    if (tab === undefined) {
      return;
    }
    if (index === this.activeIndex) {
      this.persistActive.cancel();
    }
    // Release the Rust windowed session before dropping the tab.
    if (tab.windowed !== undefined) {
      if (!__LITE__) {
        void invoke('windowed_close', { sessionId: tab.windowed.sessionId });
      }
      this.windowedGates.delete(tab.windowed.sessionId);
      this.windowedGenerations.delete(tab.windowed.sessionId);
    }
    if (tab === this.windowedConflict) {
      this.windowedConflict = null;
    }
    await invoke('delete_note', { id: tab.id });
    this.releaseTabView(tab.id);
    this.tabs.splice(index, 1);
    // Always write `activeIndex`, even when the computed value equals the
    // current one: closing the active tab can leave the numeric index
    // unchanged while the tab now living at that index is a different tab
    // (e.g. closing tab 0 while a pending windowed-restore tab sits at index
    // 1 shifts it down to index 0). The setter is what notices that and
    // kicks off its restore — see the `activeIndex` accessor.
    let newActive = this.activeIndex;
    if (newActive > index) {
      newActive -= 1;
    } else if (newActive >= this.tabs.length) {
      newActive = Math.max(0, this.tabs.length - 1);
    }
    this.activeIndex = newActive;
  }

  /** Drop the store entry of every clean tab as this window closes, so the next
   *  launch does not reopen a document the user had already closed. Without it
   *  the store only ever grows: closing a *tab* deletes its record, but closing
   *  the *window* left every tab behind, and each launch restored the union of
   *  everything ever opened.
   *
   *  A dirty tab keeps its snapshot — carrying unsaved edits across a restart is
   *  the whole reason the store exists — so a window with unsaved work still
   *  comes back. Quitting is a different handshake (`flush-request`) and is
   *  untouched: a quit still restores the whole session.
   *
   *  The deletion itself is deferred on the Rust side (`drop_closed_tabs`), not
   *  done here: this window can be the FIRST window of a desktop-shell batch
   *  close, which cannot be recognized as part of the batch, so it still runs
   *  this normal single-close flow even though the app is in fact quitting. A
   *  synchronous delete here would then permanently drop tabs the quit
   *  handshake — starting a moment later — was going to preserve. `label` is
   *  this window's own label, which the backend needs to look up when its
   *  `CloseRequested` landed (see `should_forget_tabs` in `lib.rs`). */
  async dropClosedTabs(label: string): Promise<void> {
    this.persistActive.cancel();
    for (const id of [...this.largeIndexes.keys()]) {
      this.dropLargeIndex(id);
    }
    const clean = this.tabs.filter((t) => !this.isDirty(t));
    for (const tab of clean) {
      // Release the Rust windowed session too; the record is going away.
      if (tab.windowed !== undefined) {
        if (!__LITE__) {
          void invoke('windowed_close', { sessionId: tab.windowed.sessionId });
        }
      }
    }
    await invoke('drop_closed_tabs', { label, ids: clean.map((t) => t.id) });
  }

  /** Push every dirty tab to disk-store before a quit ack (not just the active). */
  async flushAll(): Promise<void> {
    this.persistActive.flush();
    await this.lastSave;
    await Promise.all(
      this.tabs.filter((t) => this.isDirty(t)).map((t) => this.upsertTab(t)),
    );
  }

  setCursor(line: number, col: number): void {
    this.line = line;
    this.col = col;
  }

  /** Push the active tab's current buffer back into the editor. Used when
   *  leaving the table view so the CM document reflects table-side edits made
   *  while its (hidden) view was out of sync. */
  forceEditorReload(): void {
    this.reloadTargetId = this.activeTab?.id ?? '';
    this.reloadSeq += 1;
  }
}

export const documentWindow = new DocumentWindowState();
