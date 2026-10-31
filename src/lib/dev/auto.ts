// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { gotoLine as gotoLineCommand } from '@codemirror/search';
import { invoke } from '@tauri-apps/api/core';
import { activeView } from './editorRegistry';
import {
  settingsState,
  type LargeOpenMode,
  type LargeSelectAll,
  type OpenTarget,
} from '../state/settings.svelte';
import { convertController } from '../state/convertController.svelte';
import type { NoteSnapshot } from '../state/stickyNote.svelte';
import type { ClipInfo } from '../util/clipRouting';
import { liveTokens } from '../util/liveTokens';
import { pasteLocks } from '../util/pasteLock';
import type { LineEnding } from '../util/text';
import type { Language } from '../i18n/locale';
import type { ViewMode } from '../util/viewModes';
import {
  heldGlobalOps,
  heldWindowedReads,
  heldWindowedResults,
  holdClipStatus,
  holdGlobalOps,
  holdWindowedReads,
  holdWindowedResults,
  releaseClipStatus,
  releaseGlobalOps,
  releaseWindowedReads,
  releaseWindowedResults,
} from './windowedHold';
// DEV-only automation surface reached by the Rust harness via `eval`. Installed
// on `window.__auto` only under `import.meta.env.DEV`; because every caller sits
// behind that guard, this whole module is dropped from the production bundle
// (verified by the absence of `__auto` in dist).
/** Sticky-only actions wired to the toolbar handlers of StickyApp. Stickies
 *  have no search at all. */
export interface StickyHooks {
  getTitle: () => string;
  clickPin: () => void;
  setPaper: (name: string) => void;
  openCloseFlow: () => void;
}

function typeText(text: string): void {
  const view = activeView();
  if (view === null) {
    return;
  }
  const pos = view.state.selection.main.head;
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
  });
}

function getContent(): string {
  return activeView()?.state.doc.toString() ?? '';
}
/** A paste event carrying `text` at the focused element, or the page body: what
 *  the handlers did with it and how often they read it. The system clipboard
 *  is not used. */
function pasteText(text: string): { prevented: boolean; getDataCalls: number } {
  const data = new DataTransfer();
  data.setData('text/plain', text);
  let getDataCalls = 0;
  const read = data.getData.bind(data);
  Object.defineProperty(data, 'getData', {
    value: (type: string): string => {
      getDataCalls += 1;
      return read(type);
    },
  });
  const event = new ClipboardEvent('paste', {
    clipboardData: data,
    bubbles: true,
    cancelable: true,
  });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return { prevented: event.defaultPrevented, getDataCalls };
}
/** The hooks of the paste, shared by every kind of window that has editors. */
const pasteHooks = {
  holdClipStatus,
  releaseClipStatus,
  pasteText,
  /** Whether a paste holds a tab or the note. */
  pasteLocked: (): boolean => pasteLocks.any(),
  /** How many clip copies this window has reserved and not finished. */
  clipReservations: (): number => liveTokens.tokens('reservation').length,
  /** The question a conversion to the large-file mode asks, as it is drawn. */
  convertDialog: (): {
    kind: string;
    message: string;
    buttons: string[];
  } | null => {
    const d = convertController.dialog;
    return d === null
      ? null
      : {
          kind: d.kind,
          message: d.message,
          buttons: [d.primary, d.secondary, d.cancel].filter(
            (b): b is string => b !== undefined,
          ),
        };
  },
  /** The tab ids of the conversions under way. */
  convertJobs: (): string[] => convertController.jobTabIds(),
  /** How the last conversion's run ended. */
  lastConvertExit: (): string | null => convertController.lastExit,
  /** Presses a button of that question by its label; false when there is none. */
  convertAnswer: (label: string): boolean => {
    const d = convertController.dialog;
    if (d === null) {
      return false;
    }
    if (d.primary === label) {
      convertController.answer('primary');
    } else if (d.secondary === label) {
      convertController.answer('secondary');
    } else if (d.cancel === label) {
      convertController.answer('cancel');
    } else {
      return false;
    }
    return true;
  },
  /** Whether the sticky note `id` has been handed to a document window: its
   *  record is still there but no list shows it. */
  noteHandedOff: async (id: string): Promise<boolean> => {
    const listed = await invoke<NoteSnapshot[]>('list_notes');
    const record = await invoke<NoteSnapshot | null>('get_note', { id });
    return record !== null && !listed.some((n) => n.id === id);
  },
};

