<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { save } from '@tauri-apps/plugin-dialog';
  import EditorShell from './lib/editor/EditorShell.svelte';
  import ConfirmModal from './lib/ConfirmModal.svelte';
  import {
    stickyNote,
    type PinMode,
    type NoteSnapshot,
  } from './lib/state/stickyNote.svelte';
  import { settingsState } from './lib/state/settings.svelte';
  import { platform } from './lib/state/platform.svelte';
  import { shouldFloatOnTop } from './lib/util/pinFloat';
  import { matchStickyShortcut } from './lib/util/stickyShortcut';
  import { revealWhenThemed } from './lib/util/reveal';
  import { nextSeq } from './lib/util/seq';
  import { applyTheme, applyChrome } from './lib/theme/applyTheme';
  import { themeRegistry } from './lib/theme/themeRegistry.svelte';
  import { localeRegistry } from './lib/i18n/localeRegistry.svelte';
  import { focusEditorIfIdle } from './lib/util/editorFocus';
  import { t } from './lib/i18n';
  import { debounce } from './lib/util/debounce';
  import { saveDialogOptions } from './lib/util/saveDialog';
  import { READ_ONLY_DESTINATION } from './lib/util/protocol';
  import { fileName } from './lib/util/filePath';
  import { isEditAction } from './lib/util/menuBar';
  import {
    editorCopy,
    editorCut,
    editorPaste,
  } from './lib/util/editorClipboard';
  import type { EditorView } from '@codemirror/view';
  import { undo, redo, selectAll } from '@codemirror/commands';
  import {
    openSearchPanel,
    closeSearchPanel,
    findNext,
    findPrevious,
    searchPanelOpen,
  } from '@codemirror/search';

  interface RunningApp {
    name: string;
    // Platform-neutral identity: bundle id (macOS), exe path (Windows),
    // WM_CLASS (Linux). Stored verbatim in the note's pin_app.
    id: string;
  }

  const win = getCurrentWindow();
  const noteId = new URLSearchParams(window.location.search).get('note') ?? '';
  let showModal = $state(false);
  // Set when the write in saveAndConvert rejects, so the failure is reported
  // rather than leaving the close-confirmation dialog stuck open with no
  // feedback. The note stays sticky (unconverted) and dirty; the user can try
  // again or discard from the still-open dialog underneath. The picked file's
  // name rides along so a refused destination can be named the way the document
  // window names it, instead of the message carrying a bare protocol string.
  let saveFailed = $state<{ name: string; error: string } | null>(null);
  // Set once the app-level quit handshake starts (`flush-request` from the
  // backend's `flush_then_exit`; see the listener below), cleared again if a
  // window vetoes the quit (`flush-cancelled`, also below). Invariant: while
  // true, quit is always silent, so the sticky must never show its
  // save-confirmation modal — closing one window with the X still asks, but
  // a quit never does. `flush-request` only means the handshake *started*,
  // not that exit is guaranteed, so this is not a one-way latch.
  let quitting = false;
  // Toolbar palette popover and slider-drag state keep the strip revealed while
  // the user interacts with either, even after the pointer leaves the card.
  let showSwatches = $state(false);
  let sliderActive = $state(false);
  let showPinMenu = $state(false);
  let runningApps = $state<RunningApp[]>([]);

  const pinMode = $derived(stickyNote.note?.pin_mode ?? 'none');
  const pinApp = $derived(stickyNote.note?.pin_app ?? null);

  // Fixed paper palette; order is the swatch-row order. graphite is the only
  // dark surface (drives the oneDark editor theme).
  const PAPERS = ['classic', 'white', 'pink', 'blue', 'green', 'graphite'];
  const paper = $derived(stickyNote.note?.paper ?? 'classic');

  function pickPaper(name: string): void {
    stickyNote.setPaper(name);
    // The last picked paper becomes the default for new stickies.
    showSwatches = false;
  }

  // Reflect the resolved theme onto the document root. The sticky card itself
  // is unaffected (its paper colors are independent `--sticky-*` variables),
  // but shared chrome like the danger-red close hover reads the app theme.
  $effect(() => {
    applyTheme(settingsState.themeId);
    applyChrome(settingsState.interfaceMode, settingsState.prefersDark);
  });

  // Apply a pin mode: persist it and set the window's float state. "app" starts
  // un-floated; the backend app-watch poller raises it when its app is frontmost.
  async function applyPin(
    mode: PinMode,
    app: string | null = null,
  ): Promise<void> {
    if (stickyNote.note === null) {
      return;
    }
    // On Wayland the follow-along poller never runs, so an app-pin must float
    // now (matching the Rust create_sticky_window rule); where tracking works
    // it starts un-floated and the poller decides.
    await win.setAlwaysOnTop(shouldFloatOnTop(mode, platform.isLinuxWayland));
    stickyNote.setPinMode(mode, app);
    showPinMenu = false;
  }

  // The pin icon itself toggles the simple none <-> top float.
  function togglePin(): void {
    void applyPin(pinMode === 'top' ? 'none' : 'top');
  }

  async function openPinMenu(): Promise<void> {
    showPinMenu = !showPinMenu;
    if (showPinMenu) {
      runningApps = await invoke<RunningApp[]>('list_running_apps');
    }
  }

  async function onOpacity(e: Event): Promise<void> {
    const value = Number((e.currentTarget as HTMLInputElement).value);
    await invoke('set_window_opacity', { value });
    stickyNote.setOpacity(value);
  }

  // Save to a real file, convert the store entry from sticky to document (same
  // id, so the saved doc reopens on restart), then open a real document window
  // for it and drop this sticky window.
  // Re-entrancy guard: this is reachable from the menu event, the workspace
  // row action and the Linux keydown handler below, so two calls can overlap.
  // `savingInFlight` makes the second one a no-op instead of opening two save
  // dialogs.
  let savingInFlight = false;
  // Returns whether the note was actually saved and converted: false on a
  // re-entrant call or a cancelled save dialog, so callers that must resume
  // something afterward (the quit gate below) know not to.
  async function saveAndConvert(): Promise<boolean> {
    if (savingInFlight) {
      return false;
    }
    savingInFlight = true;
    try {
      const note = stickyNote.note;
      if (note === null) {
        return false;
      }
      const path = await save(saveDialogOptions(note.language, 'Untitled'));
      if (path === null) {
        return false;
      }
      try {
        await invoke('write_file', { path, content: note.content });
      } catch (e) {
        // The note stays sticky and dirty; report the failure instead of
        // leaving the close-confirmation dialog stuck with no feedback. The
        // `false` also tells the quit gate the note is still unsaved, so the
        // quit stays vetoed rather than resuming on a write that never landed.
        saveFailed = { name: fileName(path) || path, error: String(e) };
        return false;
      }
      stickyNote.discard();
      // The converted document becomes a fresh single-tab window; its group id
      // is the note's own id so the entry regroups cleanly on restart.
      const docNote: NoteSnapshot = {
        ...note,
        file_path: path,
        pin_mode: 'none',
        pin_app: null,
        kind: 'document',
        dirty: false,
        window_group: note.id,
        tab_index: 0,
      };
      await invoke('upsert_note', { note: docNote, seq: nextSeq() });
      showModal = false;
      // Open a real `doc-` window and destroy this one, rather than navigating
      // this window in place. Every document behavior — the close handshake,
      // the menu's focus kind, the workspace's open-document list — is keyed
      // off the window label's `doc-` prefix, which an in-place navigation
      // cannot change. Worse, the sticky's own close-requested listener stays
      // registered on the Rust side across a page navigation, so the OS close
      // button would be intercepted by a handler the new page no longer has:
      // the window could never be closed at all. destroy() bypasses that
      // handler; the new window is created first so the screen is never empty.
      await invoke('open_document_group', { group: note.id });
      await win.destroy();
      return true;
    } finally {
      savingInFlight = false;
    }
  }

  async function discardAndDestroy(): Promise<void> {
    stickyNote.discard();
    const note = stickyNote.note;
    if (note !== null) {
      await invoke('delete_note', { id: note.id });
    }
    await win.destroy();
  }

  // Snapshot-write-failure quit gate: this note's content could not be saved
  // to the recovery snapshot and would be silently lost if the app exits now.
  // Raised by the flush-request handler below (see its own comment), which
  // has already vetoed the quit via `flush_cancel`; save or discard resumes
  // it. Same shape as the document window's oversized gate: cancel just
  // dismisses the gate, leaving the quit vetoed until retried.
  let quitGateVisible = $state(false);

  async function quitGateSave(): Promise<void> {
    if (await saveAndConvert()) {
      await invoke('request_exit');
    }
  }

  async function quitGateDiscard(): Promise<void> {
    await discardAndDestroy();
    await invoke('request_exit');
  }

  function quitGateCancel(): void {
    quitGateVisible = false;
  }

  // Empty notes vanish silently; notes with content prompt before discarding.
  // While the app is quitting this is a no-op: the flush-request handshake
  // (see the listener below) already flushes this window's content to a
  // snapshot, and the process is about to exit outright, so there is nothing
  // left to discard or destroy here — showing the modal would be wrong. Same
  // while the quit gate above is up: it owns save/discard for this window
  // until it resolves.
  function requestClose(): void {
    if (quitting || quitGateVisible) {
      return;
    }
    if (stickyNote.isEmpty) {
      void discardAndDestroy();
    } else {
      showModal = true;
    }
  }

  function onEditorChange(v: string): void {
    stickyNote.updateContent(v);
  }

  // The sticky's CodeMirror view, supplied by EditorShell so find commands run
  // against the real editor. Stickies are find-only (no Find and Replace).
  let editorView: EditorView | null = null;

  function openFind(): void {
    if (editorView !== null) {
      openSearchPanel(editorView);
    }
  }

  function findNextMatch(): void {
    if (editorView !== null) {
      findNext(editorView);
    }
  }

  function findPrevMatch(): void {
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

  // Menu accelerators arrive from the Rust menu as a string payload. Save routes
  // to the sticky's save-and-convert flow; find actions drive the search panel.
  // New Tab, Open and Find and Replace never reach an enabled sticky menu item,
  // so they are ignored here.
  function runMenuAction(action: string): void {
    if (isEditAction(action) && editorView !== null) {
      const view = editorView;
      switch (action) {
        case 'undo':
          undo(view);
          break;
        case 'redo':
          redo(view);
          break;
        case 'select-all':
          selectAll(view);
          break;
        case 'copy':
          editorCopy(view);
          break;
        case 'cut':
          void editorCut(view);
          break;
        case 'paste':
          void editorPaste(view);
          break;
      }
      return;
    }
    switch (action) {
      case 'save':
        void saveAndConvert();
        break;
      case 'find':
        openFind();
        break;
      case 'find-next':
        findNextMatch();
        break;
      case 'find-prev':
        findPrevMatch();
        break;
    }
  }

  // Linux and Windows only. On Linux a sticky has no menu at all —
  // `detach_menu_unless_document` in windows.rs removes the inherited bar
  // outright — so nothing dispatches its Quit/Close/Save/Find accelerators
  // and this handler is the only source of all four. On Windows the menu
  // accelerators dispatch app-wide via the menu's HACCEL regardless of the
  // drawn bar, so save/close/find already work there; only Quit does not
  // (see `matchStickyShortcut`'s platform policy), which is why this handler
  // stays wired for Windows too. macOS gets everything from the real system
  // menu bar, so this is a no-op there. Checked against
  // `event.defaultPrevented` so it never double-fires Ctrl+F: the editor's
  // own `searchKeymap` (Editor.svelte) already binds Mod-f and calls
  // preventDefault when focus is inside the editor; this only picks up the
  // case where focus is elsewhere and CodeMirror never saw the key.
  // `matchStickyShortcut` requires Ctrl as the *sole* modifier, so this never
  // intercepts Ctrl+Shift+S (save-as), Ctrl+Alt+F (find-replace), or an
  // AltGr keypress (reported as ctrlKey+altKey) — see its own doc comment.
  // On Windows, if the native menu accelerator also fires Quit, this would
  // invoke `request_exit` a second time; `QUIT_IN_FLIGHT` on the backend
  // already makes the second call a no-op, so this is safe either way.
  function onStickyKeydown(event: KeyboardEvent): void {
    if ((!platform.isLinux && !platform.isWindows) || event.defaultPrevented) {
      return;
    }
    const shortcut = matchStickyShortcut(event, platform.os);
    if (shortcut === null) {
      return;
    }
    event.preventDefault();
    switch (shortcut) {
      case 'quit':
        void invoke('request_exit');
        break;
      case 'close':
        requestClose();
        break;
      case 'save':
        runMenuAction('save');
        break;
      case 'find':
        openFind();
        break;
    }
  }

  onMount(() => {
    void stickyNote.init(noteId);
    void platform.init();
    const unlistenTheme = settingsState.listen();
    const unlistenChanges = settingsState.listenChanges();
    const unlistenThemes = themeRegistry.listen();
    const unlistenLocales = localeRegistry.listen();
    // Reveal the window only after the theme is loaded and applied, so a
    // dark-theme window never flashes its default white background.
    void revealWhenThemed();

    // Persist logical bounds after the user finishes moving or resizing.
    const captureBounds = debounce(() => {
      void (async (): Promise<void> => {
        const scale = await win.scaleFactor();
        const pos = (await win.outerPosition()).toLogical(scale);
        const size = (await win.innerSize()).toLogical(scale);
        stickyNote.setBounds(pos.x, pos.y, size.width, size.height);
      })();
    }, 300);

    let closing = false;
    const unlistenClose = win.onCloseRequested(async (event) => {
      if (closing) {
        return;
      }
      if (quitting || quitGateVisible) {
        // A quit handshake is in flight (or vetoed and waiting on the gate):
        // still prevent the OS from destroying this webview outright.
        // `app.exit(0)` (in the backend's `flush_then_exit`) tears every
        // window down once every ack has arrived, so preventing this close
        // costs nothing — and skipping it would let the 3rd+ window of a
        // batch close be destroyed while its `flush_ack` IPC is still in
        // flight, stalling the whole quit.
        event.preventDefault();
        return;
      }
      event.preventDefault();
      // Empty notes are torn down here; otherwise defer to the modal.
      if (stickyNote.isEmpty) {
        closing = true;
        await discardAndDestroy();
      } else {
        showModal = true;
      }
    });
    const unlistenMoved = win.onMoved(() => captureBounds());
    const unlistenResized = win.onResized(() => captureBounds());

    // When the window regains OS focus, keyboard focus can be left on BODY (the
    // WebView then silently drops keystrokes); hand it back to the editor unless
    // the close dialog or an input field is holding it.
    const unlistenFocus = win.onFocusChanged(({ payload: focused }) => {
      if (focused) {
        focusEditorIfIdle(editorView, showModal);
      }
    });

    // Cmd+W (routed from the app menu) closes this sticky, matching its own flow.
    const unlistenMenuClose = win.listen('menu-close', () => requestClose());

    // File/Edit menu accelerators arrive here as a single string payload.
    const unlistenMenuAction = win.listen<string>('menu-action', (event) =>
      runMenuAction(event.payload),
    );

    // Workspace sticky-row hover buttons route back here so save/close run the
    // sticky's own flows instead of being reimplemented in the workspace.
    const unlistenRowAction = win.listen<string>(
      'workspace-sticky-action',
      (e) => {
        if (e.payload === 'save') {
          void saveAndConvert();
        } else if (e.payload === 'close') {
          requestClose();
        }
      },
    );

    const onBeforeUnload = (): void => {
      void stickyNote.flush();
    };
    // Quit handshake: `flush-request` is only ever emitted by the backend's
    // `flush_then_exit`, meaning a quit handshake has started (not that it
    // will complete — see `quitting`'s own comment). Silence (and dismiss, if
    // already open) the save-confirmation modal, then flush pending edits and
    // ack so the backend may proceed to exit.
    const unlistenFlush = win.listen('flush-request', async () => {
      quitting = true;
      showModal = false;
      await stickyNote.flush();
      // The flush above is the only place a write is actually attempted, so a
      // failure is only known now. A note with unsnapshotted content would be
      // silently lost on exit; veto the quit and raise the same save-or-discard
      // gate the oversized document tab uses, instead of letting it through.
      if (stickyNote.snapshotFailed && !stickyNote.isEmpty) {
        await invoke('flush_cancel');
        quitGateVisible = true;
        // The gate may belong to a background sticky (quit asks every window
        // at once); raise it or the user sees no reaction to their quit at all.
        await win.setFocus();
        return;
      }
      await invoke('flush_ack', { label: win.label });
    });
    // Companion to `flush-request`: the backend emits this when a document
    // window vetoes the quit (oversized unsaved tab). The handshake never
    // completes, so undo the latch — Ctrl+W, the workspace close button, and
    // the X must all work normally again.
    const unlistenFlushCancelled = win.listen('flush-cancelled', () => {
      quitting = false;
    });
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('keydown', onStickyKeydown);
    // DEV-only automation hook; dynamic import keeps it out of production.
    if (import.meta.env.DEV) {
      void import('./lib/dev/auto').then((m) =>
        m.installStickyAuto({
          getTitle: () => (stickyNote.note?.content ?? '').split('\n')[0] ?? '',
          clickPin: togglePin,
          setPaper: pickPaper,
          openCloseFlow: requestClose,
          openFind: () => openFind(),
          findNext: () => findNextMatch(),
          searchPanelOpen: () => isSearchOpen(),
          closeFind: () => closeFind(),
        }),
      );
    }
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('keydown', onStickyKeydown);
      unlistenTheme();
      void unlistenChanges.then((u) => u());
      void unlistenThemes.then((u) => u());
      void unlistenLocales.then((u) => u());
      void unlistenClose.then((u) => u());
      void unlistenMoved.then((u) => u());
      void unlistenResized.then((u) => u());
      void unlistenFocus.then((u) => u());
      void unlistenMenuClose.then((u) => u());
      void unlistenMenuAction.then((u) => u());
      void unlistenRowAction.then((u) => u());
      void unlistenFlush.then((u) => u());
      void unlistenFlushCancelled.then((u) => u());
    };
  });
