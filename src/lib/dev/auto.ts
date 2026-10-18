// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { gotoLine as gotoLineCommand } from '@codemirror/search';
import { activeView } from './editorRegistry';
import { settingsState, type LargeOpenMode } from '../state/settings.svelte';
import type { LineEnding } from '../util/text';
import type { Language } from '../i18n/locale';
import type { ViewMode } from '../util/viewModes';

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

export function installStickyAuto(hooks: StickyHooks): void {
  (window as unknown as { __auto: unknown }).__auto = {
    typeText,
    getContent,
    getTitle: hooks.getTitle,
    clickPin: hooks.clickPin,
    setPaper: hooks.setPaper,
    openCloseFlow: hooks.openCloseFlow,
  };
}

/** Document-window actions wired to the tabbed DocumentApp controller. */
export interface DocumentHooks {
  getTitle: () => string;
  getTabs: () => unknown;
  switchTab: (index: number) => void;
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
  windowedTrace: () => unknown[];
  windowedUndo: () => void;
  windowedRedo: () => void;
  windowedSave: () => Promise<'ok' | 'mismatch' | 'error'>;
  windowedSaveForce: () => Promise<'ok' | 'mismatch' | 'error'>;
  windowedDiscard: () => Promise<void>;
  windowedConflictVisible: () => boolean;
  windowedConflictSaveAs: (path: string) => Promise<boolean>;
  setWorkerHighlight: (on: boolean) => void;
  getWorkerHighlight: () => boolean;
  workerHighlightActive: () => boolean;
  getLargeOpenMode: () => LargeOpenMode;
  setLargeOpenMode: (m: LargeOpenMode) => void;
  // Drives the same handoff the Tauri window-focus event triggers, so E2E can
  // exercise the focus-reclaim path without a real OS focus change.
  windowFocusGained: () => void;
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
  folderQuickAdd: (path: string, kind: 'file' | 'folder') => void;
}

export function installWorkspaceAuto(hooks: WorkspaceHooks): void {
  (window as unknown as { __auto: unknown }).__auto = { ...hooks };
}
