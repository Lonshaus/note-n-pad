<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import { onMount } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { invoke } from '@tauri-apps/api/core';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { listen } from '@tauri-apps/api/event';
  import { open } from '@tauri-apps/plugin-dialog';
  import DocumentEditor from './lib/editor/DocumentEditor.svelte';
  import TableView from './lib/table/TableView.svelte';
  import JsonView from './lib/preview/JsonView.svelte';
  import XmlView from './lib/preview/XmlView.svelte';
  import MarkdownView from './lib/preview/markdown/MarkdownView.svelte';
  import type { ViewMode } from './lib/util/viewModes';
  import type { DsvChange } from './lib/util/csv';
  import {
    defaultViewModeFor,
    modeBlockedBy,
    viewModesFor,
  } from './lib/util/viewModes';
  import LargeFileView from './lib/large/LargeFileView.svelte';
  import type { LargeStatus } from './lib/large/LargeFileView.svelte';
  import WindowedEditor from './lib/windowed/WindowedEditor.svelte';
  import StatusBar from './lib/StatusBar.svelte';
  import ConfirmModal from './lib/ConfirmModal.svelte';
  import {
    settingsState,
    type LargeOpenMode,
  } from './lib/state/settings.svelte';
  import { revealWhenThemed } from './lib/util/reveal';
  import { applyTheme, applyChrome } from './lib/theme/applyTheme';
  import { themeRegistry } from './lib/theme/themeRegistry.svelte';
  import { localeRegistry } from './lib/i18n/localeRegistry.svelte';
  import {
    isWorkerHighlightActive,
    isWorkerHighlightEnabled,
  } from './lib/highlight/workerHighlight.svelte';
  import { languageNames } from './lib/editor/language';
  import { resolveLanguageId } from './lib/highlight/languages';
  import {
    parseInitialTab,
    shouldCollapseEmptyWindow,
  } from './lib/util/openDocuments';
  import { ENCODINGS } from './lib/util/text';
  import {
    splitMenuAction,
    languageArg,
    tabReportEntry,
    isEditAction,
    editActionSurface,
  } from './lib/util/menuBar';
  import {
    editorCopy,
    editorCut,
    editorPaste,
  } from './lib/util/editorClipboard';
  import {
    parseDsv,
    serializeDsv,
    dsvDelimiterFor,
    setCell,
    insertRow,
    deleteRow,
    insertCol,
    deleteCol,
    widestRow,
  } from './lib/util/csv';
  import { debounce } from './lib/util/debounce';
  import {
    documentWindow,
    LARGE_EDIT_MAX,
    RANGE_SPLICED_EVENT,
    rangeDisplayName,
    type DocTab,
  } from './lib/state/documentWindow.svelte';
  import { READ_ONLY_DESTINATION } from './lib/util/protocol';
  import { fileName } from './lib/util/filePath';
  import { formatFileSize } from './lib/util/format';
  import { textFromString } from './lib/util/text';
  import { focusEditorIfIdle } from './lib/util/editorFocus';
  import { t } from './lib/i18n';
  import type { EditorView } from '@codemirror/view';
  import { undo, redo, selectAll } from '@codemirror/commands';
  import {
    openSearchPanel,
    closeSearchPanel,
    findNext,
    findPrevious,
    searchPanelOpen,
  } from '@codemirror/search';
  import {
    getSearchInSelection,
    setSearchInSelection,
  } from './lib/editor/searchPanel';

  const win = getCurrentWindow();
  const params = new URLSearchParams(window.location.search);
  const group = params.get('group') ?? crypto.randomUUID();
  const initialPath = params.get('path');
  const initialProject = params.get('project');
  // Stored `tab_index` to activate on restore (workspace click on a group whose
  // window was closed). Absent means the group's first tab.
  const initialTab = parseInitialTab(params.get('tab'));

  let showModal = $state(false);
  // The oversized gate is up: a dirty tab too large to snapshot must be saved or
  // discarded first. Set by the quit or the window-close handshake.
  let oversizedVisible = $state(false);
  // What the oversized gate resumes once every offending tab is resolved: a quit
  // (request_exit) or just closing this window (confirm_close). Non-reactive: it
  // is only read inside the async handshake handlers right after being set.
  let oversizedContinuation: 'quit' | 'close' = 'quit';
  // Which condition is currently raising the gate: known-in-advance size
  // ('oversized', `firstOversizedDirtyIndex`) or a snapshot write that was
  // actually attempted and failed ('unwritable', `firstUnwritableDirtyIndex`).
  // Drives the gate's message and its save action (see `promptOversized`).
  let oversizedReason = $state<'oversized' | 'unwritable'>('oversized');
  // Set once the app-level quit handshake starts (`flush-request`), cleared
  // again if this or another window vetoes the quit (`flush-cancelled`). Not
  // a one-way latch: `flush-request` only means the handshake *started*.
  // While true, `close-flush-request` (a same-window OS close caught up in
  // the same batch close) is ignored so the quit handshake — not this
  // window's own self-destroy via `confirm_close` — owns the shutdown; a
  // window racing both would never send `flush_ack`, stalling the quit.
  let quitting = false;
  // Set when a windowed apply/read fails: the editor has locked itself and the
  // message is shown so the divergence is visible rather than silent.
  let windowedError = $state<string | null>(null);
  // True while the active editor tab's document holds a line past the long-line
  // threshold (synchronous highlighting off; worker highlighting takes over).
  // Reported by DocumentEditor; the status bar shows an honest marker off it.
  let longLineActive = $state(false);

  const active = $derived(documentWindow.activeTab);
  const title = $derived(
    active
      ? (rangeDisplayName(active) ?? tabName(active.path))
      : t('doc.untitled'),
  );
  const openIds = $derived(documentWindow.tabs.map((t) => t.id));

  // Honest long-line status for the status bar: shown only for a normal editor
  // tab whose long-line gate is active. `workerColoring` is true when worker
  // highlighting will actually run (the setting is on and a Lezer parser covers
  // the language) and false when it cannot (setting off, or no parser), which
  // the bar renders as "highlighting disabled". Derived purely, so it stays
  // reactive to the setting and the active language.
  const longLineStatus = $derived(
    longLineActive &&
      active !== null &&
      active.large === undefined &&
      active.windowed === undefined
      ? {
          workerColoring:
            settingsState.workerHighlight &&
            active.language !== null &&
            resolveLanguageId(active.language) !== null,
        }
      : null,
  );

  // Report this window's open tabs to the core so the Dock menu can list and
  // mark them and the app menu's Format/File items can track the active tab.
  // Untitled tabs are never persisted, so this live report is the only source
  // that includes them. Fires on tab open/close/switch/rename and whenever the
  // active tab's line ending / encoding / syntax / saved path changes (each read
  // below makes the effect reactive to it).
  $effect(() => {
    if (!documentWindow.ready) {
      return;
    }
    const tabs = documentWindow.tabs.map((tb) =>
      tabReportEntry({
        tabIndex: tb.tabIndex,
        name: rangeDisplayName(tb) ?? tabName(tb.path),
        path: tb.path,
        lineEnding: tb.lineEnding,
        encoding: tb.encoding,
        language: tb.language,
      }),
    );
    const active = documentWindow.activeTab?.tabIndex ?? null;
    void invoke('report_doc_tabs', { group, active, tabs });
  });

  // Large-file open confirm: the state layer stages the pending open; this
  // window renders the modal and collapses an empty window on cancel.
  const pendingLarge = $derived(documentWindow.pendingLargeOpen);
  // An editable pending file (under the edit cap) offers the Edit button; an
  // oversized one shows only View/Cancel.
  const largeCanEdit = $derived(
    pendingLarge !== null && pendingLarge.size < LARGE_EDIT_MAX,
  );
  // Neutral copy: the confirm no longer predicts a single mode, it just states
  // the size and lets the buttons decide.
  const largeMessage = $derived(
    pendingLarge !== null
      ? t('doc.large.confirm', {
          name: tabName(pendingLarge.path),
          size: formatFileSize(pendingLarge.size),
        })
      : '',
  );

  // The mounted large-file view (only while a large tab is active) and its live
  // status, mirrored into the status bar and the DEV surface.
  let largeRef = $state<{
    scrollToLine: (n: number) => Promise<void>;
    visibleText: () => string;
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
  } | null>(null);
  // The mounted windowed editor (only while a windowed tab is active), exposing
  // its window/goto surface to the DEV automation hooks.
  let windowedRef = $state<{
    info: () => {
      windowStartLine: number;
      totalLines: number;
      totalBytes: number;
    };
    goto: (line: number) => void;
    windowedTrace: () => unknown[];
    undo: () => void;
    redo: () => void;
    focus: () => void;
  } | null>(null);
  let largeStatus = $state<LargeStatus>({
    totalLines: null,
    indexedLines: 0,
    firstLine: 1,
    indexing: true,
    readFailed: false,
  });
  const largeBar = $derived(
    active !== null && active.large !== undefined
      ? {
          size: active.large.size,
          totalLines: largeStatus.totalLines,
          indexedLines: largeStatus.indexedLines,
          firstLine: largeStatus.firstLine,
          indexing: largeStatus.indexing,
          readFailed: largeStatus.readFailed,
        }
      : null,
  );

  function onLargeCancel(): void {
    documentWindow.cancelLargeOpen();
    // A window opened solely for this file has no other tab; close it rather
    // than leave an empty shell.
    if (documentWindow.tabs.length === 0) {
      void win.destroy();
    }
  }

  // The open dialog: the staged over-long-line open, and its cancel (mirroring
  // the large-file confirm — a window opened solely for this file collapses).
  const pendingLongLine = $derived(documentWindow.pendingLongLineOpen);

  function onLongLineCancel(): void {
    documentWindow.cancelLongLineOpen();
    if (documentWindow.tabs.length === 0) {
      void win.destroy();
    }
  }

  // Same collapse as the two confirms above: a window opened solely for a file
  // that could not be read has nothing left to show once the report is closed.
  function onOpenFailedClose(): void {
    documentWindow.dismissOpenFailed();
    if (documentWindow.tabs.length === 0) {
      void win.destroy();
    }
  }

  // Unlike the failed-open report above, the tab whose encoding change failed
  // stays open with its previous content — there is nothing to collapse.
  function onEncodingFailedClose(): void {
    documentWindow.dismissEncodingFailed();
  }

  // The pencil after a large-file tab's name: the action that starts editing
  // it. Four states: editable (title Edit, clickable), oversized (disabled,
  // view-only), a lazy restore still in flight (disabled, its own wording —
  // the file may well be under the ceiling), and refused after a failed unlock
  // (disabled, carrying the reason). Returns null for every other tab. A file
  // the filesystem marks read-only gets the padlock before the name and no
  // pencil at all, because nothing in the app can lift that lock.
  function largeLock(tab: DocTab): { disabled: boolean; title: string } | null {
    const l = tab.large;
    if (l === undefined) {
      return null;
    }
    if (l.size >= LARGE_EDIT_MAX) {
      return { disabled: true, title: t('doc.lock.oversized') };
    }
    // The fallback viewer is up while a lazy restore's reopen is still running
    // in the background (see `beginWindowedRestore`'s slow path); disable the
    // lock so a click can't race it with a second windowed_open of the same
    // file. It re-enables once the restore settles one way or the other. The
    // file may be well under the ceiling — the oversized wording would be
    // wrong here, so this state carries its own.
    if (tab.windowedRestore !== undefined) {
      return { disabled: true, title: t('doc.lock.restoring') };
    }
    if (l.unlockRefused !== undefined) {
      return { disabled: true, title: l.unlockRefused };
    }
    return { disabled: false, title: t('doc.lock.edit') };
  }

  // Unlock the active large tab in place, continuing from the line at the top of
  // its viewport. Returns null on success or a short reason on refusal (the tab
  // stays read-only and its lock reflects the reason).
  function unlockActiveLarge(): Promise<string | null> {
    const tab = documentWindow.activeTab;
    if (tab?.large === undefined) {
      return Promise.resolve(null);
    }
    return documentWindow.unlockLargeTab(
      Math.max(0, largeStatus.firstLine - 1),
    );
  }

  // Whether the active tab's lock can unlock (DEV surface + status). Mirrors the
  // enabled state of largeLock for the active tab.
  function activeLargeUnlockAvailable(): boolean {
    const tab = documentWindow.activeTab;
    const l = tab?.large;
    return (
      l !== undefined &&
      l.size < LARGE_EDIT_MAX &&
      l.unlockRefused === undefined &&
      tab?.windowedRestore === undefined
    );
  }

  // Tab-lock click. A background tab's lock switches to that tab first, then
  // unlocks from its top; the active tab's lock unlocks from the viewed line.
  async function unlockTab(i: number): Promise<void> {
    const tab = documentWindow.tabs[i];
    if (tab?.large === undefined) {
      return;
    }
    if (i !== documentWindow.activeIndex) {
      await documentWindow.switchTo(i);
      await documentWindow.unlockLargeTab(0);
    } else {
      await unlockActiveLarge();
    }
  }

  // Per-tab view mode, keyed by tab id. Runtime-only (never persisted); the
  // starting mode comes from the file's extension. A SvelteMap keeps it
  // reactive, and `finishTabClose` drops the entry when the tab goes away.
  const viewModes = new SvelteMap<string, ViewMode>();

  // Modes this app can actually render. A mode listed by `viewModesFor` but
  // missing here is filtered out entirely rather than offered as a dead option.
  const IMPLEMENTED_MODES: readonly ViewMode[] = [
    'source',
    'table',
    'json',
    'xml',
    'markdown',
  ];

  // The active tab's delimiter (',' / '\t') or null when it is not tabular.
  const activeDelimiter = $derived(
    active !== null ? dsvDelimiterFor(active.path) : null,
  );
  const isTabular = $derived(activeDelimiter !== null);
  // A windowed tab renders through its own editor, so every view that draws on
  // top of the normal editor — the table included — has nothing to attach to.
  const viewsUnavailable = $derived(
    active !== null &&
      (active.windowed !== undefined || active.windowedRestore !== undefined),
  );
  const availableModes = $derived<ViewMode[]>(
    active === null
      ? ['source']
      : viewModesFor(active.path).filter((m) => IMPLEMENTED_MODES.includes(m)),
  );
  const activeViewMode = $derived<ViewMode>(
    active !== null && !viewsUnavailable
      ? (viewModes.get(active.id) ?? defaultViewModeFor(active.path))
      : 'source',
  );
  const showTable = $derived(isTabular && activeViewMode === 'table');
  const showJson = $derived(activeViewMode === 'json');
  const showXml = $derived(activeViewMode === 'xml');
  const showMarkdown = $derived(activeViewMode === 'markdown');
  // The folder the Markdown preview may load images from: the document's own,
  // and a range tab's real file is its source, not its (empty) `path`. Null
  // for an unsaved tab, which gets no images at all.
  const previewBaseDir = $derived(
    showMarkdown && active !== null
      ? dirOf(active.range?.sourcePath ?? active.path)
      : null,
  );
  // The folder the core has confirmed for this webview. The preview waits for
  // it: an image requested before the registration lands is refused, and the
  // node latches that refusal, so it would show alt text forever.
  let registeredBase = $state<string | null>(null);
  // Registered with the Rust core, which is what an image request is resolved
  // against — the URL itself never carries a folder. One effect for the whole
  // window: driving it from MarkdownView's own mount would let a remount for
  // the next tab race the previous one's clear.
  $effect(() => {
    const dir = previewBaseDir;
    // Written from the continuation, never from the effect body. The guard
    // drops a reply that lost a race to a later registration.
    void invoke('set_preview_base', { dir })
      .then(() => {
        if (previewBaseDir === dir) {
          registeredBase = dir;
        }
      })
      // A rejected registration just means no images, which the alt-text
      // fallback already shows; nothing here can usefully recover.
      .catch(() => {
        if (previewBaseDir === dir) {
          registeredBase = null;
        }
      });
  });
  // The switcher's entries. `source` is always usable; the rest explain
  // themselves when they are not. A tab past the preview ceiling keeps its
  // table option — the table view has never had a size limit of its own.
  // The rule itself lives in viewModes.ts so it can be tested without a window;
  // this only turns its answer into words.
  function modeDisabledReason(mode: ViewMode): string | null {
    const blocked = modeBlockedBy(mode, {
      windowed: viewsUnavailable,
      length: active?.content.length ?? 0,
    });
    if (blocked === null) {
      return null;
    }
    return blocked === 'windowed'
      ? t('status.viewUnavailableHere')
      : t('status.viewTooLarge');
  }
  const modeOptions = $derived(
    availableModes.map((mode) => ({
      mode,
      disabledReason: modeDisabledReason(mode),
    })),
  );

  function setViewMode(mode: ViewMode): void {
    if (active === null) {
      return;
    }
    const leavingTable = activeViewMode === 'table' && mode === 'source';
    viewModes.set(active.id, mode);
    // Table edits now dispatch straight into CM, so its doc already tracks the
    // buffer and a reload would push a redundant history step (breaking stepwise
    // undo). Only re-sync when the defensive fallback left the hidden CM stale.
    if (leavingTable) {
      const view = editorView;
      // Reference compare (both ropes): equal means CM already tracks the buffer,
      // so no reload. They diverge only if the direct-write fallback ran.
      if (view === null || view.state.doc !== active.content) {
        documentWindow.forceEditorReload();
      }
    }
  }

  // Table mutations operate on the active tab's buffer through the same pure
  // csv engine the TableView uses, so DEV hooks and the UI stay in lockstep.
  function tableRows(): string[][] {
    if (active === null || activeDelimiter === null) {
      return [];
    }
    // Table-mode-only cost: the DSV parser needs a string, so materialize the
    // rope here (accepted per-keystroke overhead while the table view is open).
    return parseDsv(active.content.toString(), activeDelimiter).rows;
  }

  function emitTable(next: string[][]): void {
    if (active === null || activeDelimiter === null) {
      return;
    }
    // Table-mode-only cost: materialize the rope for the DSV parser.
    const { trailingNewline } = parseDsv(
      active.content.toString(),
      activeDelimiter,
    );
    applyTableEdit([
      {
        from: 0,
        to: active.content.length,
        insert: serializeDsv(next, activeDelimiter, { trailingNewline }),
      },
    ]);
  }

  // Push table-side changes through the still-mounted (but hidden) CM view so
  // they land in CM's undo history as one step and fire the change listener →
  // updateActiveContent → buffer/table redraw along the normal reaction chain.
  // Falls back to a direct buffer write only if CM is missing.
  function applyTableEdit(changes: DsvChange[]): void {
    if (changes.length === 0) {
      return;
    }
    const view = editorView;
    if (view === null) {
      if (active === null) {
        return;
      }
      // Applied back to front so an earlier change cannot shift a later one's
      // offsets out from under it.
      let doc = active.content;
      for (let i = changes.length - 1; i >= 0; i -= 1) {
        const c = changes[i]!;
        doc = doc.replace(c.from, c.to, textFromString(c.insert));
      }
      documentWindow.updateActiveContent(doc);
      return;
    }
    view.dispatch({ changes });
  }

  // Table-view undo/redo drive CM's history so table edits and source edits
  // share one timeline. Selection indices may be stale after the doc changes, so
  // clear any selection first (the deselect convention used by every mutation).
  function tableUndo(): void {
    const view = editorView;
    if (view === null) {
      return;
    }
    tableRef?.deselect();
    undo(view);
  }

  function tableRedo(): void {
    const view = editorView;
    if (view === null) {
      return;
    }
    tableRef?.deselect();
    redo(view);
  }

  // Window-level fallback so undo/redo work in table view even when focus sits
  // outside the table (e.g. right after opening, before any cell is clicked).
  // The table's own handler runs first and preventDefaults, so skip those. A
  // windowed tab owns its own Cmd+Z (routed to the Rust journal by the editor's
  // keymap), so this table fallback must never steal it.
  function onWindowKeydown(e: KeyboardEvent): void {
    if (!showTable || e.defaultPrevented || active?.windowed !== undefined) {
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) {
        tableRedo();
      } else {
        tableUndo();
      }
    }
  }

  function tabName(path: string): string {
    return fileName(path) || t('doc.untitled');
  }

  /** The folder holding `path`, or null when there is none (an unsaved tab, or
   *  a bare file name). There is no dirname helper in this codebase; this
   *  splits on the same `[/\\]` as `tabName`. */
  function dirOf(path: string): string | null {
    const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    if (cut < 0) {
      return null;
    }
    // Keep the separator when the file sits directly at a root: `/a.md` is `/`,
    // and `C:\a.md` is `C:\` — never `C:`, which Windows reads as
    // drive-relative rather than as the drive root.
    const dir = path.slice(0, cut);
    return dir === '' || dir.endsWith(':') ? path.slice(0, cut + 1) : dir;
  }

  // CotEditor-style: the window title follows the active tab's file name.
  $effect(() => {
    void win.setTitle(title);
  });

  // Reflect the editor theme and the interface chrome onto the document root.
  $effect(() => {
    applyTheme(settingsState.themeId);
    applyChrome(settingsState.interfaceMode, settingsState.prefersDark);
  });

  // Cmd+O / File > Open. The current open-target setting is read live so a
  // change takes effect on the next open with no broadcast handling. "window"
  // opens each picked file in its own document window (multi-select allowed);
  // "tab" keeps the historical single-select new-tab behavior.
  async function openInThisWindow(): Promise<void> {
    if (settingsState.openTarget === 'window') {
      const selected = await open({ multiple: true, directory: false });
      if (selected === null) {
        return;
      }
      const paths = Array.isArray(selected) ? selected : [selected];
      for (const path of paths) {
        await invoke('open_document_window', { path });
      }
      return;
    }
    const selected = await open({ multiple: false, directory: false });
    if (typeof selected !== 'string') {
      return;
    }
    await documentWindow.openTab(selected);
  }

  // The active tab's CodeMirror view, supplied by DocumentEditor so menu-driven
  // find/replace commands run against the real editor without global state.
  let editorView: EditorView | null = null;

  // Any dialog/modal currently up. The automatic focus handoff is suppressed
  // while one is open so a gate/confirm keeps the keyboard.
  const anyModalOpen = $derived(
    showModal ||
      oversizedVisible ||
      pendingLarge !== null ||
      pendingLongLine !== null ||
      windowedError !== null ||
      documentWindow.openFailed !== null ||
      documentWindow.saveFailed !== null ||
      documentWindow.rangeConflict !== null ||
      documentWindow.windowedConflict !== null,
  );

  // Hand keyboard focus to the active editor when the window regains focus, so a
  // programmatically opened or restored window types without a click. Large
  // read-only viewer tabs have no editor to focus, so they are skipped.
  function focusActiveEditor(): void {
    if (documentWindow.activeTab?.windowed !== undefined) {
      windowedRef?.focus();
    } else {
      focusEditorIfIdle(editorView, anyModalOpen);
    }
  }

  // The mounted TableView (only while the table view is shown), exposing its
  // menu API to the DEV automation surface.
  let tableRef = $state<{
    openMenu: (r: number, c: number) => Promise<void>;
    menuOpen: () => boolean;
    selectRow: (r: number) => void;
    selectCol: (c: number) => void;
    selectAll: () => void;
    getSelection: () =>
      { kind: 'row' | 'col'; index: number } | { kind: 'all' } | null;
    copySelection: () => string;
    clearSelection: () => void;
    deselect: () => void;
    setHeaderRow: (on: boolean) => void;
    getHeaderRow: () => boolean;
  } | null>(null);

  // Find/replace acts on the CM view, which any other view is drawn on top of.
  // Switching the active tab back to source first is the least-surprising
  // fallback (the panel then opens on the real editor), so all find entry
  // points route through here. Every non-source mode covers the editor, not
  // just the table, so the check is on the mode rather than on `showTable`.
  function ensureSourceView(): void {
    if (activeViewMode !== 'source') {
      setViewMode('source');
    }
  }

  function openFind(): void {
    ensureSourceView();
    if (editorView !== null) {
      openSearchPanel(editorView);
    }
  }

  // Same panel as Find (CM's default panel always carries the replace row); focus
  // the replace field so Find and Replace lands the caret there.
  function openFindReplace(): void {
    ensureSourceView();
    const view = editorView;
    if (view === null) {
      return;
    }
    openSearchPanel(view);
    requestAnimationFrame(() => {
      const input =
        view.dom.querySelector<HTMLInputElement>('[name="replace"]');
      input?.focus();
    });
  }

  function findNextMatch(): void {
    ensureSourceView();
    if (editorView !== null) {
      findNext(editorView);
    }
  }

  function findPrevMatch(): void {
    ensureSourceView();
    if (editorView !== null) {
      findPrevious(editorView);
    }
  }

  function closeFind(): void {
    if (editorView !== null) {
      closeSearchPanel(editorView);
    }
  }

  function isSearchOpen(): boolean {
    return editorView !== null && searchPanelOpen(editorView.state);
  }

  // Copy the active tab's file path to the clipboard (File > Copy File Path).
  function copyActivePath(): void {
    const path = active?.path;
    if (path !== undefined && path !== '') {
      void navigator.clipboard.writeText(path);
    }
  }

  // Path of a reveal that could not be carried out, awaiting the user's
  // acknowledgement. A tab outlives the file it was opened from, and a reveal
  // that quietly does nothing (or, on Windows, opens some unrelated folder) is
  // indistinguishable from a broken menu item.
  let revealFailed = $state<string | null>(null);

  // Path of a large-file tab whose background line-index scan failed (open
  // error or a mid-scan I/O error), awaiting the user's acknowledgement. A
  // failed scan used to leave the status bar spinning "indexing…" forever
  // with no other sign anything had gone wrong.
  let indexFailed = $state<string | null>(null);

  // Reveal the active tab's file in the OS file browser (File > Show in Finder).
  function showActiveInFinder(): void {
    const path = active?.path;
    if (path !== undefined && path !== '') {
      void invoke('reveal_in_finder', { path }).catch(() => {
        revealFailed = path;
      });
    }
  }

  // Route a menu accelerator (emitted from the Rust menu to the focused window)
  // to its handler. Parameterized Format actions (set-line-ending / set-encoding
  // / set-language) carry their argument after a colon. Unknown actions ignored.
  function runMenuAction(action: string): void {
    const parsed = splitMenuAction(action);
    if (parsed !== null) {
      switch (parsed.command) {
        case 'set-line-ending':
          documentWindow.setLineEnding(parsed.arg === 'CRLF' ? 'CRLF' : 'LF');
          break;
        case 'set-encoding':
          void documentWindow.setEncoding(parsed.arg);
          break;
        case 'set-language':
          documentWindow.setActiveLanguage(languageArg(parsed.arg));
          break;
      }
      return;
    }
    if (isEditAction(action)) {
      const surface = editActionSurface(action, {
        isTable: showTable,
        isWindowed: active?.windowed !== undefined,
        hasEditorView: editorView !== null,
      });
      if (surface === 'table') {
        if (action === 'undo') {
          tableUndo();
        } else if (action === 'redo') {
          tableRedo();
        } else if (action === 'select-all') {
          tableRef?.selectAll();
        } else if (action === 'copy') {
          tableRef?.copySelection();
        }
      } else if (surface === 'windowed') {
        if (action === 'undo') {
          windowedRef?.undo();
        } else {
          windowedRef?.redo();
        }
      } else if (surface === 'editor' && editorView !== null) {
        const view = editorView;
        if (action === 'undo') {
          undo(view);
        } else if (action === 'redo') {
          redo(view);
        } else if (action === 'select-all') {
          selectAll(view);
        } else if (action === 'copy') {
          editorCopy(view);
        } else if (action === 'cut') {
          void editorCut(view);
        } else if (action === 'paste') {
          void editorPaste(view);
        }
      }
      return;
    }
    switch (action) {
      case 'new-tab':
        void documentWindow.newTab();
        break;
      case 'open':
        void openInThisWindow();
        break;
      case 'save':
        void documentWindow.saveActive();
        break;
      case 'save-as':
        void documentWindow.saveAs();
        break;
      case 'show-in-finder':
        showActiveInFinder();
        break;
      case 'copy-path':
        copyActivePath();
        break;
      case 'find':
        // Large tabs have no CM view; Cmd+F opens the streaming-search panel.
        if (active !== null && active.large !== undefined) {
          largeRef?.largeSearchOpen();
        } else {
          openFind();
        }
        break;
      case 'find-replace':
        openFindReplace();
        break;
      case 'find-next':
        findNextMatch();
        break;
      case 'find-prev':
        findPrevMatch();
        break;
    }
  }

  // Close the current active tab; its store entry is removed and the window
  // closes when it was the last tab.
  async function finishTabClose(): Promise<void> {
    // Read the tab before deleting it: `deleteTab` splices it out of `tabs`, so
    // by the time it resolves there is nothing left to look the id up from and
    // its `viewModes` entry would sit there for the life of the window.
    const closing = documentWindow.activeTab;
    await documentWindow.deleteTab(documentWindow.activeIndex);
    if (closing !== null) {
      viewModes.delete(closing.id);
    }
    if (documentWindow.tabs.length === 0) {
      await win.destroy();
    }
  }

  function closeActive(): void {
    const tab = documentWindow.activeTab;
    if (tab === null) {
      return;
    }
    if (documentWindow.isDirty(tab)) {
      showModal = true;
    } else {
      void finishTabClose();
    }
  }

  async function requestCloseTab(index: number): Promise<void> {
    await documentWindow.switchTo(index);
    closeActive();
  }

  async function modalSave(): Promise<void> {
    // A cancelled save dialog (untitled tab) aborts: keep the tab open and the
    // confirm modal up, never falling through to close/discard.
    if (!(await documentWindow.saveActive())) {
      return;
    }
    showModal = false;
    await finishTabClose();
  }

  async function modalDiscard(): Promise<void> {
    documentWindow.cancelPending();
    showModal = false;
    await finishTabClose();
  }

  function modalCancel(): void {
    showModal = false;
  }

  // Finish closing this window: clean tabs leave the store (a closed document
  // must not reopen on the next launch), dirty ones keep their snapshot, then
  // the backend destroys the window.
  async function finishWindowClose(): Promise<void> {
    await documentWindow.dropClosedTabs(win.label);
    await invoke('confirm_close', { label: win.label });
  }
  // Oversized gate. A dirty tab too large to snapshot cannot be restored after
  // the window goes away, so the quit and window-close handshakes raise this
  // gate instead of silently dropping the edits. Save/discard walk the offending
  // tabs one at a time; once none remain the pending action resumes — a quit via
  // `request_exit`, or just closing this window via `confirm_close`. Cancel
  // leaves everything as-is (a quit is already vetoed; a close was prevented).
  async function promptOversized(): Promise<void> {
    const blocking = documentWindow.firstBlockingDirty();
    if (blocking === null) {
      oversizedVisible = false;
      if (oversizedContinuation === 'close') {
        await finishWindowClose();
      } else {
        await invoke('request_exit');
      }
      return;
    }
    await documentWindow.switchTo(blocking.index);
    oversizedReason = blocking.oversized ? 'oversized' : 'unwritable';
    oversizedVisible = true;
    // The gate may belong to a background window (quit asks every window at
    // once); raise it or the user sees no reaction to their quit at all.
    await win.setFocus();
  }

  async function oversizedSave(): Promise<void> {
    // The oversized gate resaves in place (a dialog only for an untitled tab).
    // A write-failure gate always prompts Save As: the failure is in the
    // snapshot folder, a different location from the tab's own file, but
    // forcing an explicit new target is the safer default when a location was
    // just proven unwritable.
    const saved =
      oversizedReason === 'unwritable'
        ? await documentWindow.saveAs()
        : await documentWindow.saveActive();
    // A cancelled or failed save leaves the tab unsaved; dismiss the gate (the
    // quit is already vetoed, so the app simply stays open).
    if (!saved) {
      oversizedVisible = false;
      return;
    }
    await promptOversized();
  }

  async function oversizedDiscard(): Promise<void> {
    // A windowed tab's dirtiness lives in its Rust session, so a plain buffer
    // reset would not clear it (leaving the quit gate stuck); reopen the session
    // at the on-disk baseline instead.
    if (documentWindow.activeTab?.windowed !== undefined) {
      await documentWindow.discardWindowedActive();
    } else {
      documentWindow.discardChanges(documentWindow.activeIndex);
    }
    await promptOversized();
  }

  function oversizedCancel(): void {
    oversizedVisible = false;
  }

  onMount(() => {
    const unlistenTheme = settingsState.listen();
    const unlistenChanges = settingsState.listenChanges();
    const unlistenThemes = themeRegistry.listen();
    const unlistenLocales = localeRegistry.listen();
    // Push the encoding and syntax lists (the frontend is their single source of
    // truth) so the Format submenus build from them. Idempotent in the core: only
    // the first push that changes the stored lists rebuilds the menu.
    void invoke('set_menu_lists', {
      encodings: [...ENCODINGS],
      languages: languageNames,
    });
    // Reveal the window only after the theme is loaded and applied, so a
    // dark-theme window never flashes its default white background. File
    // content is loaded separately below and paints onto the themed surface.
    void revealWhenThemed();
    void (async (): Promise<void> => {
      await documentWindow.init(group, initialPath, initialProject, initialTab);
      // A fresh window opened for a single file whose open routed elsewhere (it
      // was already showing in another live window) has no tab and no pending
      // prompt; close the empty shell rather than leave it hanging. A pending
      // open-mode confirm (large-file OR long-line) must keep the window alive
      // so the user can answer it — omitting the long-line flag flash-closed the
      // window mid-dialog when a long-line file opened into a fresh window.
      if (
        shouldCollapseEmptyWindow(
          initialPath !== null,
          documentWindow.tabs.length,
          documentWindow.pendingLargeOpen !== null,
          documentWindow.pendingLongLineOpen !== null,
          documentWindow.openFailed !== null,
        )
      ) {
        void win.destroy();
      }
    })();

    // New Tab / Open / Save / Find and New Sticky are all menu accelerators now,
    // so each fires exactly once through the menu path. Only Ctrl+Tab tab-cycling
    // stays keydown-only (it is deliberately not a menu item). Both directions are
    // listed in the Keyboard Shortcuts window via `NON_MENU_SHORTCUTS` in
    // src-tauri/src/lib.rs — changing this binding means updating that table too.
    const onKeydown = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        documentWindow.cycle(e.shiftKey ? -1 : 1);
      }
    };

    // Persist logical bounds after the user finishes moving or resizing.
    const captureBounds = debounce(() => {
      void (async (): Promise<void> => {
        const scale = await win.scaleFactor();
        const pos = (await win.outerPosition()).toLogical(scale);
        const size = (await win.innerSize()).toLogical(scale);
        documentWindow.setBounds(pos.x, pos.y, size.width, size.height);
      })();
    }, 300);

    // Window close handshake. The OS close of a document window is intercepted
    // in Rust, which asks this webview to flush before destroying it, so unsaved
    // edits are never dropped. Dirty tabs are snapshotted (a restart restores
    // them), then the backend destroys the window. A dirty tab too large to
    // snapshot cannot ride along, so it raises the same gate quit uses; here the
    // gate resumes by closing the window instead of quitting.
    const unlistenCloseFlush = win.listen('close-flush-request', async () => {
      if (quitting) {
        // A quit handshake already owns this window's shutdown (see
        // `quitting`'s comment); let it finish instead of racing it through
        // `confirm_close`.
        return;
      }
      if (documentWindow.firstOversizedDirtyIndex() !== -1) {
        oversizedContinuation = 'close';
        await promptOversized();
        return;
      }
      await documentWindow.flushAll();
      // A snapshot write failure is only discovered by attempting it; check
      // right after the attempt, same gate as the oversized case above.
      if (documentWindow.firstUnwritableDirtyIndex() !== -1) {
        oversizedContinuation = 'close';
        await promptOversized();
        return;
      }
      await finishWindowClose();
    });
    const unlistenMoved = win.onMoved(() => captureBounds());
    const unlistenResized = win.onResized(() => captureBounds());

    // When the window regains OS focus, keyboard focus can be left on BODY (the
    // WebView then silently drops keystrokes); hand it back to the active editor
    // unless a dialog or an input field is holding it.
    const unlistenFocus = win.onFocusChanged(({ payload: focused }) => {
      if (focused) {
        focusActiveEditor();
      }
    });

    // Cmd+W (routed from the app menu) closes the active tab, not the window.
    const unlistenMenuClose = win.listen('menu-close', () => closeActive());

    // File/Edit menu accelerators arrive here as a single string payload.
    const unlistenMenuAction = win.listen<string>('menu-action', (event) =>
      runMenuAction(event.payload),
    );

    // Workspace click: focus the tab whose stored tabIndex matches (controller
    // tabs carry tabIndex, which is not the array position after closes/reorders).
    const unlistenSwitchTab = win.listen<number>(
      'workspace-switch-tab',
      (event) => {
        const index = documentWindow.tabs.findIndex(
          (t) => t.tabIndex === event.payload,
        );
        if (index !== -1) {
          void documentWindow.switchTo(index);
        }
      },
    );

    // Workspace context menu → Close Tab: close the tab whose stored tabIndex
    // matches, running the same dirty-confirm flow as its own close button.
    const unlistenCloseTab = win.listen<number>(
      'workspace-close-tab',
      (event) => {
        const index = documentWindow.tabs.findIndex(
          (t) => t.tabIndex === event.payload,
        );
        if (index !== -1) {
          void requestCloseTab(index);
        }
      },
    );

    // Open a path as a tab in this window. Two producers: the workspace project
    // tree, and the shell handing over a file when the open target is "tab".
    const unlistenOpenFile = win.listen<string>('open-file-here', (event) => {
      void documentWindow.openTab(event.payload);
    });

    // A splice rewrote a source file (this window or another): if a large-file
    // viewer of that path is open here, rebuild its stale line index.
    const unlistenSpliced = listen<string>(RANGE_SPLICED_EVENT, (event) => {
      documentWindow.refreshLargeTabs(event.payload);
    });

    // Quit handshake: flush every dirty tab, then ack. Quit stays silent;
    // restore reopens unsaved tabs afterward.
    const unlistenFlush = win.listen('flush-request', async () => {
      quitting = true;
      // A dirty tab too large to snapshot cannot be silently restored after
      // quit; veto this quit right away (before the handshake times out and
      // exits anyway) and make the user save or discard it first.
      if (documentWindow.firstOversizedDirtyIndex() !== -1) {
        oversizedContinuation = 'quit';
        await invoke('flush_cancel');
        await promptOversized();
        return;
      }
      await documentWindow.flushAll();
      // A snapshot write failure is only discovered by attempting it, so this
      // check can only happen after the flush above — a dirty tab whose write
      // just failed cannot be silently restored after quit either.
      if (documentWindow.firstUnwritableDirtyIndex() !== -1) {
        oversizedContinuation = 'quit';
        await invoke('flush_cancel');
        await promptOversized();
        return;
      }
      await invoke('flush_ack', { label: win.label });
    });
    // Companion to `flush-request`: emitted when any window (this one or
    // another) vetoes the quit. The handshake never completes, so undo the
    // latch — `close-flush-request` must work normally again afterward.
    const unlistenFlushCancelled = win.listen('flush-cancelled', () => {
      quitting = false;
    });

    window.addEventListener('keydown', onKeydown);
    // DEV-only automation hook; dynamic import keeps it out of production.
    if (import.meta.env.DEV) {
      void import('./lib/dev/auto').then((m) =>
        m.installDocumentAuto({
          getTitle: () => title,
          getTabs: () =>
            documentWindow.tabs.map((t, i) => ({
              path: t.path,
              dirty: documentWindow.isDirty(t),
              active: i === documentWindow.activeIndex,
              lineEnding: t.lineEnding,
              hadBom: t.hadBom,
              encoding: t.encoding,
              lossy: t.lossy,
              language: t.language,
              project: documentWindow.project,
            })),
          switchTab: (i: number) => void documentWindow.switchTo(i),
          openTab: (p: string) => void documentWindow.openTab(p),
          newTab: () => void documentWindow.newTab(),
          closeActiveTab: () => closeActive(),
          toggleLineEnding: () => documentWindow.toggleLineEnding(),
          setEncoding: (label: string) =>
            void documentWindow.setEncoding(label),
          saveActive: (path?: string) => documentWindow.saveActive(path),
          getCursor: () => ({
            line: documentWindow.line,
            col: documentWindow.col,
          }),
          openFind: () => openFind(),
          openFindReplace: () => openFindReplace(),
          findNext: () => findNextMatch(),
          searchPanelOpen: () => isSearchOpen(),
          closeFind: () => closeFind(),
          setSearchInSelection: (on: boolean) => {
            if (editorView !== null) {
              setSearchInSelection(editorView, on);
            }
          },
          getSearchInSelection: () =>
            editorView !== null && getSearchInSelection(editorView),
          setDocSelection: (from: number, to: number) => {
            editorView?.dispatch({ selection: { anchor: from, head: to } });
          },
          getViewMode: () => activeViewMode,
          setViewMode: (m: ViewMode) => setViewMode(m),
          viewModeEntryCount: () => viewModes.size,
          activeContentLength: () => active?.content.length ?? 0,
          getTableCell: (r: number, c: number) => tableRows()[r]?.[c] ?? '',
          setTableCell: (r: number, c: number, v: string) => {
            tableRef?.deselect();
            emitTable(setCell(tableRows(), r, c, v));
          },
          tableDims: () => {
            const rows = tableRows();
            return {
              rows: rows.length,
              cols: rows.length > 0 ? widestRow(rows, 0) : 0,
            };
          },
          insertTableRow: (at: number) => {
            tableRef?.deselect();
            emitTable(insertRow(tableRows(), at));
          },
          deleteTableRow: (at: number) => {
            tableRef?.deselect();
            emitTable(deleteRow(tableRows(), at));
          },
          insertTableCol: (at: number) => {
            tableRef?.deselect();
            emitTable(insertCol(tableRows(), at));
          },
          deleteTableCol: (at: number) => {
            tableRef?.deselect();
            emitTable(deleteCol(tableRows(), at));
          },
          openTableMenu: (r: number, c: number) => {
            // Off-screen rows are scrolled into the window first, so this
            // resolves a frame later; automation polls `tableMenuOpen`.
            void tableRef?.openMenu(r, c);
          },
          tableMenuOpen: () => tableRef?.menuOpen() ?? false,
          selectRow: (r: number) => tableRef?.selectRow(r),
          selectCol: (c: number) => tableRef?.selectCol(c),
          selectAll: () => tableRef?.selectAll(),
          getSelection: () => tableRef?.getSelection() ?? null,
          copySelection: () => tableRef?.copySelection() ?? '',
          clearSelection: () => tableRef?.clearSelection(),
          deselect: () => tableRef?.deselect(),
          setHeaderRow: (on: boolean) => tableRef?.setHeaderRow(on),
          getHeaderRow: () => tableRef?.getHeaderRow() ?? false,
          tableUndo: () => tableUndo(),
          tableRedo: () => tableRedo(),
          largeConfirmVisible: () => documentWindow.pendingLargeOpen !== null,
          largeConfirmAccept: () => documentWindow.confirmLargeOpen(false),
          largeConfirmEdit: () => documentWindow.confirmLargeOpen(true),
          largeConfirmCancel: () => onLargeCancel(),
          longLineActive: () => longLineActive,
          longLineConfirmVisible: () =>
            documentWindow.pendingLongLineOpen !== null,
          longLineFormatAvailable: () =>
            documentWindow.pendingLongLineOpen?.formatAvailable ?? false,
          longLineConfirmAsIs: () => documentWindow.confirmLongLineOpen('asis'),
          longLineConfirmFormat: () =>
            documentWindow.confirmLongLineOpen('format'),
          longLineConfirmSoftWrap: () =>
            documentWindow.confirmLongLineOpen('softwrap'),
          longLineConfirmCancel: () => onLongLineCancel(),
          largeUnlockAvailable: () => activeLargeUnlockAvailable(),
          largeUnlockEdit: () => unlockActiveLarge(),
          isLargeTab: () => documentWindow.activeTab?.large !== undefined,
          largeInfo: () => ({
            size: documentWindow.activeTab?.large?.size ?? 0,
            totalLines: largeStatus.totalLines,
          }),
          largeVisibleFirstLine: () => largeStatus.firstLine,
          largeScrollToLine: (n: number) =>
            largeRef?.scrollToLine(n) ?? Promise.resolve(),
          largeVisibleText: () => largeRef?.visibleText() ?? '',
          largeGotoOpen: () => largeRef?.largeGotoOpen(),
          largeGotoVisible: () => largeRef?.largeGotoVisible() ?? false,
          largeGoto: (line: number) => largeRef?.largeGoto(line),
          largeSearchOpen: () => largeRef?.largeSearchOpen(),
          largeSearchVisible: () => largeRef?.largeSearchVisible() ?? false,
          largeSearch: (query: string, caseSensitive: boolean) =>
            largeRef?.largeSearch(query, caseSensitive),
          largeSearchResults: () => largeRef?.largeSearchResults() ?? [],
          largeSearchDone: () => largeRef?.largeSearchDone() ?? false,
          largeSearchJump: (index: number) => largeRef?.largeSearchJump(index),
          largeSearchClose: () => largeRef?.largeSearchClose(),
          largeSelectRange: (startLine: number, endLine: number) =>
            largeRef?.largeSelectRange(startLine, endLine),
          largeGetRange: () => largeRef?.largeGetRange() ?? null,
          largeRangeEdit: () => largeRef?.largeRangeEdit(),
          largeRangeSaveAs: (path: string) =>
            largeRef?.largeRangeSaveAs(path) ?? Promise.resolve(false),
          isRangeTab: () => documentWindow.isRangeTab(),
          rangeInfo: () => documentWindow.rangeInfo(),
          rangeSave: () => documentWindow.rangeSave(),
          rangeConflictVisible: () => documentWindow.rangeConflictVisible(),
          rangeConflictForce: () => documentWindow.rangeConflictForce(),
          rangeConflictSaveAs: (path: string) =>
            documentWindow.rangeConflictSaveAs(path),
          windowedConflictSaveAs: (path: string) =>
            documentWindow.windowedConflictSaveAs(path),
          rangeConflictCancel: () => documentWindow.rangeConflictCancel(),
          rangeSaveAsBytes: (path: string) =>
            documentWindow.saveRangeBytes(path),
          oversizedGateVisible: () => oversizedVisible,
          oversizedGateSave: () => oversizedSave(),
          oversizedGateDiscard: () => oversizedDiscard(),
          oversizedGateCancel: () => oversizedCancel(),
          windowedOpen: (path: string) => documentWindow.openWindowedTab(path),
          isWindowedTab: () => documentWindow.isWindowedTab(),
          windowedRestoreRescanned: () =>
            documentWindow.windowedRestoreRescanned(),
          windowedInfo: () => {
            const w = documentWindow.activeTab?.windowed;
            const view = windowedRef?.info() ?? null;
            return {
              windowStartLine: view?.windowStartLine ?? 0,
              totalLines: view?.totalLines ?? w?.totalLines ?? 0,
              totalBytes: view?.totalBytes ?? w?.totalBytes ?? 0,
              dirty: w?.dirty ?? false,
            };
          },
          windowedGoto: (line: number) => windowedRef?.goto(line),
          windowedTrace: () => windowedRef?.windowedTrace() ?? [],
          windowedUndo: () => windowedRef?.undo(),
          windowedRedo: () => windowedRef?.redo(),
          windowedSave: () => documentWindow.saveWindowedActive(),
          windowedSaveForce: () => documentWindow.saveWindowedForce(),
          windowedDiscard: () => documentWindow.discardWindowedActive(),
          windowedConflictVisible: () =>
            documentWindow.windowedConflictVisible(),
          setWorkerHighlight: (on: boolean) =>
            settingsState.setWorkerHighlight(on),
          getWorkerHighlight: () => isWorkerHighlightEnabled(),
          workerHighlightActive: () => isWorkerHighlightActive(),
          getLargeOpenMode: () => settingsState.largeOpenMode,
          setLargeOpenMode: (m: LargeOpenMode) =>
            settingsState.setLargeOpenMode(m),
          windowFocusGained: () => focusActiveEditor(),
        }),
      );
    }
    return () => {
      window.removeEventListener('keydown', onKeydown);
      unlistenTheme();
      void unlistenChanges.then((u) => u());
      void unlistenThemes.then((u) => u());
      void unlistenLocales.then((u) => u());
      void unlistenCloseFlush.then((u) => u());
      void unlistenMoved.then((u) => u());
      void unlistenResized.then((u) => u());
      void unlistenFocus.then((u) => u());
      void unlistenMenuClose.then((u) => u());
      void unlistenMenuAction.then((u) => u());
      void unlistenSwitchTab.then((u) => u());
      void unlistenCloseTab.then((u) => u());
      void unlistenOpenFile.then((u) => u());
      void unlistenSpliced.then((u) => u());
      void unlistenFlush.then((u) => u());
      void unlistenFlushCancelled.then((u) => u());
    };
  });