export function installStickyAuto(hooks: StickyHooks): void {
  (window as unknown as { __auto: unknown }).__auto = {
    typeText,
    getContent,
    ...pasteHooks,
    getTitle: hooks.getTitle,
    clickPin: hooks.clickPin,
    setPaper: hooks.setPaper,
    openCloseFlow: hooks.openCloseFlow,
  };
}
/** Document-window actions wired to the tabbed DocumentApp controller. */
export interface DocumentHooks {
  getTitle: () => string;
  /** The active tab a paste made a large file: its `converted`, `dirty` and
   *  what the session writes. */
  convertTabInfo: () => Promise<unknown>;
  getTabs: () => unknown;
  switchTab: (index: number) => void;
  /** Make tab `index` the active one at once, without the settle-and-drain
   *  `switchTab` does first: reproduces an editor whose result lands after
   *  another tab became active. */
  switchTabNow: (index: number) => void;
  openTab: (path: string) => void;
  /** The same open, handing back the promise so a test can observe a
   *  rejection. `openTab` stays void on purpose: the automation wrapper
   *  awaits the eval's value, so a promise there would make every existing
   *  `openTab` call block on the whole open and hit the 3 s eval timeout. */
  openTabSettled: (path: string) => Promise<void>;
  newTab: () => void;
  closeActiveTab: () => void;
  /** `openNormal` swallows `loadTab`'s exception and only sets this, so a
   *  failed open is otherwise indistinguishable from no open at all. */
  openFailed: () => string | null;
  toggleLineEnding: () => void;
  setEncoding: (label: string) => void;
  saveActive: (path?: string) => Promise<boolean>;
  getCursor: () => { line: number; col: number };
  openFind: () => void;
  openFindReplace: () => void;
  findNext: () => void;
  searchPanelOpen: () => boolean;
  closeFind: () => void;
  setSearchInSelection: (on: boolean) => void;
  getSearchInSelection: () => boolean;
  setDocSelection: (from: number, to: number) => void;
  /** The ends of the ordinary editor's selection (0-based line and column), or
   *  null without one. */
  getDocSelection: () => {
    anchor: { line: number; col: number };
    head: { line: number; col: number };
  } | null;
  getViewMode: () => ViewMode;
  setViewMode: (m: ViewMode) => void;
  /** How many tabs currently have a remembered view mode. Only closing a tab
   *  should ever bring this back down, which is what makes the cleanup on
   *  close observable from a test. */
  viewModeEntryCount: () => number;
  /** Character count of the active tab, the figure the preview ceiling is
   *  compared against. */
  activeContentLength: () => number;
  getTableCell: (r: number, c: number) => string;
  setTableCell: (r: number, c: number, v: string) => void;
  tableDims: () => { rows: number; cols: number };
  insertTableRow: (at: number) => void;
  deleteTableRow: (at: number) => void;
  insertTableCol: (at: number) => void;
  deleteTableCol: (at: number) => void;
  openTableMenu: (r: number, c: number) => void;
  tableMenuOpen: () => boolean;
  setHeaderRow: (on: boolean) => void;
  getHeaderRow: () => boolean;
  selectRow: (r: number) => void;
  selectCol: (c: number) => void;
  selectAll: () => void;
  getSelection: () =>
    { kind: 'row' | 'col'; index: number } | { kind: 'all' } | null;
  copySelection: () => string;
  clearSelection: () => void;
  deselect: () => void;
  tableUndo: () => void;
  tableRedo: () => void;
  largeConfirmVisible: () => boolean;
  largeConfirmAccept: () => void;
  largeConfirmEdit: () => void;
  largeConfirmCancel: () => void;
  longLineActive: () => boolean;
  longLineConfirmVisible: () => boolean;
  longLineFormatAvailable: () => boolean;
  longLineConfirmAsIs: () => void;
  longLineConfirmFormat: () => void;
  longLineConfirmSoftWrap: () => void;
  longLineConfirmCancel: () => void;
  largeUnlockAvailable: () => boolean;
  largeUnlockEdit: () => Promise<string | null>;
  isLargeTab: () => boolean;
  largeInfo: () => { size: number; totalLines: number | null };
  largeVisibleFirstLine: () => number;
  largeScrollToLine: (n: number) => Promise<void>;
  largeVisibleText: () => string;
  largeGotoOpen: () => void;
  largeGotoVisible: () => boolean;
  largeGoto: (line: number) => void;
  largeSearchOpen: () => void;
  largeSearchVisible: () => boolean;
  largeSearch: (query: string, caseSensitive: boolean) => void;
  largeSearchResults: () => { line: number; preview: string }[];
  largeSearchDone: () => boolean;
  largeSearchJump: (index: number) => void;
  largeSearchClose: () => void;
  largeSelectRange: (startLine: number, endLine: number) => void;
  largeGetRange: () => { startLine: number; endLine: number } | null;
  largeRangeEdit: () => void;
  largeRangeSaveAs: (path: string) => Promise<boolean>;
  /** The range edit box over the large-file tab: opened by `largeRangeEdit`,
   *  typed into with `typeText`, then saved or cancelled. */
  rangeBoxVisible: () => boolean;
  rangeBoxInfo: () => {
    sourcePath: string;
    startByte: number;
    endByte: number;
  } | null;
  rangeBoxDirty: () => boolean;
  rangeBoxSave: () => Promise<'ok' | 'mismatch' | 'error'>;
  rangeBoxCancel: () => void;
  rangeConflictVisible: () => boolean;
  rangeConflictForce: () => Promise<'ok' | 'mismatch' | 'error'>;
  rangeConflictSaveAs: (path: string) => Promise<boolean>;
  rangeConflictCancel: () => void;
  oversizedGateVisible: () => boolean;
  oversizedGateSave: () => Promise<void>;
  oversizedGateDiscard: () => Promise<void>;
  oversizedGateCancel: () => void;
  windowedOpen: (path: string) => Promise<string | null>;
  isWindowedTab: () => boolean;
  /** `rescanned` from the most recently completed `windowed_reopen`, or null
   *  before any restore has completed — see `DocumentWindowState`'s
   *  `windowedRestoreRescanned`. Lets E2E distinguish a fast-path restore from
   *  a rescan that merely finished within a poll's timeout. */
  windowedRestoreRescanned: () => boolean | null;
  windowedInfo: () => {
    windowStartLine: number;
    totalLines: number;
    totalBytes: number;
    dirty: boolean;
  };
  windowedGoto: (line: number) => void;
  /** The windowed editor's global selection ends, or null without one. */
  windowedGlobalSel: () => {
    anchor: { line: number; col: number };
    head: { line: number; col: number };
  } | null;
  /** The end of the windowed editor's file, or null without one. */
  windowedEndPos: () => Promise<{ line: number; col: number } | null>;
  /** How many items the windowed editor's replay queue holds. */
  windowedReplayLength: () => number;
  /** What decides whether a composition that starts now is captured, or null
   *  without a windowed editor. */
  windowedImeState: () => {
    capturing: boolean;
    locked: boolean;
    outside: boolean | null;
    selectAllPending: boolean;
    swapping: boolean;
    replaySwapActive: boolean;
    draining: boolean;
    holds: number;
    wanted: boolean;
    replayLength: number;
  } | null;
  /** The windowed editor's global selection, window, whether the swap now
   *  running leaves it open to input, how many windows it has installed and
   *  how many `windowed_apply` and global commands it has sent; null without
   *  one. */
  windowedGlobalInfo: () => {
    globalSel: {
      anchor: { line: number; col: number };
      head: { line: number; col: number };
    };
    windowStartLine: number;
    swapping: boolean;
    /** No swap runs and nothing is queued. */
    settled: boolean;
    keepsInput: boolean;
    ownGlobalOp: boolean;
    windowInstalls: number;
    applies: number;
    globalOps: number;
  } | null;
  /** A pointer click at a global byte offset inside the loaded window. */
  windowedPointerSelect: (offset: number) => boolean;
  /** Whether the window swap now running leaves the editor open to input. */
  windowedSwapKeepsInput: () => boolean;
  /** Whether the large-file viewer's selection is the whole file. */
  largeWholeFile: () => boolean;
  /** Runs a menu action as the native menu event does. */
  menuAction: (action: string) => void;
  largeSelectAllMode: () => LargeSelectAll;
  setLargeSelectAll: (m: LargeSelectAll) => void;
  windowedTrace: () => unknown[];
  windowedUndo: () => void;
  windowedRedo: () => void;
  windowedSave: () => Promise<'ok' | 'mismatch' | 'error'>;
  windowedSaveForce: () => Promise<'ok' | 'mismatch' | 'error'>;
  windowedDiscard: () => Promise<boolean>;
  windowedConflictVisible: () => boolean;
  windowedConflictSaveAs: (path: string) => Promise<boolean>;
  setWorkerHighlight: (on: boolean) => void;
  getWorkerHighlight: () => boolean;
  workerHighlightActive: () => boolean;
  getLargeOpenMode: () => LargeOpenMode;
  setLargeOpenMode: (m: LargeOpenMode) => void;
  setOpenTarget: (t: OpenTarget) => void;
  // Drives the same handoff the Tauri window-focus event triggers, so E2E can
  // exercise the focus-reclaim path without a real OS focus change.
  windowFocusGained: () => void;
  /** File name shown by the missing-file dialog now up, or null. */
  missingVisible: () => string | null;
  /** Labels of the buttons drawn in that dialog, or null when it is not up. */
  missingButtons: () => string[] | null;
  /** Its "save as new" button, with the target given instead of the dialog. */
  missingSaveAs: (path: string) => Promise<boolean>;
  /** Its "discard changes" button. */
  missingDiscard: () => Promise<void>;
  /** Labels of the buttons drawn in the write-back conflict dialog now up (the
   *  range box's or the windowed tab's), or null when neither is. */
  conflictButtons: () => string[] | null;
}
/** Whether the active editor's content DOM currently holds keyboard focus. */
function editorFocused(): boolean {
  return activeView()?.contentDOM === document.activeElement;
}
/** Editor settings as currently applied, read from the live CM view/DOM so
 *  E2E can confirm live-apply actually reached the editor. */
