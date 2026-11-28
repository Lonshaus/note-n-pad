// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';
import { devTrace } from '../dev/devTrace';
import { debounce } from '../util/debounce';
import { nextSeq } from '../util/seq';
import {
  detectByFilename,
  docHasLongLine,
  restoredLanguage,
} from '../editor/language';
import { beautifyJson, softWrapLongLines } from '../util/longLine';
import {
  UnreadableRestore,
  activePositionAfterRestore,
  restoreOutcome,
} from '../util/restoreOutcome';
import { saveDialogOptions, suggestedName } from '../util/saveDialog';
import { fileName, retargetPath, type PathRules } from '../util/filePath';
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
  isRangeBoxDirty,
  nextRangeBox,
  nextWriteBack,
  openRangeBox,
  rangeBoxWriteText,
  rebaseRangeBox,
  type RangeBox,
  type RangeWriteOutcome,
} from '../util/rangeEditBox';
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
import { platform } from './platform.svelte';
import { editionState, isLite } from './edition.svelte';
import { nextTabIndex } from '../util/keptTabs';
import { compareTabOrder, keyBetween, newKey, orderOf } from '../util/tabOrder';
import { dropSlot, toClientPoint, type TabBarGeometry } from '../util/tabDrag';
import { pasteLocks, type PasteLock } from '../util/pasteLock';
import {
  fromPayload,
  toPayload,
  type TabPayload,
  type ViewPos,
} from '../util/tabPayload';
import {
  BEGIN,
  DROP,
  SETTLE,
  committedMeta,
  type BeginResult,
  type CancelResult,
  type CommittedMeta,
  type DropTarget,
  type Point,
  type SendPayload,
  type SettleAction,
  type StartResult,
  type TearOffTarget,
  type TransferBounds,
  type TransferTarget,
} from '../util/tabTransferWire';
import {
  editorPayload,
  type EditorJson,
  type ScrollRecord,
} from '../editor/editorSeed';
import type { EditorState } from '@codemirror/state';
import type { ViewMode } from '../util/viewModes';
import { isCleanOldRange, needsRewrite } from '../util/restoreRecords';
import { isOrdinaryTab, pickHeldTab, touchMru } from './heldTab';
import type { LargeIndexRef } from '../util/largeIndex';
import {
  snapshotContentPolicy,
  debounceContentPolicy,
} from '../util/snapshotPolicy';
import { t } from '../i18n';
import {
  convertController,
  type DocConvertHost,
} from './convertController.svelte';
import {
  FILE_NOT_FOUND,
  READ_ONLY_DESTINATION,
  isLiteRefusal,
} from '../util/protocol';
import { appliedTarget } from '../util/windowedApplied';
import { readDocument, writeDocument, type Decoded } from '../util/documentIo';
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
  /** What the session writes now; null once it is plain UTF-8 again. */
  conv: ConvState | null;
}
/** What a converted session writes (Rust `ConvState`). */
interface ConvState {
  encoding: string;
  bom: boolean;
  in_place: boolean;
}
/** The error `windowed_save` and `convert_save` give for a text that has no form
 *  in the encoding it is saved in (protocol value). */
const UNMAPPABLE = 'unmappable';
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
/** Result of a range edit box write-back: written, refused for a conflict (the
 *  conflict modal is now up), or failed for another reason. */
export type SpliceResult = 'ok' | 'mismatch' | 'error';
/** What `spliceRange` found: the source rewritten (with its new fingerprint and
 *  the span the replacement took), changed since `expected` was taken, or
 *  refused for another reason. */
export type SpliceOutcome =
  | ({ status: 'ok' } & RangeWriteOutcome)
  | { status: 'mismatch' }
  | { status: 'error'; error: string };
/** Replace `[startByte, endByte)` of `sourcePath` with `replacement`, and
 *  tell every window so a large viewer of the file rebuilds its stale line
 *  index. `expected` is the conflict baseline; null writes past the check. Not
 *  tied to a tab: the caller owns what a result means. */
export async function spliceRange(
  target: {
    sourcePath: string;
    startByte: number;
    endByte: number;
    lineEnding: LineEnding;
  },
  replacement: string,
  expected: Fingerprint | null,
): Promise<SpliceOutcome> {
  let written: RangeWriteOutcome;
  try {
    written = await invoke<RangeWriteOutcome>('splice_file', {
      path: target.sourcePath,
      start: target.startByte,
      end: target.endByte,
      replacement,
      // What a lone CR the splice would join to a line feed is rewritten to.
      insertSep: target.lineEnding === 'CRLF' ? '\r\n' : '\n',
      expected,
    });
  } catch (e) {
    if (String(e) === FINGERPRINT_MISMATCH) {
      return { status: 'mismatch' };
    }
    return { status: 'error', error: String(e) };
  }
  // Every window, this one included.
  void emit(RANGE_SPLICED_EVENT, target.sourcePath);
  return { status: 'ok', ...written };
}
/** A byte slice decoded as text plus whether the decode was lossy (invalid
 *  UTF-8 replaced), mirroring the Rust `ReadRange`. */
interface RangeRead {
  text: string;
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
/** What a tab close compares across its wait for the core. */
export interface TabCloseState {
  content: Text;
  lineEnding: LineEnding;
  /** A windowed tab's newest content generation, or undefined. */
  generation: number | undefined;
}
/** Whether the tab was edited while its close waited: another document, another
 *  line ending, a newer windowed generation, or windowed input not in the core
 *  yet (`pending`). */
export function editedWhileClosing(
  before: TabCloseState,
  now: TabCloseState & { pending: boolean },
): boolean {
  return (
    now.pending ||
    before.content !== now.content ||
    before.lineEnding !== now.lineEnding ||
    before.generation !== now.generation
  );
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
  /** Stable identity of the tab across windows and restarts; it does not follow
   *  a reorder. */
  tabIndex: number;
  /** Sort key of the tab within its window, stored as `tab_order`. The tabs are
   *  in array order of this key. */
  order: number;
  /** Present only on a read-only large-file tab: its content is never loaded,
   *  it is never dirty, and it does not participate in snapshots. `unlockRefused`
   *  is set (to the reason shown on the tab lock) once an in-place unlock is
   *  refused, e.g. a non-UTF-8 file; the lock then stays disabled. */
  large?: { size: number; unlockRefused?: string };
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
    /** Null for a file that is not plain UTF-8: its record names the encoding
     *  instead, and the restore rebuilds the session by decoding the file. */
    index: CheckpointIndex | null;
    fingerprint: Fingerprint;
    /** Decimal string, not a number — see `NoteSnapshot.windowed_digest`. */
    digest: string;
    topLine: number;
    /** On-disk size at snapshot time, the fallback tab's `large.size` if the
     *  restore falls back to the read-only viewer. */
    size: number;
    /** Set when the file is not plain UTF-8: the encoding it is written in and
     *  whether it starts with a byte order mark. The restore decodes it. */
    encoding?: string;
    bom?: boolean;
  };
  /** True when this tab's most recent snapshot write attempted its full
   *  content (not the size-ceiling 'skip' path) and failed to reach disk —
   *  the snapshot folder missing/unwritable, the disk full, made read-only.
   *  Cleared by the next write that succeeds. See `firstUnwritableDirtyIndex`. */
  writeFailed?: boolean;
  /** Set when the file behind a tab holding unsaved changes was found deleted or
   *  moved away. In memory only, never persisted. Such a tab is never written
   *  back to `path`: saving asks for a new path instead. */
  missing?: boolean;
  /** Present on a large-file editing tab that a paste made out of a document or
   *  a sticky note, until it is a plain UTF-8 file. */
  converted?: ConvertedTab;
  /** Work in flight on the tab that a move to another window must not interrupt
   *  (a file write, a re-decode, an edit box opening); in memory only. */
  inFlight?: number;
  /** The tab is being closed: `deleteTab` began. In memory only. */
  closing?: boolean;
  /** The tab is frozen, on its way to another window: it cannot be edited or
   *  written, and a close of it calls the move off first. In memory only. */
  transferring?: boolean;
  /** The tab has landed in another window and is leaving this one: nothing of
   *  it is written or deleted any more. In memory only. */
  released?: boolean;
  /** A sticky note's text handed over as this tab, until the handoff is done.
   *  In memory only. */
  handingOver?: boolean;
}
/** What a tab made by a paste needs to know of where it came from and what it
 *  is written as. */
export interface ConvertedTab {
  /** The file a save goes to; null while there is none (an untitled document
   *  or a sticky note), and a save asks for one. */
  target: string | null;
  encoding: string;
  bom: boolean;
  origin: 'document' | 'untitled' | 'sticky';
  /** The sticky note the tab came from (origin 'sticky'). */
  noteId?: string;
  /** Saved at least once: the tab has a record of its own from then on. Before,
   *  the record of the document or the note stays as it was. */
  saved: boolean;
}
/** How the host compares paths, for following a rename. */
export function pathRules(): PathRules {
  return {
    caseInsensitive: platform.isMacOS || platform.isWindows,
    backslash: platform.isWindows,
  };
}
/** What `convert_claim` gives a window that takes a handoff. */
export interface ClaimedHandoff {
  convert_id: string;
  note_id: string;
  language: string | null;
  encoding: string;
  line_ending: LineEnding;
}
/** A fresh open of `path` could not read it; `error` is what the core said. */
export class ReadFailed extends Error {
  readonly error: string;

  constructor(path: string, error: string) {
    super(`cannot read ${path}`);
    this.name = 'ReadFailed';
    this.error = error;
  }
}

interface Bounds {
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
}
/** How long a tab the core sent on waits for the window to be ready to send it,
 *  and how often it looks. */
export const SEND_WAIT_MS = 5000;
export const SEND_WAIT_STEP_MS = 20;
/** What the window around the state says of a drag: a tab cannot be dragged
 *  while one of these holds. */
export interface DragHost {
  /** A missing-file dialog holds the window on its tab. */
  navigationLocked(): boolean;
  /** The quit, close or oversized-tab gate is up. */
  gateVisible(): boolean;
  /** Any other dialog is up. */
  modalOpen(): boolean;
  /** The window is closing (the close gate holds it). */
  closing(): boolean;
  /** A quit has the window. */
  quitting(): boolean;
}
/** What a tab on its way needs of the window around the state. */
export interface TransferHost {
  /** Lock (or, with undefined, unlock) the editor of the tab `id`. */
  showLock(id: string, lock: PasteLock | undefined): void;
  /** The ordinary editor's state for the tab, when it has one. */
  editorStateOf(id: string): EditorState | null;
  /** Where the tab's editor is scrolled to, when it has been. */
  scrollOf(id: string): ScrollRecord | null;
  viewModeOf(id: string): ViewMode | undefined;
  setViewMode(id: string, mode: ViewMode): void;
  /** Let go of what the window keeps for a tab that left it. */
  forgetTab(id: string): void;
  /** Where the tabs are drawn, or null before there is a bar. */
  dropGeometry(): TabBarGeometry | null;
  /** Whether any dialog is up. */
  modalOpen(): boolean;
  /** Close this window (the sender after its last tab left, or a window
   *  left with nothing). */
  closeWindow(): Promise<void>;
}
/** A tab that arrived, as it sits in the window. */
export type ArrivedHandler = (tab: DocTab) => void;
/** The editor's seed for a tab: what it keeps besides the text. */
export interface Seed {
  editor: EditorJson | null;
  scroll: ScrollRecord | null;
}
/** A tab on its way in: claimed and answered, not yet one of the window's. */
export interface IncomingCopy {
  t: number;
  tab: DocTab;
  payload: TabPayload;
  /** The keys around it left no number between them: every tab is renumbered
   *  when it comes in. */
  renumber: boolean;
}
/** Why a tab cannot be moved to another window now. */
export type TransferBlock =
  | 'released'
  | 'transferring'
  | 'op'
  | 'in-flight'
  | 'closing'
  | 'convert'
  | 'handing-over'
  | 'range-box'
  | 'windowed-op'
  | 'paste'
  | 'locked';
/** What the window knows of a tab that its fields do not say. */
export interface BlockFacts {
  /** An operation in `runTabOp` (a restore, an unlock, a copy). */
  op: boolean;
  /** A paste conversion of the tab. */
  convert: boolean;
  /** The range edit box is open on the tab. */
  rangeBox: boolean;
  /** A whole-file operation of its windowed session is pending. */
  windowedOp: boolean;
  /** A paste holds the tab. */
  paste: boolean;
  /** Any drag-start lock. */
  locked: boolean;
}
/** The reason a tab cannot be moved to another window, or null when it can:
 *  anything that is still running on it, or that would be lost or doubled by
 *  the move. */
export function transferBlocker(
  tab: DocTab,
  facts: BlockFacts,
): TransferBlock | null {
  if (tab.released === true) {
    return 'released';
  }
  if (tab.transferring === true) {
    return 'transferring';
  }
  if (facts.op) {
    return 'op';
  }
  if ((tab.inFlight ?? 0) > 0) {
    return 'in-flight';
  }
  if (tab.closing === true) {
    return 'closing';
  }
  if (facts.convert) {
    return 'convert';
  }
  if (tab.handingOver === true) {
    return 'handing-over';
  }
  if (facts.rangeBox) {
    return 'range-box';
  }
  if (facts.windowedOp) {
    return 'windowed-op';
  }
  if (facts.paste) {
    return 'paste';
  }
  if (facts.locked) {
    return 'locked';
  }
  return null;
}
/** A release of a dragged tab: where the pointer was, and what the tab bar made
 *  of it. */