</script>

<svelte:window onkeydown={onWindowKeydown} />
<div class="app">
  <div class="tabbar" role="tablist">
    {#each documentWindow.tabs as tab, i (tab.id)}
      {@const lock = largeLock(tab)}
      <div
        class="tab"
        class:active={i === documentWindow.activeIndex}
        role="tab"
        tabindex="-1"
        aria-selected={i === documentWindow.activeIndex}
        title={tab.path}
        onclick={() => documentWindow.switchTo(i)}
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            void documentWindow.switchTo(i);
          }
        }}
      >
        {#if lock !== null || tab.readOnlyFile}
          <!-- Read-only status badge (a padlock BEFORE the name). For a large
               file the pencil after the name is the action that lifts it, and
               both disappear once the tab is unlocked into editing; a file the
               filesystem marks read-only gets the badge alone, because there is
               no such action to offer -- that lock is lifted outside the app.
               Carries its own tooltip so hovering it never surfaces the tab's
               file-path title. -->
          {@const readonlyLabel =
            lock !== null ? t('doc.tab.readonly') : t('doc.lock.readOnlyFile')}
          <span
            class="tab-readonly"
            title={readonlyLabel}
            role="img"
            aria-label={readonlyLabel}
          >
            <svg
              viewBox="0 0 24 24"
              width="11"
              height="11"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
          </span>
        {/if}
        <span class="tab-name"
          >{rangeDisplayName(tab) ?? tabName(tab.path)}</span
        >
        {#if documentWindow.isDirty(tab)}
          <span class="tab-dirty" title={t('doc.tab.unsaved')}>•</span>
        {/if}
        {#if lock !== null}
          <button
            class="tab-lock"
            class:disabled={lock.disabled}
            title={lock.title}
            aria-label={lock.title}
            disabled={lock.disabled}
            onclick={(e) => {
              e.stopPropagation();
              void unlockTab(i);
            }}
          >
            <!-- Pencil = "start editing" (an action, matching the 編輯 tooltip);
                 disabled states add a slash across it. A padlock read as a
                 status ("locked"), not as the action this button performs. -->
            <svg
              viewBox="0 0 24 24"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 3 22l1.5-4.5Z" />
              {#if lock.disabled}
                <path d="M2 2l20 20" />
              {/if}
            </svg>
          </button>
        {/if}
        <button
          class="tab-close"
          title={t('doc.tab.close')}
          aria-label={t('doc.tab.close')}
          onclick={(e) => {
            e.stopPropagation();
            void requestCloseTab(i);
          }}
        >
          <svg
            viewBox="0 0 24 24"
            width="11"
            height="11"
            fill="none"
            stroke="currentColor"
            stroke-width="2.4"
            stroke-linecap="round"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    {/each}
    <button
      class="tab-new"
      title={t('doc.tab.new')}
      aria-label={t('doc.tab.new')}
      onclick={() => documentWindow.newTab()}
    >
      <svg
        viewBox="0 0 24 24"
        width="13"
        height="13"
        fill="none"
        stroke="currentColor"
        stroke-width="2.4"
        stroke-linecap="round"
      >
        <path d="M12 5v14M5 12h14" />
      </svg>
    </button>
  </div>

  <main class="body">
    {#if documentWindow.ready && active !== null && active.windowed !== undefined}
      {#key active.windowed.sessionId}
        <WindowedEditor
          bind:this={windowedRef}
          sessionId={active.windowed.sessionId}
          initialTotalLines={active.windowed.totalLines}
          initialTopLine={active.windowed.initialLine ?? 0}
          dark={settingsState.isDark}
          fontSize={settingsState.editorFontSize}
          fontFamily={settingsState.editorFontFamily}
          wordWrap={settingsState.editorWordWrap}
          lineNumbers={settingsState.editorLineNumbers}
          modalOpen={anyModalOpen}
          onapplied={(totalBytes, totalLines) => {
            const t = documentWindow.activeTab;
            if (t?.windowed !== undefined) {
              documentWindow.windowedApplied(
                t.windowed.sessionId,
                totalBytes,
                totalLines,
              );
            }
          }}
          onstatus={(info) => {
            documentWindow.setCursor(info.line, info.col);
            documentWindow.windowedTopLineChanged(info.windowStartLine);
          }}
          onerror={(message) => (windowedError = message)}
        />
      {/key}
    {:else if documentWindow.ready && active !== null && active.large !== undefined}
      {#key `${active.id}:${documentWindow.largeReloadSeq}`}
        <LargeFileView
          bind:this={largeRef}
          path={active.path}
          size={active.large.size}
          fontSize={settingsState.editorFontSize}
          fontFamily={settingsState.editorFontFamily}
          onstatus={(s) => (largeStatus = s)}
          onextract={(info) => {
            const active = documentWindow.activeTab;
            return active !== null
              ? documentWindow.createRangeTab(active.path, info)
              : Promise.resolve(null);
          }}
          onsaverange={(info) => {
            const active = documentWindow.activeTab;
            return active !== null
              ? documentWindow.saveRangeAs(active.path, info)
              : Promise.resolve(false);
          }}
          onindexerror={() => (indexFailed = active?.path ?? null)}
        />
      {/key}
    {:else if documentWindow.ready && active !== null && active.windowedRestore === undefined}
      <!-- A `windowedRestore` tab with neither `windowed` nor `large` set yet is
           mid lazy-restore (see `beginWindowedRestore`): render nothing rather
           than this ordinary (empty-rope) editor for the fast path's one frame,
           or the read-only viewer for the slow path's grace period — both are
           handled by the branches above once the tab's fields catch up. -->
      <DocumentEditor
        activeId={active.id}
        content={active.content}
        language={active.language}
        dark={settingsState.isDark}
        fontSize={settingsState.editorFontSize}
        fontFamily={settingsState.editorFontFamily}
        wordWrap={settingsState.editorWordWrap}
        lineNumbers={settingsState.editorLineNumbers}
        modalOpen={anyModalOpen}
        {openIds}
        reloadSeq={documentWindow.reloadSeq}
        onchange={(v) => documentWindow.updateActiveContent(v)}
        onselection={(line, col) => documentWindow.setCursor(line, col)}
        onview={(v) => (editorView = v)}
        onlongline={(active) => (longLineActive = active)}
      />
      {#if showJson}
        <div class="table-overlay">
          <JsonView doc={active.content} dark={settingsState.isDark} />
        </div>
      {/if}
      {#if showXml}
        <div class="table-overlay">
          <XmlView doc={active.content} dark={settingsState.isDark} />
        </div>
      {/if}
      {#if showMarkdown}
        <div class="table-overlay">
          <!-- Keyed on the tab for the same reason as the table: the scroll
               container is otherwise shared and a new tab would inherit
               wherever the previous one was left. -->
          {#key active.id}
            <MarkdownView
              doc={active.content}
              dark={settingsState.isDark}
              baseDir={previewBaseDir}
              {registeredBase}
            />
          {/key}
        </div>
      {/if}
      {#if showTable && activeDelimiter !== null}
        <div class="table-overlay">
          <!-- Keyed on the tab: one instance per document. The scroll container
               is otherwise shared, so a new tab inherited wherever the previous
               one was left — opening a short file right after scrolling a long
               one landed at its bottom. Remounting also makes the header-row
               toggle per-tab, which is what it always claimed to be. -->
          {#key active.id}
            <TableView
              bind:this={tableRef}
              content={active.content}
              delimiter={activeDelimiter}
              dark={settingsState.isDark}
              onchange={(changes) => applyTableEdit(changes)}
              onundo={tableUndo}
              onredo={tableRedo}
              oncursor={(row, col) => documentWindow.setCursor(row, col)}
            />
          {/key}
        </div>
      {/if}
    {/if}
  </main>

  {#if active !== null}
    <StatusBar
      lineEnding={active.lineEnding}
      hadBom={active.hadBom}
      encoding={active.encoding}
      encodings={ENCODINGS}
      lossy={active.lossy}
      language={active.language}
      languages={languageNames}
      line={documentWindow.line}
      col={documentWindow.col}
      {modeOptions}
      viewMode={activeViewMode}
      large={largeBar}
      longLine={longLineStatus}
      onlineending={(ending) => documentWindow.setLineEnding(ending)}
      onencoding={(label) => documentWindow.setEncoding(label)}
      onlanguage={(name) => documentWindow.setActiveLanguage(name)}
      onviewmode={(mode) => setViewMode(mode)}
    />
  {/if}

  {#if showModal}
    <ConfirmModal
      message={t('dialog.saveBeforeClose')}
      primaryLabel={t('common.save')}
      secondaryLabel={t('dialog.dontSave')}
      cancelLabel={t('common.cancel')}
      onprimary={modalSave}
      onsecondary={modalDiscard}
      oncancel={modalCancel}
    />
  {/if}

  {#if documentWindow.openFailed !== null}
    <!-- No primary button: there is no action to offer, only the fact that the
         file was not opened. Reported rather than swallowed — a failed open
         used to present as a blank document. -->
    <ConfirmModal
      message={t('doc.openFailed', {
        name: tabName(documentWindow.openFailed),
      })}
      cancelLabel={t('common.close')}
      oncancel={onOpenFailedClose}
    />
  {/if}

  {#if documentWindow.encodingFailed !== null}
    <!-- Report only, like the failed open above: the tab keeps its previous
         content and encoding, there is only the fact to show. -->
    <ConfirmModal
      message={t('doc.encodingFailed', {
        name: tabName(documentWindow.encodingFailed),
      })}
      cancelLabel={t('common.close')}
      oncancel={onEncodingFailedClose}
    />
  {/if}

  {#if revealFailed !== null}
    <!-- Report only, like the failed open above: there is no action to offer
         once the file is gone from where the tab remembers it. -->
    <ConfirmModal
      message={t('doc.revealFailed', { name: tabName(revealFailed) })}
      cancelLabel={t('common.close')}
      oncancel={() => (revealFailed = null)}
    />
  {/if}

  {#if indexFailed !== null}
    <!-- Report only: the scan already failed in the background, there is
         nothing to retry from here. Line count and jump-to-line stay
         unavailable for this tab. -->
    <ConfirmModal
      message={t('large.index.failed', { name: tabName(indexFailed) })}
      cancelLabel={t('common.close')}
      oncancel={() => (indexFailed = null)}
    />
  {/if}

  {#if pendingLarge !== null}
    <ConfirmModal
      message={largeMessage}
      primaryLabel={t('settings.general.largeOpenModeView')}
      secondaryLabel={largeCanEdit
        ? t('settings.general.largeOpenModeEdit')
        : undefined}
      cancelLabel={t('common.cancel')}
      onprimary={() => documentWindow.confirmLargeOpen(false)}
      onsecondary={largeCanEdit
        ? () => documentWindow.confirmLargeOpen(true)
        : undefined}
      oncancel={onLargeCancel}
    />
  {/if}

  {#if pendingLongLine !== null}
    <ConfirmModal
      message={t('doc.longLine.confirm', {
        name: tabName(pendingLongLine.path),
      })}
      primaryLabel={t('doc.longLine.openAsIs')}
      secondaryLabel={pendingLongLine.formatAvailable
        ? t('doc.longLine.format')
        : undefined}
      tertiaryLabel={t('doc.longLine.softWrap')}
      cancelLabel={t('common.cancel')}
      onprimary={() => documentWindow.confirmLongLineOpen('asis')}
      onsecondary={pendingLongLine.formatAvailable
        ? () => documentWindow.confirmLongLineOpen('format')
        : undefined}
      ontertiary={() => documentWindow.confirmLongLineOpen('softwrap')}
      oncancel={onLongLineCancel}
    />
  {/if}

  {#if documentWindow.rangeConflict !== null}
    <ConfirmModal
      message={t('doc.rangeConflict.message')}
      primaryLabel={t('doc.conflict.writeAnyway')}
      secondaryLabel={t('doc.conflict.saveAsNew')}
      cancelLabel={t('common.cancel')}
      onprimary={() => void documentWindow.rangeConflictForce()}
      onsecondary={() => void documentWindow.rangeConflictSaveAs()}
      oncancel={() => documentWindow.rangeConflictCancel()}
    />
  {/if}

  {#if documentWindow.windowedConflict !== null}
    <ConfirmModal
      message={t('doc.windowedConflict.message')}
      primaryLabel={t('doc.conflict.writeAnyway')}
      secondaryLabel={t('doc.conflict.saveAsNew')}
      cancelLabel={t('common.cancel')}
      onprimary={() => void documentWindow.windowedConflictForce()}
      onsecondary={() => void documentWindow.windowedConflictSaveAs()}
      oncancel={() => documentWindow.windowedConflictCancel()}
    />
  {/if}

  {#if windowedError !== null}
    <div class="windowed-error" role="alert">
      <span>{windowedError}</span>
      <button
        class="windowed-error-close"
        title={t('common.close')}
        aria-label={t('common.close')}
        onclick={() => (windowedError = null)}>×</button
      >
    </div>
  {/if}

  {#if oversizedVisible}
    <ConfirmModal
      message={t(
        oversizedReason === 'unwritable'
          ? 'doc.snapshotFailed.message'
          : 'doc.oversized.message',
      )}
      primaryLabel={t('common.save')}
      secondaryLabel={t('doc.oversized.discard')}
      cancelLabel={t('common.cancel')}
      onprimary={() => void oversizedSave()}
      onsecondary={() => void oversizedDiscard()}
      oncancel={oversizedCancel}
    />
  {/if}

  {#if documentWindow.saveFailed !== null}
    <!-- Report only, and deliberately the last dialog in this section. Every
         ConfirmModal carries the same z-index, so DOM order alone decides which
         one is on top, and a failure reported from underneath the write-back
         conflict dialogs was invisible: the user saw the same conflict again
         with no word of why. The tab is left dirty by the caller either way, so
         there is nothing to offer beyond acknowledging the failure and
         returning to whatever is still open behind it. -->
    <ConfirmModal
      message={documentWindow.saveFailed.error === READ_ONLY_DESTINATION
        ? t('doc.saveReadOnly', {
            name: tabName(documentWindow.saveFailed.path),
          })
        : t('doc.saveFailed', {
            name: tabName(documentWindow.saveFailed.path),
            error: documentWindow.saveFailed.error,
          })}
      cancelLabel={t('common.close')}
      oncancel={() => documentWindow.dismissSaveFailed()}
    />
  {/if}
</div>

<style>
  .app {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
    --modal-surface: var(--bg);
    --modal-fg: var(--fg);
    --modal-accent: var(--accent);
    --modal-border: var(--topbar-border);
    --modal-hover: var(--topbar-border);
  }
  .tabbar {
    display: flex;
    align-items: stretch;
    flex: 0 0 auto;
    height: 30px;
    overflow-x: auto;
    overflow-y: hidden;
    border-bottom: 1px solid var(--topbar-border);
    scrollbar-width: thin;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0 0.4rem 0 0.7rem;
    max-width: 200px;
    border-right: 1px solid var(--topbar-border);
    font-size: 0.78rem;
    white-space: nowrap;
    cursor: default;
    opacity: 0.7;
  }
  .tab:hover {
    opacity: 0.9;
  }
  .tab.active {
    opacity: 1;
    background: var(--topbar-border);
  }
  .tab-name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tab-dirty {
    color: #e0a500;
    font-size: 1rem;
    line-height: 1;
  }
  /* Padlock on a read-only large-file tab: click unlocks the file for in-place
     editing. Dimmed and non-clickable when editing is unavailable (oversized or
     non-UTF-8). Disappears once the tab is unlocked (it looks like any tab then). */
  .tab-lock {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: none;
    background: none;
    color: inherit;
    opacity: 0.65;
    cursor: default;
  }
  .tab-lock:hover:not(:disabled) {
    opacity: 1;
    color: var(--accent);
  }
  .tab-lock:disabled {
    opacity: 0.3;
  }
  /* Read-only status badge before the tab name. Receives pointer events so its
     own 唯讀 tooltip shows instead of the tab's file-path title. */
  .tab-readonly {
    display: flex;
    align-items: center;
    opacity: 0.55;
  }
  .tab-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: none;
    color: inherit;
    opacity: 0.6;
    cursor: default;
  }
  .tab-close:hover {
    opacity: 1;
    color: var(--danger);
    background: rgba(127, 127, 127, 0.3);
  }
  .tab-new {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 30px;
    padding: 0;
    border: none;
    background: none;
    color: inherit;
    opacity: 0.6;
    cursor: default;
  }
  .tab-new:hover {
    opacity: 1;
    background: rgba(127, 127, 127, 0.3);
  }
  .body {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
  }
  /* The table view overlays the (still-mounted) CodeMirror editor so its
     per-tab state survives a view toggle. */
  .table-overlay {
    position: absolute;
    inset: 0;
    z-index: 1;
  }
  /* Locked-editor banner: a windowed apply/read failed, so the buffer no longer
     matches the file. Docked at the top, above the editor. */
  .windowed-error {
    position: absolute;
    top: 34px;
    left: 8px;
    right: 8px;
    z-index: 4;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--danger);
    border-radius: 6px;
    background: var(--bg);
    color: var(--danger);
    font-size: 0.8rem;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  }
  .windowed-error span {
    flex: 1 1 auto;
  }
  .windowed-error-close {
    flex: 0 0 auto;
    border: none;
    background: none;
    color: inherit;
    font-size: 1rem;
    line-height: 1;
    cursor: default;
  }
</style>