</script>

<div class="sticky paper-{paper}">
  <div
    class="toolbar"
    class:active={sliderActive || showSwatches || showPinMenu}
    data-tauri-drag-region
  >
    <span class="pin-group">
      <button
        class="tool pin"
        class:pinned={pinMode === 'top'}
        class:app-pinned={pinMode === 'app'}
        title={pinMode === 'top'
          ? t('sticky.pin.unpin')
          : pinMode === 'app'
            ? t('sticky.pin.pinnedApp')
            : t('sticky.pin.onTop')}
        aria-label={pinMode === 'top'
          ? t('sticky.pin.unpin')
          : pinMode === 'app'
            ? t('sticky.pin.pinnedApp')
            : t('sticky.pin.onTop')}
        onclick={togglePin}
      >
        <svg
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M9 4h6M10 4l-1 6-3 2v1h12v-1l-3-2-1-6M12 16v4" />
        </svg>
        {#if pinMode === 'app'}
          <span class="app-dot" aria-hidden="true"></span>
        {/if}
      </button>
      <button
        class="tool chevron"
        title={t('sticky.pin.options')}
        aria-label={t('sticky.pin.options')}
        onclick={openPinMenu}
      >
        <svg
          viewBox="0 0 24 24"
          width="10"
          height="10"
          fill="none"
          stroke="currentColor"
          stroke-width="2.4"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {#if showPinMenu}
        <div class="pin-menu">
          <button
            class="pin-item"
            class:current={pinMode === 'top'}
            onclick={() => applyPin('top')}
          >
            {t('sticky.pin.alwaysOnTop')}
          </button>
          <div class="pin-sep"></div>
          <div class="pin-heading">{t('sticky.pin.toApp')}</div>
          {#each runningApps as app (app.id)}
            <button
              class="pin-item"
              class:current={pinMode === 'app' && pinApp === app.id}
              onclick={() => applyPin('app', app.id)}
            >
              {app.name}
            </button>
          {/each}
          <div class="pin-sep"></div>
          <button
            class="pin-item"
            class:current={pinMode === 'none'}
            onclick={() => applyPin('none')}
          >
            {t('sticky.pin.unpin')}
          </button>
        </div>
      {/if}
    </span>
    <button
      class="tool palette"
      title={t('sticky.paperColor')}
      aria-label={t('sticky.paperColor')}
      onclick={() => (showSwatches = !showSwatches)}
    >
      <svg
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path
          d="M12 3a9 9 0 0 0 0 18c1 0 1.5-.8 1.5-1.6 0-1.4 1.1-2 2.2-2H18a3 3 0 0 0 3-3 8.4 8.4 0 0 0-9-8.4z"
        />
        <circle cx="7.5" cy="11" r="1" fill="currentColor" stroke="none" />
        <circle cx="12" cy="8" r="1" fill="currentColor" stroke="none" />
        <circle cx="16" cy="11" r="1" fill="currentColor" stroke="none" />
      </svg>
    </button>
    {#if showSwatches}
      <div class="swatches">
        {#each PAPERS as name (name)}
          <button
            class="swatch paper-{name}"
            class:current={paper === name}
            title={name}
            aria-label={name}
            onclick={() => pickPaper(name)}
          ></button>
        {/each}
      </div>
    {/if}
    <span class="opacity-group">
      <span class="drop" aria-hidden="true" title={t('sticky.opacity')}>
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" />
        </svg>
      </span>
      <input
        class="opacity"
        type="range"
        min="0.3"
        max="1"
        step="0.05"
        value={stickyNote.note?.opacity ?? 1}
        title={t('sticky.opacity')}
        oninput={onOpacity}
        onpointerdown={() => (sliderActive = true)}
        onpointerup={() => (sliderActive = false)}
        onpointercancel={() => (sliderActive = false)}
      />
    </span>
    <button
      class="tool close"
      title={t('common.close')}
      aria-label={t('common.close')}
      onclick={requestClose}
    >
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
      >
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  </div>
  <main class="body">
    {#if stickyNote.note !== null}
      <EditorShell
        value={stickyNote.note.content}
        language={stickyNote.note.language}
        dark={paper === 'graphite'}
        minimal={true}
        onchange={onEditorChange}
        onview={(v) => {
          editorView = v;
          // Claim keyboard focus on load so a freshly opened sticky types
          // without a click; idle-gated so it never steals from a dialog.
          if (v !== null) {
            focusEditorIfIdle(v, showModal);
          }
        }}
      />
    {/if}
  </main>

  {#if showModal}
    <ConfirmModal
      message={t('dialog.saveBeforeClose')}
      primaryLabel={t('common.save')}
      secondaryLabel={t('dialog.dontSave')}
      cancelLabel={t('common.cancel')}
      onprimary={() => void saveAndConvert()}
      onsecondary={discardAndDestroy}
      oncancel={() => (showModal = false)}
    />
  {/if}

  {#if quitGateVisible}
    <ConfirmModal
      message={t('sticky.snapshotFailed.message')}
      primaryLabel={t('common.save')}
      secondaryLabel={t('dialog.dontSave')}
      cancelLabel={t('common.cancel')}
      onprimary={() => void quitGateSave()}
      onsecondary={() => void quitGateDiscard()}
      oncancel={quitGateCancel}
    />
  {/if}

  {#if saveFailed !== null}
    <!-- Report only, layered on top of the close-confirmation dialog: the note
         stays sticky and dirty, so there is no action to offer beyond
         acknowledging the failure. -->
    <ConfirmModal
      message={saveFailed.error === READ_ONLY_DESTINATION
        ? t('sticky.saveReadOnly', { name: saveFailed.name })
        : t('sticky.saveFailed', { error: saveFailed.error })}
      cancelLabel={t('common.close')}
      oncancel={() => (saveFailed = null)}
    />
  {/if}
</div>

<style>
  .sticky {
    position: relative;
    height: 100vh;
    overflow: hidden;
    border-radius: 10px;
    background: linear-gradient(var(--sticky-bg-top), var(--sticky-bg));
    color: var(--sticky-fg);
    --modal-surface: linear-gradient(var(--sticky-bg-top), var(--sticky-bg));
    --modal-fg: var(--sticky-fg);
    --modal-accent: var(--sticky-accent);
    --modal-border: var(--sticky-track);
    --modal-hover: var(--sticky-scrim);
  }
  .toolbar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    gap: 0.3rem;
    height: 28px;
    padding: 0 6px;
    border-radius: 10px 10px 0 0;
    background: var(--sticky-scrim);
    color: var(--sticky-fg);
    opacity: 0;
    transition: opacity 0.15s ease;
    z-index: 2;
  }
  .sticky:hover .toolbar,
  .toolbar.active {
    opacity: 1;
  }
  .tool {
    appearance: none;
    -webkit-appearance: none;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    background: none;
    border: none;
    color: currentColor;
    cursor: default;
    opacity: 0.55;
    transition:
      opacity 0.12s ease,
      transform 0.12s ease,
      color 0.12s ease;
  }
  .tool:hover {
    opacity: 1;
  }
  .pin.pinned {
    opacity: 1;
    color: var(--sticky-accent);
    transform: rotate(40deg);
  }
  .pin.pinned svg {
    fill: currentColor;
  }
  .pin.app-pinned {
    opacity: 1;
    color: var(--sticky-accent);
  }
  .pin.app-pinned svg {
    fill: currentColor;
  }
  .pin-group {
    position: relative;
    display: flex;
    align-items: center;
  }
  .pin {
    position: relative;
  }
  .app-dot {
    position: absolute;
    right: -1px;
    bottom: -1px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--sticky-accent);
  }
  .chevron {
    margin-left: -1px;
  }
  .pin-menu {
    position: absolute;
    top: 22px;
    left: 0;
    z-index: 4;
    display: flex;
    flex-direction: column;
    min-width: 130px;
    max-height: 220px;
    overflow-y: auto;
    padding: 3px;
    border-radius: 6px;
    background: linear-gradient(var(--sticky-bg-top), var(--sticky-bg));
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.28);
  }
  .pin-item {
    appearance: none;
    -webkit-appearance: none;
    display: block;
    width: 100%;
    padding: 4px 7px;
    border: none;
    border-radius: 4px;
    background: none;
    color: inherit;
    font-size: 12px;
    text-align: left;
    white-space: nowrap;
    cursor: default;
  }
  .pin-item:hover {
    background: var(--sticky-scrim);
  }
  .pin-item.current {
    color: var(--sticky-accent);
    font-weight: 600;
  }
  .pin-heading {
    padding: 3px 7px 1px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.55;
  }
  .pin-sep {
    height: 1px;
    margin: 3px 4px;
    background: var(--sticky-track);
  }
  .swatches {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .swatch {
    appearance: none;
    -webkit-appearance: none;
    width: 12px;
    height: 12px;
    padding: 0;
    border-radius: 50%;
    border: 1px solid rgba(0, 0, 0, 0.2);
    background: var(--sticky-bg);
    cursor: default;
  }
  .swatch.current {
    box-shadow: 0 0 0 2px var(--sticky-accent);
  }
  .opacity-group {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: auto;
  }
  .drop {
    display: flex;
    opacity: 0.55;
  }
  .opacity {
    -webkit-appearance: none;
    appearance: none;
    width: 56px;
    height: 10px;
    background: transparent;
    cursor: default;
  }
  .opacity::-webkit-slider-runnable-track {
    height: 2px;
    border-radius: 1px;
    background: var(--sticky-track);
  }
  .opacity::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 10px;
    height: 10px;
    margin-top: -4px;
    border-radius: 50%;
    background: var(--sticky-accent);
  }
  .close {
    width: 18px;
    height: 18px;
    border-radius: 50%;
  }
  .close:hover {
    opacity: 1;
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 15%, transparent);
  }
  .body {
    position: absolute;
    /* Content always starts below the toolbar strip so no text is ever covered. */
    inset: 28px 0 0 0;
    z-index: 1;
  }
</style>