export interface ReleaseAt {
  /** The client point of the release. */
  x: number;
  y: number;
  /** The sender's `devicePixelRatio`. */
  dpr: number;
  /** The slot the pointer was over on the own tab bar. */
  slot: number;
  /** The release was over the own tab bar. */
  overBar: boolean;
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
export class DocumentWindowState {
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
  /** Tabs whose close is waiting for the core, so a repeated close of the same
   *  tab does nothing. */
  private closingTabs = new Set<DocTab>();
  /** Ids of large tabs opened for editing while another tab was held in front:
   *  they unlock once they are shown. */
  private unlockWhenShown = new Set<string>();
  /** Orphaned records of a file an open tab already shows, by tab id, merged
   *  into the tab once it is shown. */
  private adoptWhenShown = new Map<string, NoteSnapshot>();
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
      void invoke('drop_line_index', { id: ref.id });
      return;
    }
    this.largeIndexes.set(id, ref);
  }
  private dropLargeIndex(id: string): void {
    const ref = this.largeIndexes.get(id);
    if (ref !== undefined) {
      this.largeIndexes.delete(id);
      void invoke('drop_line_index', { id: ref.id });
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
  /** Called once `init` has restored the window's tabs and set `ready`. */
  onRestored: (() => void) | null = null;
  /** Bumped to force the editor to reload the active tab's buffer from state,
   *  e.g. after re-decoding under a new encoding (content changed externally). */
  reloadSeq = $state(0);
  /** The id of the tab the last `reloadSeq` bump was meant for. */
  reloadTargetId = '';
  /** Bumped after a splice rewrites a source file whose large-file viewer tab is
   *  in this window, so the keyed view remounts and rebuilds its line index. */
  largeReloadSeq = $state(0);
  /** The range edit box over the active large-file tab, or null. While its
   *  `conflict` is set the box's write-back found the source changed and
   *  DocumentApp renders the conflict modal. It is never persisted. */
  #rangeBox = $state.raw<RangeBox | null>(null);
  get rangeBox(): RangeBox | null {
    return this.#rangeBox;
  }
  set rangeBox(box: RangeBox | null) {
    const hadConflict = this.#rangeBox?.conflict === true;
    this.#rangeBox = box;
    if (hadConflict && box?.conflict !== true) {
      this.onConflictClosed?.();
    }
  }
  /** The windowed tab whose save hit a fingerprint conflict, awaiting the user's
   *  choice (force-write / save-as / cancel). Null when none is pending. */
  #windowedConflict = $state<DocTab | null>(null);
  get windowedConflict(): DocTab | null {
    return this.#windowedConflict;
  }
  set windowedConflict(tab: DocTab | null) {
    const hadConflict = this.#windowedConflict !== null;
    this.#windowedConflict = tab;
    if (hadConflict && tab === null) {
      this.onConflictClosed?.();
    }
  }
  /** Called when a write-back conflict dialog (the box's or a windowed tab's)
   *  has gone, however it was answered. */
  onConflictClosed: (() => void) | null = null;
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
  /** A discard of a tab's changes that failed: the tab's name and the error. The
   *  tab is left as it was. */
  discardFailed = $state<{ name: string; error: string } | null>(null);
  /** Paths of restored clean tabs that exist but could not be read. They are
   *  not opened (a blank tab would pass for the file); reported once. */
  restoreUnreadable = $state<string[]>([]);
  /** True when the most recent snapshot write did not reach disk. `upsertTab`
   *  never lets a write's rejection propagate (see its own comment), so this
   *  is the only surviving signal that a save failed; cleared by the next
   *  write that succeeds. No UI reads this yet (see the follow-up issue) —
   *  it exists so a failure is not swallowed into nothing. */
  snapshotFailed = $state(false);
  /** Dismiss the unreadable-restore report. */
  dismissRestoreUnreadable(): void {
    this.restoreUnreadable = [];
  }
  /** Dismiss the failed-open report. */
  dismissOpenFailed(): void {
    this.openFailed = null;
  }
  /** Dismiss the failed-discard report. */
  dismissDiscardFailed(): void {
    this.discardFailed = null;
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
  /** Settles once `init` knows the group's stored tab indices; a new tab asked
   *  for before then waits, or it would take an index a stored tab holds. */
  private settleIndex: () => void = () => {};
  /** Whether `init` has told the window the group's stored tab indices. */
  indexKnown = false;
  private indexSettled = new Promise<void>((resolve) => {
    this.settleIndex = () => {
      this.indexKnown = true;
      resolve();
    };
  });
  private lastSave: Promise<void> = Promise.resolve();
  /** The writes of each tab that have not settled, by tab id. */
  private pendingWrites = new Map<string, Set<Promise<void>>>();
  /** Tab ids with a `beginWindowedRestore` in flight, so re-activating a tab
   *  mid-restore (switch away and back) never starts a second reopen. Plain
   *  (non-reactive) Set: it is a dedupe guard, not render state. */
  private restoringWindowedIds = new Set<string>();
  /** Per tab id, the tail of its in-flight operation chain (see `runTabOp`). */
  private tabOps = new Map<string, Promise<void>>();
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
    if (tab.windowed !== undefined) {
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
    // The encoding of a converted tab's file, once it has one; a restore that is
    // still pending keeps what it was restored with.
    const savedConv = tab.converted?.saved === true ? tab.converted : undefined;
    const windowedEncoding =
      savedConv?.encoding ?? pendingRestore?.encoding ?? null;
    const windowedBom = savedConv?.bom ?? pendingRestore?.bom ?? false;
    // A record with an encoding is told from a plain one by the encoding alone:
    // the restore decodes the file and has no use for the checkpoint index.
    const windowedIndex =
      windowedEncoding !== null
        ? null
        : (windowedIndexSnap?.index ?? pendingRestore?.index ?? null);
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
    // the policy applies to every tab. A clean tab persists empty content —
    // loadTab re-reads it from disk, so serializing the whole thing is wasted IPC. A dirty
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
      tab_order: tab.order,
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
      // A range is an edit box now, never a tab: the fields only read old records.
      range_source: null,
      range_start: null,
      range_end: null,
      range_fp_size: null,
      range_fp_mtime: null,
      range_start_line: null,
      range_end_line: null,
      range_trailing_break: null,
      // A windowed tab persists what `beginWindowedRestore` needs to rebuild the
      // session with no rescan (see `windowed_reopen`); its presence is what
      // marks the tab as "was unlocked" on restore.
      windowed_index: windowedIndex,
      windowed_fp_size: windowedFpSize,
      windowed_fp_mtime: windowedFpMtime,
      windowed_digest: windowedDigest,
      windowed_top_line: windowedTopLine,
      windowed_encoding: windowedEncoding,
      windowed_bom: windowedBom,
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
    // A tab on its way is written by neither window until it has landed.
    if (this.onItsWay(tab)) {
      return Promise.resolve();
    }
    // A tab a paste made is not written until it is saved: the record of the
    // document or the note it came from is what a restart restores.
    if (tab.converted !== undefined && !tab.converted.saved) {
      return Promise.resolve();
    }
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
    this._writesPending += 1;
    void promise.then(() => {
      this._writesPending -= 1;
      if (this._writesPending === 0) {
        this._clicksInWait = 0;
      }
    });
    this.trackWrite(tab.id, promise);
    return promise;
  }
  private trackWrite(id: string, write: Promise<void>): void {
    const writes = this.pendingWrites.get(id) ?? new Set<Promise<void>>();
    writes.add(write);
    this.pendingWrites.set(id, writes);
    void write.then(() => {
      writes.delete(write);
      if (writes.size === 0 && this.pendingWrites.get(id) === writes) {
        this.pendingWrites.delete(id);
      }
    });
  }
  /** Whether the tab is frozen for a move to another window, or has left. */
  private onItsWay(tab: DocTab): boolean {
    return tab.transferring === true || tab.released === true;
  }
  /** Run `work` with the tab counted as busy, so it is not moved meanwhile. */
  private async busy<T>(tab: DocTab, work: () => Promise<T>): Promise<T> {
    tab.inFlight = (tab.inFlight ?? 0) + 1;
    try {
      return await work();
    } finally {
      tab.inFlight = (tab.inFlight ?? 1) - 1;
      if (tab.inFlight === 0) {
        delete tab.inFlight;
      }
    }
  }
  /** Read a file from disk and build a tab, honouring a restored snapshot when
   *  it carries unsaved edits (snapshot wins over disk, matching stickies). */
  private async loadTab(
    path: string,
    snap: NoteSnapshot | null,
  ): Promise<DocTab> {
    // A range tab of an earlier version restores as an ordinary untitled tab
    // holding its edited slice; it has no source to write back to any more. Its
    // record is written again by the caller. A clean one is never loaded here.
    if (snap !== null && snap.range_source !== null) {
      return {
        id: snap.id,
        path: '',
        readOnlyFile: false,
        content: textFromString(snap.content),
        savedContent: Text.empty,
        language: restoredLanguage(snap.language, snap.explicit, null),
        explicit: snap.explicit,
        lineEnding: snap.line_ending,
        savedLineEnding: snap.line_ending,
        hadBom: false,
        encoding: settingsState.defaultEncoding,
        lossy: false,
        tabIndex: snap.tab_index,
        order: orderOf(snap),
      };
    }
    // Known up front so every branch below (windowed/large restore, or an
    // ordinary decode) can stamp it on the tab it builds. A thrown check must
    // never block the open, so it degrades to false.
    const readOnlyFile =
      path === ''
        ? false
        : await invoke<boolean>('path_writable', { path })
            .then((writable) => !writable)
            .catch(() => false);
    // The trial has no large-file viewer or windowed editing: a record of
    // either restores as an ordinary tab of its file.
    const trial = isLite();
    // A restored windowed-editing tab knows it was unlocked (the persisted
    // checkpoint index, or the encoding of a file that is not UTF-8, is the
    // marker — see `NoteSnapshot.windowed_index`) but
    // has no live Rust session yet: it carries the data `beginWindowedRestore`
    // needs to reopen one lazily once this tab becomes active. Until then it
    // has neither `windowed` nor `large` set, so DocumentApp renders nothing
    // for it rather than flashing the read-only viewer for a fast-path restore
    // (see the class doc and `beginWindowedRestore`).
    if (
      snap !== null &&
      !trial &&
      (snap.windowed_index !== null || snap.windowed_encoding !== null) &&
      snap.large !== null
    ) {
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
        hadBom: snap.windowed_encoding !== null && snap.windowed_bom,
        encoding: snap.windowed_encoding ?? settingsState.defaultEncoding,
        lossy: false,
        tabIndex: snap.tab_index,
        order: orderOf(snap),
        windowedRestore: {
          index: snap.windowed_index,
          fingerprint: {
            size: snap.windowed_fp_size ?? snap.large,
            mtime_ms: snap.windowed_fp_mtime ?? 0,
          },
          digest: snap.windowed_digest ?? '0',
          topLine: snap.windowed_top_line ?? 0,
          size: snap.large,
          ...(snap.windowed_encoding === null
            ? {}
            : { encoding: snap.windowed_encoding, bom: snap.windowed_bom }),
        },
      };
    }
    // A restored large-file tab reopens straight in the read-only view: the user
    // already consented, so no re-stat and no confirm. Its size comes from the
    // snapshot; if the file has since vanished the tab still opens (matching an
    // ordinary tab, which survives a missing file) and the view surfaces reads.
    if (snap !== null && !trial && snap.large !== null) {
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
        order: orderOf(snap),
        large: { size: snap.large },
      };
    }
    // Size gate: a snapshot that lost its `large`/`windowed_index` markers (for
    // any reason) must still degrade to the read-only viewer rather than
    // decoding a huge file whole into the WebView — the same ceiling `openTab`
    // enforces before a fresh open ever reaches a full decode.
    // Lite has no viewer to degrade to, so it neither stats nor gates.
    if (path !== '' && !trial) {
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
          tabIndex: snap?.tab_index ?? this.allocIndex(),
          order: snap === null ? this.newOrder() : orderOf(snap),
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
        ? await readDocument(path, snap.encoding)
        : await readDocument(path);
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
      throw new ReadFailed(path, readError ?? '');
    }
    const diskRaw = decoded?.content ?? '';
    const diskContent = normalizeToLf(diskRaw);
    const diskEnding = detectLineEnding(diskRaw);
    const id = snap?.id ?? crypto.randomUUID();
    const tabIndex = snap?.tab_index ?? this.allocIndex();
    const order = snap === null ? this.newOrder() : orderOf(snap);
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
        order,
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
      order,
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
    let all: NoteSnapshot[];
    try {
      await editionState.ready();
      all = await invoke<NoteSnapshot[]>('list_notes');
    } catch (e) {
      // Let waiting opens through rather than hang them behind a failed init.
      this.settleIndex();
      throw e;
    }
    const entries = all
      .filter(
        (n) => n.kind === 'document' && (n.window_group ?? n.id) === group,
      )
      .sort(compareTabOrder);
    // Before the restore below, so a restore that throws midway still leaves
    // later tabs above every stored index.
    this.nextIndex = nextTabIndex(entries);
    this.settleIndex();
    if (entries.length > 0) {
      // Restore: adopt the project the group's tabs were saved with.
      this.project = entries[0]!.project;
      const trial = isLite();
      const dropped = new Set<number>();
      // Tabs whose stored record no longer describes them, written below.
      const rewrite: DocTab[] = [];
      for (const entry of entries) {
        // Normally gone at startup (see `drop_clean_range_records`); this
        // catches one the core could not delete. A failed delete only means
        // the next launch finds it again.
        if (isCleanOldRange(entry)) {
          await invoke('delete_note', { id: entry.id }).catch(() => {});
          dropped.add(entry.tab_index);
          continue;
        }
        try {
          const tab = await this.loadTab(entry.file_path ?? '', entry);
          this.tabs.push(tab);
          if (needsRewrite(entry, trial)) {
            rewrite.push(tab);
          }
        } catch (e) {
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
      const lowest = entries[0]!;
      this.bounds = {
        x: lowest.x,
        y: lowest.y,
        width: lowest.width,
        height: lowest.height,
      };
      await Promise.all(rewrite.map((tab) => this.upsertTab(tab)));
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
    this.onRestored?.();
  }
  /** Set by the window: ends an IME composition in the active editor and
   *  resolves once its text is in the tab. A switch waits for it. */
  endComposition: (() => Promise<void>) | null = null;
  /** Set by the window: whether the active windowed editor holds input that
   *  is not in the core yet (a composition, queued input, an apply in
   *  flight). Closing then waits for `endComposition`. */
  windowedPending: (() => boolean) | null = null;
  /** Set by the window: resolves once everything typed into the active
   *  windowed editor is in the core, leaving a composition open. A save waits
   *  for it, so it writes what was typed. */
  windowedFlushed: (() => Promise<void>) | null = null;
  /** Set by the window: whether a tab that is opening must stay behind the
   *  active one (a dialog or the edit box is up). */
  holdActive: (() => boolean) | null = null;
  /** The ticket of the newest switch of any kind: a switch that waited gives up
   *  when it is no longer the newest. */
  private _switchSeq = 0;
  get switchSeq(): number {
    return this._switchSeq;
  }
  /** How many user clicks on a tab there have been. */
  private _clickSeq = 0;
  get clickSeq(): number {
    return this._clickSeq;
  }
  private _pendingSwitches = 0;
  /** Switches that have not returned yet. */
  get pendingSwitches(): number {
    return this._pendingSwitches;
  }
  private _pendingClicks = 0;
  /** Switches for a user's click that have not returned yet. */
  get pendingClicks(): number {
    return this._pendingClicks;
  }
  private _writesPending = 0;
  /** Writes of tab records that are still out. */
  get writesPending(): number {
    return this._writesPending;
  }
  private _clicksInWait = 0;
  /** Clicks made while a write was out, until no write is. */
  get clicksInWait(): number {
    return this._clicksInWait;
  }
  private switchIdle: (() => void)[] = [];
  /** Switch tabs, flushing the outgoing tab's pending upsert first. The tabs
   *  are held by identity: a reorder or a close while waiting neither redirects
   *  the switch nor lets it land on another tab. The newest switch of any kind
   *  wins the screen. `click` marks a user's click on a tab; an `opening`
   *  switch does not take the screen while `holdActive` says so. */
  async switchTo(index: number, opening = false, click = false): Promise<void> {
    const tab = this.tabs[index];
    if (tab === undefined) {
      return;
    }
    if (opening && this.holdActive?.() === true) {
      return;
    }
    const ticket = ++this._switchSeq;
    this._pendingSwitches += 1;
    if (click) {
      this._clickSeq += 1;
      this._pendingClicks += 1;
      if (this._writesPending > 0) {
        this._clicksInWait += 1;
      }
    }
    try {
      if (tab === this.activeTab) {
        return;
      }
      await this.endComposition?.();
      if (this.switchGone(tab, ticket, opening)) {
        return;
      }
      this.persistActive.flush();
      await this.lastSave;
      if (this.switchGone(tab, ticket, opening)) {
        return;
      }
      this.activeIndex = this.tabs.indexOf(tab);
      this.consumeUnlock();
    } finally {
      this._pendingSwitches -= 1;
      if (click) {
        this._pendingClicks -= 1;
      }
      if (this._pendingSwitches === 0) {
        const waiting = this.switchIdle;
        this.switchIdle = [];
        for (const wake of waiting) {
          wake();
        }
      }
    }
  }
  /** Whether a switch that waited must give up: a newer switch took the screen,
   *  its tab is gone, or an opening switch is now held behind a dialog. */
  private switchGone(tab: DocTab, ticket: number, opening: boolean): boolean {
    return (
      ticket !== this._switchSeq ||
      !this.tabs.includes(tab) ||
      (opening && this.holdActive?.() === true)
    );
  }
  /** Resolves once the last write has settled and no switch is waiting, which
   *  includes the ones that started meanwhile. */
  async settled(): Promise<void> {
    for (;;) {
      await this.lastSave;
      if (this._pendingSwitches === 0) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.switchIdle.push(resolve);
      });
    }
  }
  /** Do what a tab was waiting to be shown for: unlock a large tab opened for
   *  editing, and merge the orphaned record of a file it already showed. */
  private consumeUnlock(): void {
    const tab = this.activeTab;
    if (tab === null) {
      return;
    }
    if (this.unlockWhenShown.delete(tab.id)) {
      void this.unlockLargeTab(tab, 0);
    }
    const note = this.adoptWhenShown.get(tab.id);
    if (note !== undefined) {
      this.adoptWhenShown.delete(tab.id);
      void this.adoptIntoExisting(tab, note);
    }
  }
  /** Run `op` once every earlier operation on `tab` has settled, so a tab does
   *  one thing at a time: a restore, an unlock or a view-mode copy. Starts at
   *  once when the tab is idle. A failed earlier operation does not block it. */
  private runTabOp<T>(tab: DocTab, op: () => Promise<T>): Promise<T> {
    if (this.onItsWay(tab)) {
      return Promise.reject(new Error('the tab is on its way'));
    }
    const prev = this.tabOps.get(tab.id);
    const run = prev === undefined ? op() : prev.then(op);
    const tail = run.then(
      () => {},
      () => {},
    );
    this.tabOps.set(tab.id, tail);
    void tail.then(() => {
      if (this.tabOps.get(tab.id) === tail) {
        this.tabOps.delete(tab.id);
      }
    });
    return run;
  }
  /** Kick off `beginWindowedRestore` for `tab` if it is a restored-but-not-yet-
   *  reopened windowed tab and no restore is already in flight for it (switching
   *  away and back must not scan or re-open anything). No-op otherwise. Fire-
   *  and-forget: the tab's own fields (`windowedRestore`/`windowed`/`large`)
   *  drive its render state as the restore progresses. */
  private ensureWindowedRestore(tab: DocTab | null): void {
    if (
      tab?.windowedRestore === undefined ||
      this.restoringWindowedIds.has(tab.id) ||
      this.onItsWay(tab)
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
  private beginWindowedRestore(tab: DocTab): Promise<void> {
    if (tab.windowedRestore === undefined) {
      return Promise.resolve();
    }
    this.restoringWindowedIds.add(tab.id);
    return this.runTabOp(tab, () => this.reopenWindowed(tab));
  }

  private async reopenWindowed(tab: DocTab): Promise<void> {
    const wr = tab.windowedRestore;
    if (wr === undefined) {
      this.restoringWindowedIds.delete(tab.id);
      return;
    }
    const graceTimer = window.setTimeout(() => {
      if (tab.windowedRestore !== undefined && tab.windowed === undefined) {
        tab.large = { size: wr.size };
      }
    }, WINDOWED_RESTORE_GRACE_MS);
    let reopened: WindowedReopened;
    try {
      if (wr.encoding === undefined) {
        reopened = await invoke<WindowedReopened>('windowed_reopen', {
          path: tab.path,
          index: wr.index,
          fingerprint: wr.fingerprint,
          digest: wr.digest,
        });
      } else {
        // The file is not UTF-8: it is decoded into a file of the core, which
        // the session is opened over.
        const bom = wr.bom ?? false;
        const convertId = await invoke<string>('convert_from_file', {
          path: tab.path,
          encoding: wr.encoding,
          withBom: bom,
        });
        const open = await invoke<WindowedOpen>('windowed_reopen_converted', {
          convertId,
          target: tab.path,
          encoding: wr.encoding,
          withBom: bom,
        });
        reopened = { ...open, rescanned: false };
      }
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
    if (wr.encoding === undefined) {
      this.lastWindowedRestoreRescanned = reopened.rescanned;
    }
    // The tab was closed while this restore was in flight: release the session
    // just opened rather than leaking it, and don't resurrect the deleted note
    // by upserting a tab no longer in this window.
    if (!this.tabs.includes(tab)) {
      void invoke('windowed_close', { sessionId: reopened.session_id });
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
    if (wr.encoding !== undefined) {
      tab.converted = {
        target: tab.path,
        encoding: wr.encoding,
        bom: wr.bom ?? false,
        origin: 'document',
        saved: true,
      };
    }
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
  /** Set by the window: what keeps a tab from being dragged. */
  dragHost: DragHost | null = null;
  /** Set by the window: what a tab on its way needs of it. */
  transferHost: TransferHost | null = null;
  /** The window has registered its transfer listeners: until then it neither
   *  sends nor takes a tab, since it could miss what the core tells it. */
  transferListening = false;
  /** Whether a drag may not start, or end in a reorder, now: a dialog or gate
   *  holds the window, it is closing or quitting, or a tab is on its way. */
  dragLocked(ownPreparing = false, exemptRole = false): boolean {
    const host = this.dragHost;
    if (
      host !== null &&
      (host.navigationLocked() ||
        host.gateVisible() ||
        host.modalOpen() ||
        host.closing() ||
        host.quitting())
    ) {
      return true;
    }
    return (
      (this.transferHost !== null && !this.transferListening) ||
      this.incoming.size > 0 ||
      this.committing !== null ||
      this.outgoing.size > 0 ||
      (!ownPreparing && this.preparing !== null) ||
      (this.tearOffRole && !exemptRole)
    );
  }
  /** The window is a tear-off still waiting for its role to end: from its load
   *  until the core sends it a send, a reveal or an end. Nothing is dragged to or
   *  from it meanwhile, and it takes no tab but the one made for it. */
  tearOffRole = false;
  /** The transfer the core routed to this window when it built it: the one
   *  incoming tab the role lets through. */
  tearOffFirst: number | null = null;
  /** `dragLocked` for the incoming transfer `t`: the tab the window was made for
   *  is not held off by the role. */
  lockedForIncoming(t: number): boolean {
    return this.dragLocked(false, t === this.tearOffFirst);
  }
  /** The role is over: the window is an ordinary one. */
  endTearOffRole(): void {
    this.tearOffRole = false;
    this.tearOffFirst = null;
  }
  /** Reveals the window (the page's `reveal_self`), set by the window. */
  revealSelf: (() => Promise<void>) | null = null;
  /** The tabs sent on by the core whose transfer, if it is called off, leaves the
   *  window to show itself with the tab. */
  private revealOnCancel = new Set<string>();
  /** The tab, if any, on its way out: set from the busy check until the core
   *  has answered `begin`. */
  preparing: Promise<void> | null = null;
  preparingTab: DocTab | null = null;
  /** The `tab_transfer_committed` call of a tab on its way in, while it runs. */
  committing: Promise<unknown> | null = null;
  /** Tabs on their way out, by transfer id: frozen, not yet let go. */
  private outgoing = new Map<number, DocTab>();
  /** What the core said of a transfer before `begin` had answered. */
  private earlyEvents = new Map<number, 'release' | 'cancel'>();
  /** Tabs on their way in, by transfer id: outside `tabs`, so not held by the
   *  editor, not reported, not counted, not written and never active. */
  incoming = new Map<number, IncomingCopy>();
  /** Transfers whose incoming copy was dropped: a flow that finds its id here
   *  stops. */
  private droppedIncoming = new Set<number>();
  /** What each tab's editor starts from when it is built, by tab id: set when a
   *  tab arrives, taken by the editor, deleted with a tab that goes first. */
  pendingSeeds = new Map<string, Seed>();
  /** Whether the window has no tab and none on its way in. */
  get isEmpty(): boolean {
    return this.tabs.length === 0 && this.incoming.size === 0;
  }
  /** The editor built the state of tab `id` from a seed: its document is the
   *  tab's text from now on. When the tab was clean it shares that one rope with
   *  its saved baseline again, as every clean tab does. */
  seededDoc(id: string, doc: Text): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (tab === undefined || this.onItsWay(tab) || !textEq(tab.content, doc)) {
      return;
    }
    const clean = textEq(tab.content, tab.savedContent);
    tab.content = doc;
    if (clean) {
      tab.savedContent = doc;
    }
  }
  /** The editor takes the seed of tab `id`: it starts from it, once. */
  takeSeed(id: string): Seed | undefined {
    const seed = this.pendingSeeds.get(id);
    this.pendingSeeds.delete(id);
    return seed;
  }
  /** Move `tab` to index `to` of the window's tabs. The active tab stays the
   *  active one (`ordinaryMru` and the restore kick are left alone) and only the
   *  moved tab is written, unless its neighbours leave no key between them and
   *  every tab takes its position as key. Nothing changes under a drag lock,
   *  for a tab that is gone, or when `to` is where the tab is. */
  moveTab(tab: DocTab, to: number): Promise<void> {
    const from = this.tabs.indexOf(tab);
    if (
      this.dragLocked() ||
      from === -1 ||
      to === from ||
      to < 0 ||
      to >= this.tabs.length
    ) {
      return Promise.resolve();
    }
    const others = this.tabs.slice();
    others.splice(from, 1);
    const key = keyBetween(
      others[to - 1]?.order ?? null,
      others[to]?.order ?? null,
    );
    const active = this.activeTab;
    this.tabs.splice(from, 1);
    this.tabs.splice(to, 0, tab);
    // Written directly: the setter would touch the MRU and the restore.
    this.#activeIndexState = active === null ? 0 : this.tabs.indexOf(active);
    if (key !== null) {
      this.tabs[to]!.order = key;
      return this.upsertTab(tab);
    }
    this.tabs.forEach((t, i) => {
      t.order = i;
    });
    return Promise.all(this.tabs.map((t) => this.upsertTab(t))).then(() => {});
  }
  /** The window's bounds, which a tab put here is stored with. */
  get windowBounds(): TransferBounds {
    return { ...this.bounds };
  }
  /** Take `tab` out of `tabs` at `at`. The active tab stays the active one when
   *  it is another; when it is `tab` the next one takes over by `deleteTab`'s
   *  rule, through the setter. */
  private spliceOut(tab: DocTab, at: number): void {
    const active = this.activeTab;
    this.tabs.splice(at, 1);
    if (active !== tab) {
      // Written directly: the setter would touch the MRU and the restore.
      this.#activeIndexState = active === null ? 0 : this.tabs.indexOf(active);
      return;
    }
    let next = this.activeIndex;
    if (next >= this.tabs.length) {
      next = Math.max(0, this.tabs.length - 1);
    }
    this.activeIndex = next;
  }
  /** Put `tab` where its `order` says. The active tab stays the active one
   *  (`ordinaryMru` and the restore kick are left alone); a window that had none
   *  makes `tab` its active tab through the setter. */
  private insertByOrder(tab: DocTab, renumber: boolean): void {
    const active = this.activeTab;
    const first = renumber
      ? Math.min(Math.max(0, tab.order), this.tabs.length)
      : this.tabs.findIndex((other) => other.order > tab.order);
    const at = first === -1 ? this.tabs.length : first;
    this.tabs.splice(at, 0, tab);
    if (active === null) {
      this.activeIndex = at;
      return;
    }
    // Written directly: the setter would touch the MRU and the restore.
    this.#activeIndexState = this.tabs.indexOf(active);
  }
  // ---- A tab on its way to another window: the sender.
  /** What the window knows of `tab` besides its own fields. */
  private blockFacts(tab: DocTab, ownPreparing: boolean): BlockFacts {
    const sessionId = tab.windowed?.sessionId;
    return {
      op: this.tabOps.has(tab.id),
      convert: convertController.busy(tab.id),
      rangeBox: this.rangeBox?.tabId === tab.id,
      windowedOp:
        sessionId !== undefined &&
        (this.windowedGates.get(sessionId)?.pending() ?? false),
      paste: pasteLocks.has(tab.id),
      locked: this.dragLocked(ownPreparing),
    };
  }
  /** Why `tab` cannot be moved to another window now, or null. */
  transferBlockerOf(tab: DocTab, ownPreparing = false): TransferBlock | null {
    return transferBlocker(tab, this.blockFacts(tab, ownPreparing));
  }
  /** A dragged tab was released. Where it goes is for the core to say: the own
   *  window reorders it or returns it to its slot, another window takes it, and
   *  anywhere else it opens a window of its own, or moves the window when it was
   *  the only tab. */
  async releaseTab(tab: DocTab, release: ReleaseAt): Promise<void> {
    let target: DropTarget;
    try {
      target = await invoke<DropTarget>('tab_drop_target', {
        clientX: release.x,
        clientY: release.y,
        dpr: release.dpr,
        onlyTab: this.tabs.length === 1,
      });
    } catch (error) {
      console.error('tab_drop_target failed', error);
      target = { kind: DROP.self };
    }
    switch (target.kind) {
      case DROP.self:
        if (release.overBar) {
          await this.moveTab(tab, release.slot);
        }
        return;
      case DROP.cancel:
        return;
      case DROP.moveWindow:
        // The tab stays in its own window, busy or not.
        await invoke('tab_move_window', { point: target.point }).catch(
          (error: unknown) => {
            console.error('tab_move_window failed', error);
          },
        );
        return;
      default:
        await this.transferOut(tab, target);
    }
  }
  /** A tab that left its bar becomes a window of its own that follows the
   *  pointer. `cancelled` says Esc came before the core was asked: the tab
   *  stays. */
  detachTab(
    tab: DocTab,
    start: TearOffTarget,
    cancelled: () => boolean,
  ): Promise<StartResult> {
    return this.transferOut(tab, start, cancelled);
  }
  private transferOut(
    tab: DocTab,
    target: TransferTarget,
    cancelled: () => boolean = () => false,
  ): Promise<StartResult> {
    if (this.transferHost === null || this.transferBlockerOf(tab) !== null) {
      return Promise.resolve('notStarted');
    }
    const run = this.carryOut(tab, target, cancelled);
    const preparing = run.then(() => {});
    this.preparing = preparing;
    this.preparingTab = tab;
    return run.finally(() => {
      if (this.preparing === preparing) {
        this.preparing = null;
        this.preparingTab = null;
      }
    });
  }
  /** Flush and write `tab`, freeze it, pack it and begin the transfer. Any
   *  failure before the core has started it leaves the tab as it was. */
  private async carryOut(
    tab: DocTab,
    target: TransferTarget,
    cancelled: () => boolean,
  ): Promise<StartResult> {
    const host = this.transferHost;
    if (host === null) {
      return 'notStarted';
    }
    if (tab === this.activeTab) {
      await this.endComposition?.();
      if (tab.windowed !== undefined) {
        await this.windowedFlushed?.();
      }
    }
    if (
      !this.tabs.includes(tab) ||
      this.transferBlockerOf(tab, true) !== null ||
      cancelled()
    ) {
      return 'notStarted';
    }
    if (tab === this.activeTab) {
      this.persistActive.flush();
    }
    await this.upsertTab(tab);
    await this.settleWrites(tab);
    if (
      !this.tabs.includes(tab) ||
      this.transferBlockerOf(tab, true) !== null ||
      cancelled()
    ) {
      return 'notStarted';
    }
    // The stored record would be stale: the tab stays here.
    if (tab.writeFailed === true) {
      this.unfreeze(tab);
      return 'notStarted';
    }
    this.freeze(tab);
    const payload = toPayload(tab, {
      editor: editorPayload(host.editorStateOf(tab.id), tab.content),
      scroll: host.scrollOf(tab.id),
      view: this.viewPos.get(tab.id) ?? null,
      viewMode: host.viewModeOf(tab.id) ?? null,
    });
    // Esc since the check above: the core is not asked.
    if (cancelled()) {
      this.cancelled(tab);
      return 'notStarted';
    }
    let result: BeginResult;
    try {
      result = await invoke<BeginResult>('tab_transfer_begin', {
        payload,
        target,
        project: this.project,
      });
    } catch (error) {
      console.error('tab_transfer_begin failed', error);
      this.cancelled(tab);
      return 'notStarted';
    }
    if (result.kind !== BEGIN.started) {
      this.cancelled(tab);
      return 'notStarted';
    }
    this.outgoing.set(result.t, tab);
    // The core may have been quicker than its own answer.
    const early = this.earlyEvents.get(result.t);
    this.earlyEvents.delete(result.t);
    if (early === 'release') {
      this.applyRelease(result.t);
    } else if (early === 'cancel') {
      this.onTransferCancel(result.t);
    }
    return 'started';
  }
  /** Wait until every write of `tab` has settled. */
  private async settleWrites(tab: DocTab): Promise<void> {
    for (;;) {
      const writes = this.pendingWrites.get(tab.id);
      if (writes === undefined || writes.size === 0) {
        return;
      }
      await Promise.all([...writes]);
    }
  }
  /** Freeze `tab`: nothing is typed, edited or written until it lands or comes
   *  back. */
  private freeze(tab: DocTab): void {
    tab.transferring = true;
    this.transferHost?.showLock(tab.id, pasteLocks.begin(tab.id, 'full'));
  }
  /** Give `tab` back to its window. The one way a freeze ends other than a
   *  release. */
  private unfreeze(tab: DocTab): void {
    pasteLocks.drop(tab.id);
    this.transferHost?.showLock(tab.id, undefined);
    delete tab.transferring;
  }
  /** The transfer was called off or never started: the tab is the window's
   *  again and its record is written from here. */
  private cancelled(tab: DocTab): void {
    this.unfreeze(tab);
    void this.upsertTab(tab);
  }
  /** `tab-transfer-release`, a settle's `release` and a close of a tab that had
   *  already landed: the tab is in another window, so it leaves this one without
   *  its record, its session or its conversion being touched. Once per transfer. */
  applyRelease(t: number): void {
    const tab = this.outgoing.get(t);
    if (tab === undefined) {
      return;
    }
    this.outgoing.delete(t);
    this.revealOnCancel.delete(tab.id);
    tab.released = true;
    this.ordinaryMru = this.ordinaryMru.filter((id) => id !== tab.id);
    const at = this.tabs.indexOf(tab);
    if (at !== -1) {
      this.spliceOut(tab, at);
    }
    // The editor prunes its states and scrolls for tabs that are gone; a lock,
    // a view mode and a seed of a tab it never held are not its to know of. A
    // mounted view cancels its own search when it goes.
    pasteLocks.drop(tab.id);
    this.transferHost?.forgetTab(tab.id);
    this.pendingSeeds.delete(tab.id);
    this.releaseTabView(tab.id);
    if (tab.windowed !== undefined) {
      this.windowedGates.delete(tab.windowed.sessionId);
      this.windowedGenerations.delete(tab.windowed.sessionId);
    }
    void invoke('tab_transfer_released', { t });
    if (this.isEmpty) {
      void this.transferHost?.closeWindow();
    }
  }
  /** `tab-transfer-release`. */
  onTransferRelease(t: number): void {
    if (this.outgoing.has(t)) {
      this.applyRelease(t);
    } else {
      this.earlyEvents.set(t, 'release');
    }
  }
  /** `tab-transfer-cancel`. */
  onTransferCancel(t: number): void {
    const tab = this.outgoing.get(t);
    if (tab === undefined) {
      this.earlyEvents.set(t, 'cancel');
      return;
    }
    this.outgoing.delete(t);
    this.cancelled(tab);
    if (this.revealOnCancel.delete(tab.id)) {
      void this.revealWith(tab);
    }
  }
  /** `tab-transfer-send`: the core says the tab `note`, which is the only one of
   *  this tear-off, goes on to the bar it names. The role ends first. The tab is
   *  sent once what is still putting it in, and what is still running on it, is
   *  done, for at most `SEND_WAIT_MS`; a dialog, the wait running out, the core
   *  not starting the transfer or calling it off later leaves the window to show
   *  itself with the tab. A window that is closing or quitting sends nothing and
   *  shows nothing: the tab goes the way of the window. */
  async onTransferSend(payload: SendPayload): Promise<void> {
    this.endTearOffRole();
    if (this.goingAway()) {
      return;
    }
    const deadline = Date.now() + SEND_WAIT_MS;
    while (this.sendMustWait(payload.note) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, SEND_WAIT_STEP_MS));
      if (this.goingAway()) {
        return;
      }
    }
    const tab = this.tabs.find((t) => t.id === payload.note);
    if (tab === undefined) {
      return;
    }
    if (this.transferBlockerOf(tab) !== null) {
      await this.revealWith(tab);
      return;
    }
    this.revealOnCancel.add(tab.id);
    const started = await this.transferOut(tab, payload.target);
    if (started !== 'started') {
      this.revealOnCancel.delete(tab.id);
      await this.revealWith(tab);
    }
  }
  /** Whether the window is closing or a quit has it. */
  private goingAway(): boolean {
    const host = this.dragHost;
    return host !== null && (host.closing() || host.quitting());
  }
  /** Whether a send still has to wait: the tab is not in yet, or something that
   *  ends by itself is running on it. */
  private sendMustWait(note: string): boolean {
    if (this.committing !== null || this.incoming.size > 0) {
      return true;
    }
    const tab = this.tabs.find((t) => t.id === note);
    if (tab === undefined) {
      return true;
    }
    const blocker = this.transferBlockerOf(tab);
    return (
      blocker === 'op' ||
      blocker === 'in-flight' ||
      blocker === 'windowed-op' ||
      blocker === 'paste'
    );
  }
  /** Show the window with `tab` the active one. A window a follow made invisible,
   *  the only tab of a moving window whose send failed or was refused, is shown
   *  again first. */
  private async revealWith(tab: DocTab): Promise<void> {
    if (this.goingAway()) {
      return;
    }
    invoke('tab_window_restore').catch((error: unknown) => {
      console.error('tab_window_restore failed', error);
    });
    const at = this.tabs.indexOf(tab);
    if (at !== -1 && this.activeTab !== tab) {
      await this.switchTo(at);
    }
    await this.revealSelf?.();
  }
  /** Call off the move of `tab`, or let it go when it has landed already: a
   *  close of the dimmed tab. Waits for a move that is still being set up. */
  async settleTab(tab: DocTab): Promise<void> {
    await this.preparing?.catch(() => {});
    const entry = [...this.outgoing].find(([, held]) => held === tab);
    if (entry === undefined) {
      return;
    }
    const t = entry[0];
    let result: CancelResult;
    try {
      result = await invoke<CancelResult>('tab_transfer_cancel', { t });
    } catch (error) {
      console.error('tab_transfer_cancel failed', error);
      return;
    }
    if (result === 'accepted') {
      this.applyRelease(t);
    } else if (this.outgoing.delete(t)) {
      this.cancelled(tab);
    }
  }
  /** Settle every transfer of this window before it closes or quits: wait for
   *  what is being set up or put in, then let the core call off what is not
   *  accepted and do what it says about each. */
  async settleTransfers(): Promise<void> {
    await this.preparing?.catch(() => {});
    await this.committing?.catch(() => {});
    let actions: SettleAction[];
    try {
      actions = await invoke<SettleAction[]>('tab_transfer_settle_window');
    } catch (error) {
      console.error('tab_transfer_settle_window failed', error);
      return;
    }
    for (const action of actions) {
      if (action.kind === SETTLE.unfreeze) {
        const tab =
          this.outgoing.get(action.t) ??
          this.tabs.find((t) => t.id === action.noteId);
        this.outgoing.delete(action.t);
        if (tab !== undefined) {
          this.cancelled(tab);
        }
      } else if (action.kind === SETTLE.dropIncoming) {
        this.dropIncoming(action.t);
      } else {
        this.applyRelease(action.t);
      }
    }
  }
  // ---- A tab on its way to this window: the receiver.
  /** Wait for what the active tab is doing, as a switch away from it does. */
  async settleForInsert(): Promise<void> {
    await this.endComposition?.();
    this.persistActive.flush();
    await this.lastSave;
  }
  /** The order key for a tab that goes to slot `slot` of the tabs, or last. */
  private planOrder(slot: number | null): { order: number; renumber: boolean } {
    if (slot === null || slot >= this.tabs.length) {
      return { order: this.newOrder(), renumber: false };
    }
    const key = keyBetween(
      this.tabs[slot - 1]?.order ?? null,
      this.tabs[slot]?.order ?? null,
    );
    return key === null
      ? { order: slot, renumber: true }
      : { order: key, renumber: false };
  }
  /** Keep the claimed tab as an incoming copy: it gets its index and its place
   *  (where `client`, the drop point in this window's viewport, falls on the tab
   *  bar, else last) but is not one of the window's tabs yet. */
  holdIncoming(
    t: number,
    payload: TabPayload,
    client: Point | null,
  ): IncomingCopy {
    const geometry = this.transferHost?.dropGeometry() ?? null;
    const slot =
      client === null || geometry === null ? null : dropSlot(client, geometry);
    const plan = this.planOrder(slot);
    const tab: DocTab = {
      ...fromPayload(payload),
      tabIndex: this.allocIndex(),
      order: plan.order,
    };
    const copy: IncomingCopy = { t, tab, payload, renumber: plan.renumber };
    this.incoming.set(t, copy);
    return copy;
  }
  /** What the receiver reports of a copy it holds. */
  committedMetaOf(copy: IncomingCopy): CommittedMeta {
    return committedMeta(
      copy.tab.tabIndex,
      copy.tab.order,
      this.group,
      this.project,
      this.windowBounds,
    );
  }
  /** The transfer of `t` is over for this window as a receiver: its copy, if it
   *  held one, is dropped. A window left with nothing closes. */
  dropIncoming(t: number): void {
    this.droppedIncoming.add(t);
    const had = this.incoming.delete(t);
    if (had && this.isEmpty) {
      void this.transferHost?.closeWindow();
    }
  }
  /** Whether the copy of transfer `t` was dropped. */
  wasDropped(t: number): boolean {
    return this.droppedIncoming.has(t);
  }
  /** Put a dropped copy back: the core had accepted it after all. */
  restoreIncoming(copy: IncomingCopy): void {
    this.droppedIncoming.delete(copy.t);
    this.incoming.set(copy.t, copy);
  }
  /** The core accepted the transfer `t`: the copy is a tab of this window. In
   *  one step: the editor's seed is stored, the tab's view is applied, the copy
   *  leaves `incoming` and the tab is inserted at its place, and made the active
   *  tab (`activate`: unless a dialog is up). Its record is written from here. */
  acceptIncoming(t: number, activate: boolean): DocTab | null {
    const copy = this.incoming.get(t);
    if (copy === undefined) {
      return null;
    }
    const { tab, payload } = copy;
    if (payload.editor !== null || payload.scroll !== null) {
      this.pendingSeeds.set(tab.id, {
        editor: payload.editor,
        scroll: payload.scroll,
      });
    }
    if (payload.view !== null) {
      this.viewPos.set(tab.id, { ...payload.view });
    }
    if (payload.viewMode !== null) {
      this.transferHost?.setViewMode(tab.id, payload.viewMode);
    }
    this.incoming.delete(t);
    const empty = this.activeTab === null;
    this.insertByOrder(tab, copy.renumber);
    // The $state array stores a proxy of `tab`: identity checks need the stored one.
    const stored = this.tabs.find((t) => t.id === tab.id) ?? tab;
    if (activate && !empty) {
      void this.switchTo(this.tabs.indexOf(stored));
    }
    if (copy.renumber) {
      this.tabs.forEach((other, i) => {
        other.order = i;
      });
      void Promise.all(this.tabs.map((other) => this.upsertTab(other)));
    } else {
      void this.upsertTab(stored);
    }
    return stored;
  }
  cycle(delta: number): void {
    const count = this.tabs.length;
    if (count < 2) {
      return;
    }
    void this.switchTo((this.activeIndex + delta + count) % count, false, true);
  }
  /** The next free tab index: above both the counter and every open tab, so an
   *  index is never handed out twice even if the counter fell behind. */
  private allocIndex(): number {
    const held = [
      ...this.tabs,
      ...[...this.incoming.values()].map((c) => c.tab),
    ];
    const index = held.reduce(
      (max, t) => Math.max(max, t.tabIndex + 1),
      this.nextIndex,
    );
    this.nextIndex = index + 1;
    return index;
  }
  /** The order key of a tab added after every tab of the window. */
  private newOrder(): number {
    const held = [
      ...this.tabs,
      ...[...this.incoming.values()].map((c) => c.tab),
    ];
    return newKey(held.map((t) => t.order));
  }
  /** Open a fresh untitled tab (no path, empty buffer) and switch to it. */
  async newTab(): Promise<void> {
    await this.indexSettled;
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
      tabIndex: this.allocIndex(),
      order: this.newOrder(),
    };
    this.tabs.push(tab);
    await this.switchTo(this.tabs.length - 1, true);
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
    await this.indexSettled;
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
      path === '' ? undefined : this.tabs.find((t) => t.path === path);
    if (existing !== undefined) {
      // A tab on its way is neither switched to nor merged into.
      if (this.onItsWay(existing)) {
        return;
      }
      await this.switchTo(this.tabs.indexOf(existing), true);
      // A dirty orphan of a file this window already shows clean: pull its
      // unsaved edits in (snapshot wins over disk) and retire the orphan record.
      // A dirty local tab is left untouched — two-sided edits are not merged.
      // The tab takes them once it is shown: only the active tab's editor
      // refreshes, and the record stays until then.
      if (route.kind === 'adopt' && route.note.dirty) {
        if (this.activeTab === existing) {
          await this.adoptIntoExisting(existing, route.note);
        } else {
          this.adoptWhenShown.set(existing.id, route.note);
        }
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
    if (!isLite()) {
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
    await this.switchTo(this.tabs.length - 1, true);
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
    // The tab was staged while others may have opened; it goes last.
    tab.order = this.newOrder();
    this.tabs.push(tab);
    void (async (): Promise<void> => {
      await this.switchTo(this.tabs.length - 1, true);
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
      ...new Set(orphanCandidates(all, path, this.group).map(documentGroup)),
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
    return routeOpen(all, path, this.group, new Set(live));
  }
  /** Re-home an orphaned stored tab (its window group is gone) into this window:
   *  rebuild it via loadTab so a dirty snapshot restores its unsaved edits over
   *  disk, keep its note id, but give it a fresh tab index in this window. The
   *  upsert re-tags the note with this window's group and project, so the
   *  orphan's old group keeps only its remaining tabs (restored as usual next
   *  launch). */
  private async adoptOrphan(path: string, note: NoteSnapshot): Promise<void> {
    // An old range record with nothing unsaved has nothing to restore.
    if (isCleanOldRange(note)) {
      await invoke('delete_note', { id: note.id }).catch(() => {});
      return;
    }
    let tab: DocTab;
    try {
      tab = await this.loadTab(path, note);
    } catch (e) {
      if (!(e instanceof UnreadableRestore)) {
        throw e;
      }
      // Reported like any other failed open; the stale record would only fail
      // the same way next time.
      await invoke('delete_note', { id: note.id }).catch(() => {});
      this.openFailed = path;
      return;
    }
    tab.tabIndex = this.allocIndex();
    tab.order = this.newOrder();
    this.tabs.push(tab);
    await this.switchTo(this.tabs.length - 1, true);
    await this.upsertTab(tab);
  }
  /** Bring a dirty orphan's unsaved edits into an existing clean tab for the same
   *  file (snapshot wins over disk), then delete the orphan record so it stops
   *  haunting the store. No-op when the local tab is itself dirty — a genuine
   *  two-sided edit is left for the user and the orphan is preserved. */
  private async adoptIntoExisting(
    tab: DocTab,
    note: NoteSnapshot,
  ): Promise<void> {
    if (!this.tabs.includes(tab) || this.onItsWay(tab) || this.isDirty(tab)) {
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
      tabIndex: this.allocIndex(),
      order: this.newOrder(),
      large: { size: pending.size },
    };
    this.tabs.push(tab);
    const index = this.tabs.length - 1;
    // The $state array stores a proxy of `tab`: identity checks need the stored one.
    const shown = this.tabs[index]!;
    void (async (): Promise<void> => {
      await this.switchTo(index, true);
      try {
        shown.readOnlyFile = !(await invoke<boolean>('path_writable', {
          path: shown.path,
        }));
      } catch {
        shown.readOnlyFile = false;
      }
      await this.upsertTab(shown);
      // Edit choice: unlock straight into in-place editing right after the tab
      // opens, so an editable large file lands the user directly in edit mode. A
      // non-UTF-8 or oversized file silently stays in the read-only view (the tab
      // lock explains why). ponytail: reuses the in-place unlock path, no second
      // open route.
      if (
        edit &&
        shown.large !== undefined &&
        shown.large.size < LARGE_EDIT_MAX
      ) {
        // Only the active tab can be unlocked; a tab held back unlocks once shown.
        if (this.activeTab === shown) {
          await this.unlockLargeTab(shown, 0);
        } else {
          this.unlockWhenShown.add(shown.id);
        }
      }
    })();
  }
  /** Unlock the read-only large-file tab `tab` into an editable one, in place:
   *  attach a Rust windowed session and swap the tab's `large` field for a
   *  `windowed` field (same tab id, so the view swaps from LargeFileView to
   *  WindowedEditor without a new tab). `topLine` is the 0-based line the user was
   *  viewing, so editing continues from there. Returns null on success, or a short
   *  reason when the file cannot be edited (non-UTF-8); the tab stays read-only. */
  async unlockLargeTab(tab: DocTab, topLine: number): Promise<string | null> {
    if (tab.large === undefined || this.onItsWay(tab)) {
      return null;
    }
    // Lite has no editing session to start. Nothing is asked of the core, and
    // nothing is recorded on the tab: its lock must be as it was when the
    // edition is full again.
    if (isLite()) {
      return null;
    }
    return this.runTabOp(tab, () => this.unlockTabNow(tab, topLine));
  }

  private async unlockTabNow(
    tab: DocTab,
    topLine: number,
  ): Promise<string | null> {
    // An earlier operation (a restore) may already have left the viewer, or
    // the tab was closed while queued; nothing would close a session opened now.
    if (tab.large === undefined || !this.tabs.includes(tab)) {
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
    // Closed during the open: drop the session rather than bring the tab back.
    if (!this.tabs.includes(tab)) {
      void invoke('windowed_close', { sessionId: open.session_id });
      return null;
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
  /** What a conversion to the large-file mode needs of this window. */
  convertHost(): DocConvertHost {
    return {
      tab: (id) => {
        const tab = this.tabs.find((t) => t.id === id);
        return tab === undefined
          ? null
          : {
              path: tab.path,
              encoding: tab.encoding,
              hadBom: tab.hadBom,
              lineEnding: tab.lineEnding,
              language: tab.language,
            };
      },
      install: (id, convertId) => this.installConverted(id, convertId),
      showViewer: (id, path, size) => this.showConvertedViewer(id, path, size),
    };
  }
  /** Makes the ordinary tab `tabId` a large-file editing tab over the finished
   *  conversion `convertId`, in place (same tab id, as `unlockTabNow` does). The
   *  tab is unsaved: its record stays as it was, so a restart restores the
   *  document as it was before the paste. Rejects with the reason, and the tab is
   *  then untouched. */
  async installConverted(tabId: string, convertId: string): Promise<void> {
    devTrace(`installConverted enter tab=${tabId}`);
    try {
      const tab = this.tabs.find((t) => t.id === tabId);
      if (tab === undefined) {
        throw new Error('the tab is gone');
      }
      return await this.runTabOp(tab, () =>
        this.installConvertedNow(tab, convertId),
      );
    } finally {
      devTrace(`installConverted end tab=${tabId}`);
    }
  }
  private async installConvertedNow(
    tab: DocTab,
    convertId: string,
  ): Promise<void> {
    if (!this.tabs.includes(tab) || !isOrdinaryTab(tab)) {
      throw new Error('the tab is gone');
    }
    // What was typed before the paste is in the record, whole, before the tab
    // stops writing one.
    if (tab === this.activeTab) {
      this.persistActive.flush();
    }
    await this.lastSave;
    const target = tab.path === '' ? null : tab.path;
    const open = await invoke<WindowedOpen>('windowed_open_converted', {
      convertId,
      target,
      encoding: tab.encoding,
      withBom: tab.hadBom,
      dirty: true,
    });
    // Closed during the open: drop the session rather than bring the tab back.
    if (!this.tabs.includes(tab)) {
      void invoke('windowed_close', { sessionId: open.session_id });
      throw new Error('the tab is gone');
    }
    this.releaseTabView(tab.id);
    tab.content = Text.empty;
    tab.savedContent = Text.empty;
    tab.savedLineEnding = tab.lineEnding;
    tab.insertLineEnding = tab.lineEnding === 'CRLF' ? '\r\n' : '\n';
    tab.windowed = {
      sessionId: open.session_id,
      totalBytes: open.total_bytes,
      totalLines: open.total_lines,
      fingerprint: open.fingerprint,
      dirty: true,
      topLine: 0,
    };
    tab.converted = {
      target,
      encoding: tab.encoding,
      bom: tab.hadBom,
      origin: target === null ? 'untitled' : 'document',
      saved: false,
    };
  }
  /** A handoff this window claimed (`convert_claim`) opened as a tab; see
   *  `openConverted`. */
  openClaimed(claimed: ClaimedHandoff): Promise<string | null> {
    return this.openConverted(
      claimed.convert_id,
      claimed.note_id,
      claimed.language,
      claimed.encoding,
      claimed.line_ending,
    );
  }
  /** A sticky note handed over as a tab: opens a new tab over the conversion
   *  `convertId` the handoff gave, with the note's `language` and the `encoding`
   *  and `lineEnding` the conversion was written with. Returns the id of the
   *  tab, or null when it could not be opened (the core has the conversion file
   *  deleted then). */
  async openConverted(
    convertId: string,
    noteId: string,
    language: string | null,
    encoding: string,
    lineEnding: LineEnding,
  ): Promise<string | null> {
    await this.indexSettled;
    let open: WindowedOpen;
    try {
      open = await invoke<WindowedOpen>('windowed_open_converted', {
        convertId,
        target: null,
        encoding,
        withBom: false,
        dirty: true,
      });
    } catch {
      return null;
    }
    const tab: DocTab = {
      id: crypto.randomUUID(),
      path: '',
      readOnlyFile: false,
      content: Text.empty,
      savedContent: Text.empty,
      language,
      explicit: false,
      lineEnding,
      savedLineEnding: lineEnding,
      insertLineEnding: lineEnding === 'CRLF' ? '\r\n' : '\n',
      hadBom: false,
      encoding,
      lossy: false,
      tabIndex: this.allocIndex(),
      order: this.newOrder(),
      handingOver: true,
      windowed: {
        sessionId: open.session_id,
        totalBytes: open.total_bytes,
        totalLines: open.total_lines,
        fingerprint: open.fingerprint,
        dirty: true,
        topLine: 0,
      },
      converted: {
        target: null,
        encoding,
        bom: false,
        origin: 'sticky',
        noteId,
        saved: false,
      },
    };
    this.tabs.push(tab);
    await this.switchTo(this.tabs.length - 1, true);
    return tab.id;
  }
  /** The handoff of the tab `tabId` is over, however it ended: it may be moved. */
  endHandingOver(tabId: string): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (tab !== undefined) {
      delete tab.handingOver;
    }
  }
  /** A paste that was too big to edit was saved to `path`: the tab shows that
   *  file in the read-only view. */
  async showConvertedViewer(
    tabId: string,
    path: string,
    size: number,
  ): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (tab === undefined) {
      return;
    }
    tab.path = path;
    tab.missing = false;
    if (!tab.explicit) {
      tab.language = detectByFilename(path);
    }
    tab.content = Text.empty;
    tab.savedContent = Text.empty;
    tab.savedLineEnding = tab.lineEnding;
    tab.large = { size };
    try {
      tab.readOnlyFile = !(await invoke<boolean>('path_writable', { path }));
    } catch {
      tab.readOnlyFile = false;
    }
    await this.upsertTab(tab);
    void invoke('add_recent_file', { path });
  }
  /** Confirm choice: cancel the pending open (as if it never happened). */
  cancelLargeOpen(): void {
    this.pendingLargeOpen = null;
  }

  updateActiveContent(content: Text): void {
    const tab = this.activeTab;
    if (tab === null || this.onItsWay(tab)) {
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
    if (tab === undefined || this.onItsWay(tab)) {
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
    if (tab === null || this.onItsWay(tab)) {
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
    if (
      tab === null ||
      this.onItsWay(tab) ||
      isLargeKind(tab) ||
      tab.lineEnding === ending
    ) {
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
   *  Returns false when the dialog was cancelled (no side effects), and for a
   *  large-file viewer, which has nothing to write. */
  async saveActive(pathOverride?: string): Promise<boolean> {
    const tab = this.activeTab;
    return tab === null ? false : this.saveTab(tab, pathOverride);
  }
  /** `saveActive` for `tab`: a dialog that asked about a tab acts on that tab,
   *  whichever is active by the time it is answered. */
  async saveTab(tab: DocTab, pathOverride?: string): Promise<boolean> {
    if (this.onItsWay(tab)) {
      return false;
    }
    // The file is gone: a write to the old path would quietly make a new file
    // there, so the user picks where it goes instead.
    if (tab.missing === true) {
      return this.saveAsTab(tab, pathOverride);
    }
    // A windowed tab saves its Rust-side buffer through windowed_save; only a
    // clean write counts as saved (a conflict raises the modal).
    if (tab.windowed !== undefined) {
      // A tab a paste made has no file yet when it came from an untitled
      // document or a note: a save there asks where it goes.
      if (tab.converted !== undefined && tab.converted.target === null) {
        return this.saveAsTab(tab, pathOverride);
      }
      return (await this.saveWindowed(tab, false)) === 'ok';
    }
    // A viewer, or a tab still restoring its session, has no changes to write;
    // the generic path below would overwrite the file with its empty buffer.
    if (isLargeKind(tab)) {
      return false;
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
    // The baseline below is what was written, not what the tab holds by then:
    // typing during the write must stay unsaved.
    const written = tab.content;
    const writtenEnding = tab.lineEnding;
    // Flush point: materialize the rope to a string for the write.
    const out = applyLineEnding(written.toString(), writtenEnding);
    try {
      await this.busy(tab, () =>
        writeDocument({
          path: tab.path,
          content: out,
          encoding: tab.encoding,
          withBom: tab.hadBom,
        }),
      );
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
    tab.savedContent = written;
    tab.savedLineEnding = writtenEnding;
    await this.upsertTab(tab);
    return true;
  }
  /** File > Save As: always prompt for a new path and write the active tab's
   *  buffer there, turning the tab into an ordinary saved document at that path.
   *  A windowed tab is written by its Rust session and retargeted to the new path.
   *  A viewer tab's file is copied, after any restore or unlock in flight ends.
   *  `pathOverride` skips the dialog (automation/E2E). Returns false on cancel. */
  async saveAs(pathOverride?: string): Promise<boolean> {
    const tab = this.activeTab;
    return tab === null ? false : this.saveAsTab(tab, pathOverride);
  }
  /** `saveAs` for `tab`. */
  async saveAsTab(tab: DocTab, pathOverride?: string): Promise<boolean> {
    if (this.onItsWay(tab)) {
      return false;
    }
    const chosen =
      pathOverride ??
      (await save(saveDialogOptions(tab.language, suggestedName(tab.path))));
    if (chosen === null) {
      return false;
    }
    return this.runTabOp(tab, () => this.saveAsNow(tab, chosen));
  }
  /** `saveAs` once the tab is idle, acting on the mode it ended up in. */
  private async saveAsNow(tab: DocTab, chosen: string): Promise<boolean> {
    // Closed while queued: writing its record now would bring the tab back.
    if (!this.tabs.includes(tab)) {
      return false;
    }
    // A windowed tab's buffer lives in the Rust core, not this rope: Rust
    // writes the chosen path and retargets its session.
    if (tab.windowed !== undefined) {
      return this.windowedSaveTo(tab, chosen);
    }
    if (tab.large !== undefined) {
      return this.copyViewerTo(tab, tab.large, chosen);
    }
    // Neither mode: nothing safe to write (see `saveActive`).
    if (isLargeKind(tab)) {
      return false;
    }
    // As in `saveActive`: the baseline is what was written.
    const written = tab.content;
    const writtenEnding = tab.lineEnding;
    // Flush point: materialize the rope for the save-as write.
    const out = applyLineEnding(written.toString(), writtenEnding);
    try {
      await writeDocument({
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
    tab.missing = false;
    if (!tab.explicit) {
      tab.language = detectByFilename(chosen);
    }
    tab.savedContent = written;
    tab.savedLineEnding = writtenEnding;
    await this.upsertTab(tab);
    void invoke('add_recent_file', { path: chosen });
    return true;
  }
  /** Save As for a viewer tab: copy the file's current bytes to `chosen` and
   *  retarget the tab to it. The size is read now, not taken from `large.size`,
   *  which is the size at open time. Choosing the file itself is a no-op. */
  private async copyViewerTo(
    tab: DocTab,
    large: { size: number },
    chosen: string,
  ): Promise<boolean> {
    if (chosen === tab.path) {
      return true;
    }
    let size: number;
    try {
      size = (await invoke<FileStat>('stat_file', { path: tab.path })).size;
      await invoke('copy_range', {
        path: tab.path,
        start: 0,
        end: size,
        dest: chosen,
      });
    } catch (e) {
      this.saveFailed = { path: chosen, error: String(e) };
      return false;
    }
    // Closed during the copy: the copy stands, but its record stays deleted.
    if (!this.tabs.includes(tab)) {
      return true;
    }
    tab.path = chosen;
    if (!tab.explicit) {
      tab.language = detectByFilename(chosen);
    }
    large.size = size;
    await this.upsertTab(tab);
    void invoke('add_recent_file', { path: chosen });
    return true;
  }
  /** The file or folder `from` was renamed to `to`: every tab at or below it, and
   *  the range box over such a file, follow it. Each moved tab is written to the
   *  store again at once, with a newer sequence than anything sent before the
   *  rename, so a snapshot still carrying the old path cannot win. */
  retargetPaths(
    from: string,
    to: string,
    rules: PathRules = pathRules(),
  ): void {
    const moved: DocTab[] = [];
    for (const tab of this.tabs) {
      const next = retargetPath(tab.path, from, to, rules);
      if (next === tab.path) {
        continue;
      }
      tab.path = next;
      if (!tab.explicit) {
        tab.language = detectByFilename(next);
      }
      if (tab.windowed !== undefined) {
        void invoke('windowed_set_path', {
          sessionId: tab.windowed.sessionId,
          path: next,
        });
      }
      moved.push(tab);
    }
    for (const copy of this.incoming.values()) {
      const next = retargetPath(copy.tab.path, from, to, rules);
      if (next !== copy.tab.path) {
        copy.tab.path = next;
        if (!copy.tab.explicit) {
          copy.tab.language = detectByFilename(next);
        }
      }
    }
    const box = this.rangeBox;
    if (box !== null) {
      const source = retargetPath(box.sourcePath, from, to, rules);
      if (source !== box.sourcePath) {
        this.rangeBox = { ...box, sourcePath: source };
      }
    }
    for (const tab of moved) {
      void this.upsertTab(tab);
    }
  }
  /** Open the range edit box over `tab`, a large-file viewer tab, on the byte
   *  slice `info` of its file. The byte offsets are resolved by the caller (the
   *  large-file view, which owns the line index); this reads the slice and
   *  captures the file's fingerprint as the write-back's conflict baseline.
   *
   *  Returns `null` when the box opened, or a message when the range is refused
   *  (lossy, non-UTF-8 content). A genuine read failure — the file was deleted,
   *  permissions changed, the volume went away — is not swallowed: it throws,
   *  so the caller can tell "opened" and "refused" apart from "failed" instead
   *  of all three collapsing onto the same `null`. */
  async openRangeBox(
    tab: DocTab,
    info: {
      startByte: number;
      endByte: number;
      startLine: number;
      endLine: number;
    },
  ): Promise<string | null> {
    if (this.onItsWay(tab)) {
      return null;
    }
    return this.busy(tab, () => this.openRangeBoxNow(tab, info));
  }
  private async openRangeBoxNow(
    tab: DocTab,
    info: {
      startByte: number;
      endByte: number;
      startLine: number;
      endLine: number;
    },
  ): Promise<string | null> {
    const read = await invoke<RangeRead>('read_range', {
      path: tab.path,
      start: info.startByte,
      end: info.endByte,
    });
    // A lossy decode means the slice has bytes UTF-8 can't represent; splicing a
    // re-encoded buffer back would corrupt the file, so refuse the edit box. The
    // byte-faithful "save range" path stays available for such ranges.
    if (read.lossy) {
      return t('doc.range.lossyRefusal');
    }
    let fingerprint: Fingerprint | null;
    try {
      fingerprint = await invoke<Fingerprint>('file_fingerprint', {
        path: tab.path,
      });
    } catch {
      fingerprint = null;
    }
    // Closed while the file was read, or on its way to another window: there is
    // nothing to open the box over.
    if (!this.tabs.includes(tab) || this.onItsWay(tab)) {
      return null;
    }
    this.rangeBox = openRangeBox({
      tabId: tab.id,
      sourcePath: tab.path,
      startByte: info.startByte,
      endByte: info.endByte,
      startLine: info.startLine,
      endLine: info.endLine,
      fingerprint,
      text: read.text,
    });
    return null;
  }
  /** The editor of the open box changed its document. */
  rangeBoxEdited(content: Text): void {
    this.rangeBox = nextRangeBox(this.rangeBox, { kind: 'edit', content });
  }
  /** Whether the open box holds changes that were not written back. */
  rangeBoxDirty(): boolean {
    return this.rangeBox !== null && isRangeBoxDirty(this.rangeBox);
  }
  /** The write-back of the open box that is out now, with the id of the box it
   *  was sent from. */
  #rangeWrite: { session: number; done: Promise<SpliceResult> } | null = null;
  /** Write the open box back into its source. `force` skips the conflict check.
   *  Success closes the box; a changed source raises the conflict modal and
   *  keeps it; any other failure is reported and keeps it too. A save while a
   *  write of the same box is out sends nothing and answers with that write. */
  private writeBack(force: boolean): Promise<SpliceResult> {
    const box = this.rangeBox;
    if (box === null) {
      return Promise.resolve('error');
    }
    const running = this.#rangeWrite;
    if (running !== null && running.session === box.session) {
      return running.done;
    }
    const done: Promise<SpliceResult> = this.writeBackUntilSettled(
      box,
      force,
    ).finally(() => {
      if (this.#rangeWrite?.done === done) {
        this.#rangeWrite = null;
      }
    });
    this.#rangeWrite = { session: box.session, done };
    return done;
  }
  /** Write `first`, then again for what was typed while the write was out, until
   *  a write finds the buffer as it sent it. Only the box with the id it started
   *  from is changed; a box cancelled or replaced meanwhile is left alone. */
  private async writeBackUntilSettled(
    first: RangeBox,
    force: boolean,
  ): Promise<SpliceResult> {
    let box = first;
    let unchecked = force;
    for (;;) {
      const sentContent = box.content;
      // Flush point: materialize the rope for the write-back.
      const written = rangeBoxWriteText(box);
      const outcome = await spliceRange(
        box,
        written,
        unchecked ? null : box.fingerprint,
      );
      const open = this.rangeBox;
      const current = open?.session === box.session ? open : null;
      if (outcome.status === 'mismatch') {
        if (current !== null) {
          this.rangeBox = nextRangeBox(current, { kind: 'mismatch' });
        }
        return 'mismatch';
      }
      if (outcome.status === 'error') {
        // Every failure past the conflict check is reported: the write-back is a
        // save, and a save that did not happen has to say so or the box is left
        // dirty with nothing on screen to explain it. A read-only source also
        // marks the viewer tab, so its padlock catches up without a reopen.
        if (outcome.error === READ_ONLY_DESTINATION) {
          const tab = this.tabs.find((t) => t.id === box.tabId);
          if (tab !== undefined) {
            tab.readOnlyFile = true;
          }
        }
        this.saveFailed = { path: box.sourcePath, error: outcome.error };
        return 'error';
      }
      // The viewer's size stands for the rewritten file now.
      const viewer = this.tabs.find((t) => t.id === box.tabId);
      if (viewer?.large !== undefined) {
        viewer.large.size = outcome.fingerprint.size;
      }
      if (current === null) {
        return 'ok';
      }
      if (nextWriteBack(sentContent, current.content) === 'done') {
        this.rangeBox = nextRangeBox(current, { kind: 'saved' });
        return 'ok';
      }
      box = rebaseRangeBox(current, written, outcome);
      this.rangeBox = box;
      unchecked = false;
    }
  }
  /** Box 儲存: write back with the conflict check. */
  rangeBoxSave(): Promise<SpliceResult> {
    return this.writeBack(false);
  }
  /** Whether the write-back conflict modal is up (DEV/E2E surface). */
  rangeConflictVisible(): boolean {
    return this.rangeBox?.conflict === true;
  }
  /** Conflict choice: write back anyway, ignoring the changed source. */
  rangeConflictForce(): Promise<SpliceResult> {
    return this.writeBack(true);
  }
  /** Conflict choice: abandon the write-back and save the edited buffer as a
   *  new file, opened as a new tab. The box closes and the source is untouched. */
  async rangeConflictSaveAs(pathOverride?: string): Promise<boolean> {
    const box = this.rangeBox;
    if (box === null) {
      return false;
    }
    const chosen =
      pathOverride ??
      (await save(saveDialogOptions(null, suggestedName(box.sourcePath))));
    if (chosen === null) {
      return false;
    }
    // Flush point: materialize the rope for the save-as write.
    const out = applyLineEnding(box.content.toString(), box.lineEnding);
    try {
      await writeDocument({
        path: chosen,
        content: out,
        encoding: settingsState.defaultEncoding,
        withBom: false,
      });
    } catch (e) {
      // The conflict modal stays up and the box keeps its text; report the
      // failure rather than nothing.
      this.saveFailed = { path: chosen, error: String(e) };
      return false;
    }
    this.rangeBox = nextRangeBox(this.rangeBox, { kind: 'cancel' });
    await this.openTab(chosen);
    // An answer of the dialog itself: the new file is shown even where other
    // opens are held back.
    const index = this.tabs.findIndex((t) => t.path === chosen);
    if (index !== -1) {
      await this.switchTo(index);
    }
    return true;
  }
  /** Conflict choice: dismiss the modal, back to the box with its text. */
  rangeConflictCancel(): void {
    this.rangeBox = nextRangeBox(this.rangeBox, { kind: 'conflict-dismissed' });
  }
  /** Box 取消: drop the text and close. */
  rangeBoxCancel(): void {
    this.rangeBox = nextRangeBox(this.rangeBox, { kind: 'cancel' });
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
  /** Read a byte slice of `sourcePath` and save it straight to a new file, then
   *  open that file as a new tab (the "save range" lightweight path).
   *  `pathOverride` skips the save dialog (automation/E2E).
   *
   *  Returns `false` only when the dialog was cancelled, `true` on success. A
   *  genuine write failure — disk full, permissions, volume gone — is not
   *  swallowed into that same `false`: it throws, so the caller can tell
   *  "cancelled" and "failed" apart. */
  async saveRangeAs(
    sourcePath: string,
    info: { startByte: number; endByte: number; pathOverride?: string },
  ): Promise<boolean> {
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
    // available even when the range is too lossy to open in the edit box.
    await invoke('copy_range', {
      path: sourcePath,
      start: info.startByte,
      end: info.endByte,
      dest: chosen,
    });
    await this.openTab(chosen);
    return true;
  }
  /** The open box's source and byte span, or null (DEV/E2E surface). */
  rangeBoxInfo(): {
    sourcePath: string;
    startByte: number;
    endByte: number;
  } | null {
    const box = this.rangeBox;
    return box === null
      ? null
      : {
          sourcePath: box.sourcePath,
          startByte: box.startByte,
          endByte: box.endByte,
        };
  }
  /** Open `path` as a windowed-editing tab: the Rust core opens a session and
   *  streams the file a window at a time (the WindowedEditor owns the CM view).
   *  Returns a message when the open is refused (a non-UTF-8 file), else null.
   *  ponytail: DEV/__auto entry only this segment; the normal open gate keeps
   *  routing oversized files to the read-only viewer until the final step. */
  async openWindowedTab(path: string): Promise<string | null> {
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
      tabIndex: this.allocIndex(),
      order: this.newOrder(),
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
    await this.switchTo(this.tabs.length - 1, true);
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
    if (this.onItsWay(tab)) {
      return 'error';
    }
    return this.busy(tab, () => this.saveWindowedNow(tab, force));
  }
  private async saveWindowedNow(
    tab: DocTab,
    force: boolean,
  ): Promise<WindowedSaveResult> {
    const w = tab.windowed;
    if (w === undefined) {
      return 'error';
    }
    await this.flushWindowedInput(tab);
    let saved: WindowedSaved;
    try {
      devTrace('saveWindowed windowed_save before');
      saved = await invoke<WindowedSaved>('windowed_save', {
        sessionId: w.sessionId,
        expected: force ? null : w.fingerprint,
        pathOverride: null,
      });
      devTrace('saveWindowed windowed_save after');
    } catch (e) {
      if (String(e).includes(WINDOWED_FINGERPRINT_MISMATCH)) {
        this.windowedConflict = tab;
        return 'mismatch';
      }
      if (String(e) === UNMAPPABLE) {
        return this.resolveUnmappable(tab, null);
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
    await this.afterConvertedSave(live, saved);
    devTrace('saveWindowed afterConvertedSave after');
    this.windowedConflict = null;
    await this.upsertTab(live);
    devTrace('saveWindowed upsertTab after');
    return 'ok';
  }
  /** Reports a discard that failed and leaves the tab as it is; false. */
  private failDiscard(tab: DocTab, error: unknown): false {
    this.discardFailed = {
      name: fileName(tab.path) || t('doc.untitled'),
      error: String(error),
    };
    return false;
  }
  /** Discard a windowed tab's unsaved edits: close its session and reopen a fresh
   *  one at the on-disk baseline. The new sessionId remounts the WindowedEditor
   *  (keyed on it), reloading the window from disk. False when it failed: the
   *  tab keeps its session and the failure is in `discardFailed`. */
  async discardWindowed(tab: DocTab): Promise<boolean> {
    const w = tab.windowed;
    if (w === undefined || this.onItsWay(tab)) {
      return true;
    }
    if (tab.converted !== undefined) {
      return this.discardConverted(tab, tab.converted, w);
    }
    // The fresh session is opened before the old one is let go: when the open
    // is refused (lite) or fails, the tab keeps the session it has.
    let open: WindowedOpen | null = null;
    if (!isLite()) {
      try {
        open = await invoke<WindowedOpen>('windowed_open', { path: tab.path });
      } catch (e) {
        if (!isLite()) {
          return this.failDiscard(tab, e);
        }
      }
    }
    // Lite cannot start a session, but the tab already has one and the file's
    // baseline index is all a reopen needs: the quit and close gates' Discard
    // has to be able to clear the edits there too.
    if (open === null) {
      try {
        open = await this.reopenAtBaseline(tab.path, w.sessionId);
      } catch (e) {
        return this.failDiscard(tab, e);
      }
    }
    void invoke('windowed_close', { sessionId: w.sessionId });
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
    return true;
  }
  /** `discardWindowed` for a tab a paste made: what it was before the paste
   *  comes back (a file that is not UTF-8 has no `windowed_open` to go through). */
  private async discardConverted(
    tab: DocTab,
    conv: ConvertedTab,
    w: NonNullable<DocTab['windowed']>,
  ): Promise<boolean> {
    if (conv.saved) {
      // The file is the target in another encoding: decoded again, as at a
      // restart. Not a thing the edition may refuse.
      let open: WindowedOpen;
      try {
        const convertId = await invoke<string>('convert_from_file', {
          path: tab.path,
          encoding: conv.encoding,
          withBom: conv.bom,
        });
        open = await invoke<WindowedOpen>('windowed_reopen_converted', {
          convertId,
          target: tab.path,
          encoding: conv.encoding,
          withBom: conv.bom,
        });
      } catch (e) {
        return this.failDiscard(tab, e);
      }
      void invoke('windowed_close', { sessionId: w.sessionId });
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
      return true;
    }
    if (conv.origin === 'sticky') {
      // The note comes back and the tab goes (`deleteTab` lets the note go).
      await this.deleteTab(this.tabs.indexOf(tab));
      return true;
    }
    let fresh: DocTab;
    if (conv.origin === 'document') {
      const original = await this.originalOf(tab);
      if (original === null) {
        return false;
      }
      fresh = original;
    } else {
      fresh = {
        id: tab.id,
        path: '',
        readOnlyFile: false,
        content: Text.empty,
        savedContent: Text.empty,
        language: null,
        explicit: false,
        lineEnding: tab.lineEnding,
        savedLineEnding: tab.lineEnding,
        hadBom: tab.hadBom,
        encoding: tab.encoding,
        lossy: false,
        tabIndex: tab.tabIndex,
        order: tab.order,
      };
    }
    void invoke('windowed_close', { sessionId: w.sessionId });
    this.windowedGates.delete(w.sessionId);
    this.windowedGenerations.delete(w.sessionId);
    this.releaseTabView(tab.id);
    const { id, tabIndex, order } = tab;
    const bare: Partial<DocTab> = tab;
    for (const key of Object.keys(bare) as (keyof DocTab)[]) {
      delete bare[key];
    }
    Object.assign(tab, fresh, { id, tabIndex, order });
    this.windowedConflict = null;
    await this.upsertTab(tab);
    return true;
  }
  /** The tab as it opens from the file it was a document of, the way an open
   *  routes by size. A file that is gone leaves the tab blank, with the path and
   *  the missing mark; a file that cannot be read is reported and gives null. */
  private async originalOf(tab: DocTab): Promise<DocTab | null> {
    if (!isLite()) {
      try {
        const size = (await invoke<FileStat>('stat_file', { path: tab.path }))
          .size;
        if (opensInLargeViewer(size, false)) {
          return {
            id: tab.id,
            path: tab.path,
            readOnlyFile: tab.readOnlyFile,
            content: Text.empty,
            savedContent: Text.empty,
            language: null,
            explicit: false,
            lineEnding: tab.lineEnding,
            savedLineEnding: tab.lineEnding,
            hadBom: false,
            encoding: settingsState.defaultEncoding,
            lossy: false,
            tabIndex: tab.tabIndex,
            order: tab.order,
            large: { size },
          };
        }
      } catch {
        // Read below.
      }
    }
    try {
      return await this.loadTab(tab.path, null);
    } catch (e) {
      if (!(e instanceof ReadFailed) || e.error !== FILE_NOT_FOUND) {
        this.failDiscard(tab, e instanceof ReadFailed ? e.error : e);
        return null;
      }
      return {
        id: tab.id,
        path: tab.path,
        readOnlyFile: false,
        content: Text.empty,
        savedContent: Text.empty,
        language: tab.language,
        explicit: tab.explicit,
        lineEnding: tab.lineEnding,
        savedLineEnding: tab.lineEnding,
        hadBom: tab.hadBom,
        encoding: tab.encoding,
        lossy: false,
        tabIndex: tab.tabIndex,
        order: tab.order,
        missing: true,
      };
    }
  }
  /** A fresh session on `path` at its on-disk baseline, made from the index of
   *  the live session `sessionId` through `windowed_reopen` instead of
   *  `windowed_open`. */
  private async reopenAtBaseline(
    path: string,
    sessionId: number,
  ): Promise<WindowedOpen> {
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
  /** Wait until the active editor has handed what was typed to the core. Only
   *  the active tab has an editor; a switch settles the others first. */
  private async flushWindowedInput(tab: DocTab): Promise<void> {
    if (tab === this.activeTab) {
      await this.windowedFlushed?.();
    }
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
  /** DEV/E2E: discard the active windowed tab's unsaved edits; false when that
   *  failed. */
  async discardWindowedActive(): Promise<boolean> {
    const tab = this.activeTab;
    if (tab?.windowed === undefined) {
      return true;
    }
    return this.discardWindowed(tab);
  }
  /** Whether the active tab is a windowed tab (DEV/E2E surface). */
  isWindowedTab(): boolean {
    return this.activeTab?.windowed !== undefined;
  }
  /** The active tab as a paste left it (DEV/E2E surface): its `converted`, whether
   *  its session is unsaved, and what the session writes. */
  async convertTabInfo(): Promise<{
    converted: ConvertedTab | null;
    dirty: boolean;
    conv: ConvState | null;
  }> {
    const tab = this.activeTab;
    const conv = tab?.converted;
    let state: ConvState | null = null;
    if (tab?.windowed !== undefined && conv !== undefined) {
      // Sets what it already is: the only way to ask the session.
      state = await invoke<ConvState>('windowed_set_encoding', {
        sessionId: tab.windowed.sessionId,
        encoding: conv.encoding,
        withBom: conv.bom,
      }).catch(() => null);
    }
    return {
      converted: conv === undefined ? null : { ...conv },
      dirty: tab?.windowed?.dirty ?? false,
      conv: state,
    };
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
    if (this.onItsWay(tab)) {
      return false;
    }
    return this.busy(tab, () => this.windowedSaveToNow(tab, chosen));
  }
  private async windowedSaveToNow(
    tab: DocTab,
    chosen: string,
  ): Promise<boolean> {
    const w = tab.windowed;
    if (w === undefined) {
      return false;
    }
    await this.flushWindowedInput(tab);
    let saved: WindowedSaved;
    try {
      devTrace('windowedSaveTo windowed_save before');
      saved = await invoke<WindowedSaved>('windowed_save', {
        sessionId: w.sessionId,
        expected: null,
        pathOverride: chosen,
      });
      devTrace('windowedSaveTo windowed_save after');
    } catch (e) {
      if (String(e) === UNMAPPABLE) {
        return (await this.resolveUnmappable(tab, chosen)) === 'ok';
      }
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
    live.missing = false;
    if (!live.explicit) {
      live.language = detectByFilename(chosen);
    }
    this.applyWindowedSaved(live.windowed, saved);
    await this.afterConvertedSave(live, saved);
    devTrace('windowedSaveTo afterConvertedSave after');
    this.windowedConflict = null;
    await this.upsertTab(live);
    devTrace('windowedSaveTo upsertTab after');
    void invoke('add_recent_file', { path: chosen });
    return true;
  }
  /** After every successful write of a windowed tab, before its record is
   *  written. The first write of a tab a paste made gives it a record of its own
   *  (and takes a sticky note's away); a session that is plain UTF-8 again is an
   *  ordinary large-file tab from then on. */
  private async afterConvertedSave(
    tab: DocTab,
    saved: WindowedSaved,
  ): Promise<void> {
    const conv = tab.converted;
    if (conv === undefined) {
      return;
    }
    conv.target = tab.path;
    if (!conv.saved) {
      conv.saved = true;
      if (conv.origin === 'sticky' && conv.noteId !== undefined) {
        try {
          await invoke('convert_sticky_saved', { noteId: conv.noteId });
        } catch (e) {
          // The file is written; the note's record is what is left over.
          console.error('convert_sticky_saved failed', e);
        }
      }
    }
    if (saved.conv == null) {
      delete tab.converted;
    } else {
      conv.encoding = saved.conv.encoding;
      conv.bom = saved.conv.bom;
    }
  }
  /** D13: a save that cannot write some text in the encoding of the tab. The
   *  user may save as UTF-8 to the same place, save as UTF-8 under another name,
   *  or leave it. `chosen` is the path of a save as that failed (null: the save in
   *  place). */
  private async resolveUnmappable(
    tab: DocTab,
    chosen: string | null,
  ): Promise<WindowedSaveResult> {
    const w = tab.windowed;
    if (w === undefined) {
      return 'error';
    }
    const name = (chosen ?? tab.path).split(/[/\\]/).pop() ?? '';
    const choice = await convertController.askUnmappable(
      name === '' ? t('doc.untitled') : name,
      tab.converted?.encoding ?? tab.encoding,
    );
    if (choice === 'cancel') {
      return 'error';
    }
    let path = chosen;
    // The dialog comes first: a cancelled one leaves the tab and the session as
    // they are.
    if (
      choice === 'saveAs' ||
      (chosen === null && tab.converted?.target === null)
    ) {
      path = await save(
        saveDialogOptions(tab.language, suggestedName(chosen ?? tab.path)),
      );
      if (path === null) {
        return 'error';
      }
    }
    try {
      const set = await invoke<ConvState>('windowed_set_encoding', {
        sessionId: w.sessionId,
        encoding: 'UTF-8',
        withBom: false,
      });
      tab.encoding = set.encoding;
      tab.hadBom = set.bom;
      if (tab.converted !== undefined) {
        tab.converted.encoding = set.encoding;
        tab.converted.bom = set.bom;
      }
    } catch (e) {
      this.saveFailed = { path: chosen ?? tab.path, error: String(e) };
      return 'error';
    }
    if (path === null) {
      return this.saveWindowed(tab, false);
    }
    return (await this.windowedSaveTo(tab, path)) ? 'ok' : 'error';
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
    if (
      tab === null ||
      this.onItsWay(tab) ||
      isLargeKind(tab) ||
      tab.encoding === label
    ) {
      return;
    }
    if (this.isDirty(tab)) {
      tab.encoding = label;
      this.persistActive();
      return;
    }
    const readContent = tab.content;
    const readEnding = tab.lineEnding;
    let decoded: Decoded;
    try {
      decoded = await this.busy(tab, () => readDocument(tab.path, label));
    } catch {
      this.encodingFailed = tab.path;
      return;
    }
    // On its way to another window while the file was read: left as it was.
    if (this.onItsWay(tab)) {
      return;
    }
    // Closed during the read: writing its record now would bring the tab back.
    if (!this.tabs.includes(tab)) {
      return;
    }
    // Edited during the read: the tab is changed now, so it takes the rule above
    // and only the save-time encoding changes. Not `persistActive`, the user
    // may have switched tabs meanwhile.
    if (tab.content !== readContent || tab.lineEnding !== readEnding) {
      tab.encoding = label;
      await this.upsertTab(tab);
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
    await this.upsertTab(tab);
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
  /** The viewer tab holding an edit box with changes, if any: the box is what
   *  the quit, window-close and tab-close gates must ask about first. */
  rangeBoxBlocking(): {
    index: number;
    oversized: false;
    rangeBox: true;
  } | null {
    const box = this.rangeBox;
    if (box === null || !isRangeBoxDirty(box)) {
      return null;
    }
    const index = this.tabs.findIndex((t) => t.id === box.tabId);
    return index === -1 ? null : { index, oversized: false, rangeBox: true };
  }
  /** The tab the quit/close gate must block on right now, if any. An edit box
   *  with changes comes first (`rangeBox` is set then), then an oversized dirty
   *  tab — it is known before a write is even attempted — then a dirty tab
   *  whose write actually failed. `oversized` tells the caller which of the
   *  last two applies, since they need different wording and a different save
   *  action. */
  firstBlockingDirty(): {
    index: number;
    oversized: boolean;
    rangeBox?: true;
  } | null {
    const inBox = this.rangeBoxBlocking();
    if (inBox !== null) {
      return inBox;
    }
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
    if (tab === undefined || this.onItsWay(tab)) {
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
  /** Remove a tab's store entry and drop it from the window. True when this call
   *  closed the tab; false when it stays (it was edited while the record went,
   *  and the record is written back), was closed by another call, or is being
   *  closed already. */
  async deleteTab(index: number): Promise<boolean> {
    const tab = this.tabs[index];
    if (tab === undefined || this.onItsWay(tab) || this.closingTabs.has(tab)) {
      return false;
    }
    this.closingTabs.add(tab);
    // From here the tab is not moved to another window: it is going.
    tab.closing = true;
    try {
      if (index === this.activeIndex) {
        this.persistActive.cancel();
      }
      if (tab === this.windowedConflict) {
        this.windowedConflict = null;
      }
      if (this.rangeBox?.tabId === tab.id) {
        this.rangeBox = null;
      }
      const before: TabCloseState = {
        content: tab.content,
        lineEnding: tab.lineEnding,
        generation: this.generationOf(tab),
      };
      try {
        await invoke('delete_note', { id: tab.id });
      } catch (error) {
        // Still open, and so a tab that may be moved again.
        delete tab.closing;
        throw error;
      }
      const pending =
        tab === this.activeTab && this.windowedPending?.() === true;
      if (
        editedWhileClosing(before, {
          content: tab.content,
          lineEnding: tab.lineEnding,
          generation: this.generationOf(tab),
          pending,
        })
      ) {
        delete tab.closing;
        await this.upsertTab(tab);
        return false;
      }
      const at = this.tabs.indexOf(tab);
      if (at === -1) {
        return false;
      }
      // Nothing below waits: the tab leaves `tabs` in the same step as its
      // session, so nothing can be typed into it in between.
      if (tab.windowed !== undefined) {
        void invoke('windowed_close', { sessionId: tab.windowed.sessionId });
        this.windowedGates.delete(tab.windowed.sessionId);
        this.windowedGenerations.delete(tab.windowed.sessionId);
      }
      // A paste still turning the tab into a large file is given up.
      convertController.cancelTab(tab.id);
      const conv = tab.converted;
      this.releaseTabView(tab.id);
      // The editor never took its seed: it never will.
      this.pendingSeeds.delete(tab.id);
      this.unlockWhenShown.delete(tab.id);
      this.adoptWhenShown.delete(tab.id);
      this.tabs.splice(at, 1);
      // Always write `activeIndex`, even when the computed value equals the
      // current one: closing the active tab can leave the numeric index
      // unchanged while the tab now living at that index is a different tab
      // (e.g. closing tab 0 while a pending windowed-restore tab sits at index
      // 1 shifts it down to index 0). The setter is what notices that and
      // kicks off its restore — see the `activeIndex` accessor.
      let newActive = this.activeIndex;
      if (newActive > at) {
        newActive -= 1;
      } else if (newActive >= this.tabs.length) {
        newActive = Math.max(0, this.tabs.length - 1);
      }
      this.activeIndex = newActive;
      this.consumeUnlock();
      // A sticky note whose text was handed over and never saved comes back.
      if (
        conv?.saved === false &&
        conv.origin === 'sticky' &&
        conv.noteId !== undefined
      ) {
        try {
          await invoke('convert_release', { noteId: conv.noteId });
        } catch (e) {
          console.error('convert_release failed', e);
        }
      }
      return true;
    } finally {
      this.closingTabs.delete(tab);
    }
  }
  /** The newest content generation of a windowed tab's session, if it has one. */
  private generationOf(tab: DocTab): number | undefined {
    return tab.windowed === undefined
      ? undefined
      : this.windowedGenerations.get(tab.windowed.sessionId);
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
        void invoke('windowed_close', { sessionId: tab.windowed.sessionId });
      }
    }
    await invoke('drop_closed_tabs', { label, ids: clean.map((t) => t.id) });
  }
  /** Push every dirty tab to disk-store before a quit ack (not just the active). */
  async flushAll(): Promise<void> {
    // A tab being put into this window is written by the core's own update; the
    // flush follows it.
    await this.committing?.catch(() => {});
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