function getEditorState(): {
  fontSize: number;
  fontFamily: string;
  wordWrap: boolean;
  lineNumbers: boolean;
} | null {
  const view = activeView();
  if (view === null) {
    return null;
  }
  const cs = getComputedStyle(view.contentDOM);
  return {
    fontSize: parseFloat(cs.fontSize),
    fontFamily: cs.fontFamily,
    // CM6 marks wrapping with this class (white-space varies by CM version).
    wordWrap: view.contentDOM.classList.contains('cm-lineWrapping'),
    lineNumbers: view.dom.querySelector('.cm-lineNumbers') !== null,
  };
}
/** Runs the go-to-line command and submits its panel like a user would. */
function gotoLine(n: number): boolean {
  const view = activeView();
  if (view === null) {
    return false;
  }
  gotoLineCommand(view);
  const input = view.dom.querySelector<HTMLInputElement>(
    '.cm-panel input[name="line"]',
  );
  const form = input?.form;
  if (input === null || input === undefined || !form) {
    return false;
  }
  input.value = String(n);
  form.requestSubmit();
  return true;
}
/** Distance of the cursor row's middle from the scroller's middle, plus the
 *  numbers needed to judge it. */
function lineCenterOffset(n: number): {
  offset: number;
  lineHeight: number;
  defaultLineHeight: number;
  scrollTop: number;
  maxScrollTop: number;
  inView: boolean;
} | null {
  const view = activeView();
  if (view === null || n < 1 || n > view.state.doc.lines) {
    return null;
  }
  const line = view.state.doc.line(n);
  const top = view.coordsAtPos(line.from);
  const bottom = view.coordsAtPos(line.to, -1);
  if (top === null || bottom === null) {
    return null;
  }
  const scroller = view.scrollDOM;
  const rect = scroller.getBoundingClientRect();
  return {
    offset: (top.top + top.bottom) / 2 - (rect.top + scroller.clientHeight / 2),
    lineHeight: bottom.bottom - top.top,
    defaultLineHeight: view.defaultLineHeight,
    scrollTop: scroller.scrollTop,
    maxScrollTop: scroller.scrollHeight - scroller.clientHeight,
    inView:
      top.top >= rect.top && top.bottom <= rect.top + scroller.clientHeight,
  };
}

let warnings: string[] | null = null;
/** Messages passed to console.warn since the previous call; the first call
 *  starts collecting. */
function consoleWarnings(): string[] {
  if (warnings === null) {
    const collected: string[] = [];
    warnings = collected;
    const original = console.warn.bind(console);
    console.warn = (...args: unknown[]): void => {
      collected.push(args.map(String).join(' '));
      original(...args);
    };
    return [];
  }
  return warnings.splice(0);
}

const KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
  ';': 186,
  '=': 187,
  ',': 188,
  '-': 189,
  '.': 190,
  '/': 191,
  '`': 192,
  '[': 219,
  '\\': 220,
  ']': 221,
  "'": 222,
};

function keyCodeOf(key: string): number {
  const known = KEY_CODES[key];
  if (known !== undefined) {
    return known;
  }
  return key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
}
/** A keydown at the editor's content, made the way the E2E scripts make one;
 *  true when something prevented its default. */
function windowedPressKey(
  key: string,
  mods: Partial<
    Pick<KeyboardEventInit, 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey'>
  > = {},
): boolean {
  // The editor on screen: an ordinary editor may stay mounted, hidden.
  const all = [...document.querySelectorAll('.cm-content')];
  const content = all.find((el) => el.getClientRects().length > 0) ?? all[0];
  if (content === undefined) {
    return false;
  }
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...mods,
  });
  Object.defineProperty(event, 'keyCode', { get: () => keyCodeOf(key) });
  content.dispatchEvent(event);
  return event.defaultPrevented;
}
/** The ends of the active editor's own (window-local) selection, 0-based. */
function windowedLiveSelection(): {
  anchor: { line: number; col: number };
  head: { line: number; col: number };
} | null {
  const view = activeView();
  if (view === null) {
    return null;
  }
  const main = view.state.selection.main;
  const at = (pos: number): { line: number; col: number } => {
    const line = view.state.doc.lineAt(pos);
    return { line: line.number - 1, col: pos - line.from };
  };
  return { anchor: at(main.anchor), head: at(main.head) };
}

const pause = (ms: number): Promise<void> =>
  ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();
/** A composition made of events: `compositionstart` on the target, one
 *  composing transaction per update (editor only), and `compositionend` with
 *  `endData`. The target takes focus first. It sets no `view.composing`. Each
 *  delay is the wait before its step, in milliseconds. */
async function windowedCompose(opts: {
  target: 'editor' | 'find';
  updates: string[];
  endData: string;
  delays?: {
    beforeStart?: number;
    afterStart?: number;
    between?: number;
    beforeEnd?: number;
  };
}): Promise<void> {
  const view = activeView();
  const el =
    opts.target === 'editor'
      ? (view?.contentDOM ?? null)
      : document.querySelector<HTMLElement>('.search-panel input.cm-textfield');
  if (el === null) {
    return;
  }
  const delays = opts.delays ?? {};
  await pause(delays.beforeStart ?? 0);
  el.focus();
  el.dispatchEvent(
    new CompositionEvent('compositionstart', { bubbles: true, data: '' }),
  );
  await pause(delays.afterStart ?? 0);
  if (opts.target === 'editor' && view !== null) {
    const main = view.state.selection.main;
    let from = main.from;
    let to = main.to;
    for (const text of opts.updates) {
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
        userEvent: 'input.type.compose',
      });
      to = from + text.length;
      await pause(delays.between ?? 0);
    }
  }
  await pause(delays.beforeEnd ?? 0);
  el.dispatchEvent(
    new CompositionEvent('compositionend', {
      bubbles: true,
      data: opts.endData,
    }),
  );
}
/** A copy or cut event at the focused element, or the page body, carrying an
 *  empty DataTransfer: whether the handlers prevented it and what they put on
 *  it is what the caller reads. The system clipboard is not used. */
function clipEvent(type: 'copy' | 'cut'): {
  prevented: boolean;
  types: number;
  data: string;
} {
  const data = new DataTransfer();
  const event = new ClipboardEvent(type, {
    clipboardData: data,
    bubbles: true,
    cancelable: true,
  });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return {
    prevented: event.defaultPrevented,
    types: data.types.length,
    data: data.getData('text/plain'),
  };
}

export function installDocumentAuto(hooks: DocumentHooks): void {
  (window as unknown as { __auto: unknown }).__auto = {
    typeText,
    getContent,
    getEditorState,
    editorFocused,
    gotoLine,
    lineCenterOffset,
    consoleWarnings,
    setWordWrap: (on: boolean) => settingsState.setWordWrap(on),
    getLanguage: () => settingsState.language,
    setLanguage: (l: Language) => settingsState.setLanguage(l),
    holdWindowedResults,
    heldWindowedResults,
    releaseWindowedResults,
    holdWindowedReads,
    heldWindowedReads,
    releaseWindowedReads,
    holdGlobalOps,
    heldGlobalOps,
    releaseGlobalOps,
    windowedPressKey,
    windowedCompose,
    windowedLiveSelection,
    windowedCopy: () => clipEvent('copy'),
    windowedCut: () => clipEvent('cut'),
    viewerCopy: () => clipEvent('copy'),
    clipStatus: () => invoke<ClipInfo | null>('clip_status'),
    ...pasteHooks,
    ...hooks,
  };
}
/** Settings-window actions that live in the component rather than in
 *  settingsState. Each one sits behind a native dialog or a debounced write, so
 *  there is no other way to reach it from a test. */
export interface SettingsHooks {
  /** null switches back to the default location. */
  switchSnapshotDir: (dir: string | null) => Promise<void>;
  exportTheme: (path: string) => Promise<void>;
  /** Drives the live colour editor, debounce and all. */
  setThemeColor: (path: string, value: string) => void;
  themeColor: (path: string) => string;
}
/** Settings-window actions. Each method drives the same settingsState code path
 *  as its UI control, so E2E exercises exactly what a user click would. */
export function installSettingsAuto(hooks: SettingsHooks): void {
  (window as unknown as { __auto: unknown }).__auto = {
    getSettings: () => ({
      themeId: settingsState.themeId,
      editorFontSize: settingsState.editorFontSize,
      editorWordWrap: settingsState.editorWordWrap,
      editorLineNumbers: settingsState.editorLineNumbers,
      workerHighlight: settingsState.workerHighlight,
      largeOpenMode: settingsState.largeOpenMode,
      largeSelectAll: settingsState.largeSelectAll,
      editorFontFamily: settingsState.editorFontFamily,
      defaultLineEnding: settingsState.defaultLineEnding,
      defaultEncoding: settingsState.defaultEncoding,
      newNoteShortcut: settingsState.newNoteShortcut,
      snapshotDir: settingsState.snapshotDir,
      defaultStickyWidth: settingsState.defaultStickyWidth,
      defaultStickyHeight: settingsState.defaultStickyHeight,
      language: settingsState.language,
      resolvedLocale: settingsState.resolvedLocale,
    }),
    getLanguage: () => settingsState.language,
    setLanguage: (l: Language) => settingsState.setLanguage(l),
    setThemeId: (id: string) => settingsState.setThemeId(id),
    setFontSize: (n: number) => settingsState.setFontSize(n),
    setFontFamily: (v: string) => settingsState.setFontFamily(v),
    setWordWrap: (b: boolean) => settingsState.setWordWrap(b),
    setLineNumbers: (b: boolean) => settingsState.setLineNumbers(b),
    setWorkerHighlight: (b: boolean) => settingsState.setWorkerHighlight(b),
    setLargeOpenMode: (m: LargeOpenMode) => settingsState.setLargeOpenMode(m),
    setLargeSelectAll: (m: LargeSelectAll) =>
      settingsState.setLargeSelectAll(m),
    setOpenTarget: (t: OpenTarget) => settingsState.setOpenTarget(t),
    setDefaultLineEnding: (v: LineEnding) =>
      settingsState.setDefaultLineEnding(v),
    setDefaultEncoding: (v: string) => settingsState.setDefaultEncoding(v),
    ...hooks,
  };
}
/** Workspace-window actions wired to the sticky and open-document lists. */
export interface WorkspaceHooks {
  getStickyRows: () => unknown;
  getDocRows: () => unknown;
  clickSticky: (id: string) => void;
  stickySave: (id: string) => void;
  stickyClose: (id: string) => void;
  clickDoc: (group: string, tabIndex: number) => void;
  addProject: (path: string) => Promise<void>;
  removeProject: (path: string) => Promise<void>;
  clearProject: () => Promise<void>;
  getTreeRows: () => unknown;
  toggleFolder: (path: string) => void;
  getProjectRoots: () => string[];
  getExpandedPaths: () => string[];
  getListDirCalls: () => number;
  treeIdle: () => Promise<void>;
  clickFile: (path: string) => void;
  ctxCreateFile: (
    parentPath: string,
    project: string,
    name: string,
  ) => Promise<void>;
  ctxCreateFolder: (parentPath: string, name: string) => Promise<void>;
  ctxRename: (path: string, newName: string) => Promise<void>;
  ctxTrash: (path: string) => Promise<void>;
  ctxRevealSupported: () => boolean;
  inlineEditorOpen: () => boolean;
  getSelectedPaths: () => string[];
  /** The folder a drag would drop into and the cursor shown, or null when no
   *  drag is under way. */
  dragState: () => { target: string | null; cursor: string; op: string } | null;
  /** The dialog on screen: its message, listed items and button labels. */
  dialogState: () => {
    message: string;
    items: { label: string; detail: string }[];
    buttons: string[];
  } | null;
  /** Press the button with this label; false when there is none. */
  dialogPress: (label: string) => Promise<boolean>;
  folderQuickAdd: (path: string, kind: 'file' | 'folder') => void;
}

export function installWorkspaceAuto(hooks: WorkspaceHooks): void {
  (window as unknown as { __auto: unknown }).__auto = { ...hooks };
}
