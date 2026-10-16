<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import {
    Annotation,
    Compartment,
    EditorState,
    Transaction,
    type Extension,
    type Text,
    type TransactionSpec,
  } from '@codemirror/state';
  import {
    EditorView,
    lineNumbers,
    highlightActiveLineGutter,
    highlightActiveLine,
    highlightSpecialChars,
    drawSelection,
    dropCursor,
    keymap,
    runScopeHandlers,
    type Command,
    type ViewUpdate,
  } from '@codemirror/view';
  import { toggleTabFocusMode } from '@codemirror/commands';
  import { varEditorTheme } from '../editor/editorTheme';
  import { buildKeymap, keymapExtension } from '../editor/keymap';
  import {
    settleThenDrain,
    settleViewComposition,
  } from '../editor/composition';
  import { cmPhraseExtension } from '../editor/cmPhrases';
  import { shortcutsState } from '../state/shortcuts.svelte';
  import { platform } from '../state/platform.svelte';
  import { cssFontFamily } from '../util/font';
  import {
    applyBreaks,
    byteLength,
    byteToChar,
    charToByte,
    decideNewGroup,
    detectBreakStyle,
    fullyVisibleLineSpan,
    mapChangesToEdits,
    nextWindow,
    rejectDuringSwap,
    replaceBreaks,
    scanBreaks,
    type RawChange,
    WINDOW_LINES,
    MARGIN_LINES,
    SWAP_THRESHOLD_LINES,
  } from '../util/windowedEdit';
  import {
    fitsWindow,
    gotoSelection,
    insideWindow,
    isImeKey,
    replayKind,
    selectionAfterChange,
    selectionAfterSwap,
    toGlobalSelection,
    windowStartFor,
    type LinePos,
    type LineSelection,
  } from '../util/windowSelection';
  import {
    chordReplaysAtEdge,
    copiedRange,
    coreKeyBindings,
    decideKey,
    linewiseAfterCopy,
    pasteIsLinewise,
    pasteSpec,
    replayWanted as replayStateWanted,
    type AltGrTable,
    type KeyLayers,
    type ReplayState,
  } from '../util/replayKeys';
  import { focusEditorIfIdle } from '../util/editorFocus';
  import { readCspNonce } from '../util/cspNonce';
  import { parseGotoRange, moveResultCursor } from '../util/largeSearch';
  import {
    endOfMatch,
    formatReplaced,
    gotoRangeSelection,
    hitSelection,
    orderedPositions,
    textMatchesQuery,
    type FindHit,
  } from '../util/windowedFind';
  import type { OpGate } from '../util/windowedGate';
  import { matchWindowShortcut } from '../util/windowShortcut';
  import FindPanels, { type FindResult } from '../large/FindPanels.svelte';
  import { t } from '../i18n';

  /** Result of a Rust `windowed_read`: the window text plus its global byte span,
   *  its starting (0-based) line, and the live file totals. */
  interface WindowRead {
    text: string;
    start_offset: number;
    end_offset: number;
    start_line: number;
    total_lines: number;
    total_bytes: number;
  }

  /** Result of a Rust `windowed_apply`: the live file totals after the edit. */
  interface ApplyResult {
    total_bytes: number;
    total_lines: number;
  }

  /** Result of a Rust `windowed_undo`/`windowed_redo`: the global-byte edits just
   *  applied (in application order), the 0-based line of the first edit's start
   *  (for a jump-to-change window reload), and the live file totals. A replace
   *  all undone or redone has no edits: `reload_only` says to reload the window. */
  interface UndoResult {
    edits: { start: number; end: number; text: string }[];
    first_line: number;
    total_bytes: number;
    total_lines: number;
    reload_only: boolean;
  }
  /** Result of a Rust `windowed_replace_all`. */
  interface ReplaceAllResult {
    count: number;
    total_bytes: number;
    total_lines: number;
  }
  /** What a whole-file operation reports back. */
  interface OpTotals {
    total_bytes: number;
    total_lines: number;
  }
  /** A results-list row streamed by the Rust `windowed_search`. `line` is
   *  0-based and `col` counts UTF-16 units. */
  interface SearchHitPayload {
    search_id: string;
    offset: number;
    line: number;
    col: number;
    preview: string;
  }

  interface SearchDonePayload {
    search_id: string;
    hits: number;
    truncated: boolean;
    stale: boolean;
    error: boolean;
  }
  /** A result row with the column its hit starts at. */
  type EditResult = FindResult & { col: number };

  interface Props {
    sessionId: number;
    initialTotalLines: number;
    // 0-based line the first window should cover, so an in-place unlock continues
    // from the line the user was viewing in the read-only view.
    initialTopLine?: number;
    // Global 1-based line and column to put the caret at when that line is in
    // the first window; otherwise the caret stays on the top line.
    initialCaret?: { line: number; col: number } | undefined;
    // Separator typed line breaks are written with, once detected for the tab.
    // Undefined until then: the first window's text decides (see onMount).
    insertLineEnding?: '\r\n' | '\n' | undefined;
    dark: boolean;
    fontSize: number;
    fontFamily: string;
    wordWrap: boolean;
    lineNumbers: boolean;
    // True while any dialog/modal is up in the host window; suppresses the
    // automatic focus handoff so a gate/confirm keeps the keyboard.
    modalOpen?: boolean;
    // Fired once with the first window's line-ending style when the tab has
    // none yet (null: no line break in the window). Returns the separator
    // typed breaks get: the detected one, or the user's default for a null.
    ondetectending: (
      style: ReturnType<typeof detectBreakStyle>,
    ) => '\r\n' | '\n';
    // Fired after each successful apply so the state layer marks the tab dirty and
    // records the fresh totals.
    onapplied: (totalBytes: number, totalLines: number) => void;
    // Global cursor position, total line count, and the current window's
    // top-of-viewport line, mirrored into the status bar and (the last one)
    // persisted so a restart restores the same scroll position.
    onstatus: (info: {
      line: number;
      col: number;
      totalLines: number;
      windowStartLine: number;
    }) => void;
    // An apply/read failed: the editor has locked to avoid state divergence.
    onerror: (message: string) => void;
    // The session's pending-operation gate: a replace all (or its undo or redo)
    // can still be running when this editor mounts.
    gate: OpGate;
    // Runs a whole-file operation on the session through the state layer, which
    // keeps the gate and the tab's totals and dirty flag right even if this
    // editor is gone by the time it finishes.
    runop: <T extends OpTotals>(
      sessionId: number,
      run: () => Promise<T>,
      changed: (result: T) => boolean,
    ) => Promise<T>;
    // The global 0-based line at the top of the viewport, once per frame while
    // scrolling, so a remount can open at the same place.
    ontopline?: (line: number) => void;
  }

  let {
    sessionId,
    initialTotalLines,
    initialTopLine = 0,
    initialCaret,
    insertLineEnding,
    dark,
    fontSize,
    fontFamily,
    wordWrap,
    lineNumbers: showLineNumbers,
    modalOpen = false,
    ondetectending,
    onapplied,
    onstatus,
    onerror,
    gate,
    runop,
    ontopline,
  }: Props = $props();

  let container: HTMLDivElement;
  let view: EditorView | undefined;

  // Byte/line geometry of the currently loaded window. windowStartOffset is fixed
  // while editing inside a window (edits never move the window's start); the end
  // offset tracks the window text's byte length. Line bounds are 0-based, end
  // exclusive.
  let windowStartLine = 0;
  let windowEndLine = 0;
  // The selection's global ends, which outlive a window swap, and the live
  // (window-local) selection they were last reconciled with.
  let globalSel: LineSelection = {
    anchor: { line: 0, col: 0 },
    head: { line: 0, col: 0 },
  };
  let lastLive: LineSelection = globalSel;
  let windowStartOffset = 0;
  let windowEndOffset = 0;
  // The loaded window as CodeMirror holds it has every line break as one `\n`;
  // the file's real separator of each break (in order) lives here, so a position
  // in the document converts to the right byte offset in the file.
  let breaks: string[] = [];
  let insertSep = '\n';
  // Seeded from the prop in onMount, then kept authoritative by every read/apply.
  let totalLines = 0;
  let totalBytes = 0;

  // Serializes applies: each transaction's edits are enqueued behind the previous
  // apply so the Rust core sees them in order (coordinates of a later edit assume
  // earlier ones already landed).
  let applyChain: Promise<void> = Promise.resolve();
  // Terminal: an apply/read failed, so the buffer no longer matches the file.
  // The editor goes read-only and no further edits or swaps are attempted.
  let locked = false;
  // Set once the editor is unmounted, so work that outlives it stops touching it.
  let gone = false;
  // Whole-file work in flight (replace all, undo, redo): while it counts, the
  // editor is read-only. A replace all pass drops typed input; an undo or redo
  // queues it for the replay, which runs once the work is over.
  let holds = 0;
  // How many of those holds queue typed input instead of dropping it.
  let queuingHolds = 0;
  // Counts every edit and undo, so a find can tell the content moved under it.
  let editSeq = 0;
  // True while a programmatic window swap replaces the document, so the update
  // listener does not mistake the replacement for a user edit, and the scroll
  // handler ignores the scroll-position changes the swap causes.
  let swapping = false;
  // Whether the view held focus when the current swap began.
  let hadFocusAtSwap = false;
  // Set when an undo or redo changed the document while a swap was running,
  // which the update listener does not track; the swap folds it in.
  let docChangedDuringSwap = false;
  // Guards against re-entrant swaps while one is in flight.
  let swapInFlight = false;
  let selRaf = 0;
  let topRaf = 0;
  // True while an undo/redo result is being mirrored into the CM document, so the
  // update listener does not re-send those (already-in-core) changes back to Rust.
  let applyingRemote = false;
  // Grouping context of the previous applied edit, used to decide whether the next
  // edit opens a new undo group or coalesces into the current one.
  let lastApplyTime = 0;
  let lastEditKind: string | null = null;
  // Set for the one edit a Replace makes, so it opens its own undo group.
  let forceNewGroup = false;
  let prevComposing = false;

  const wrapCompartment = new Compartment();
  const themeCompartment = new Compartment();
  const gutterCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();
  const keymapCompartment = new Compartment();
  // The rebindable commands' keys, rebuilt whenever the shortcuts change.
  function currentKeymap(): Extension {
    return keymapExtension('windowed', platform.os, (id) =>
      shortcutsState.accel(id),
    );
  }

  // The gutter renders global line numbers by adding the window's start line to
  // CM's local (1-based) line number. The closure reads the live windowStartLine,
  // so a swap repaints with the correct offset without reconfiguring.
  function gutterExtension(on: boolean): Extension {
    return on
      ? [
          lineNumbers({ formatNumber: (n) => String(n + windowStartLine) }),
          highlightActiveLineGutter(),
        ]
      : [];
  }

  function readOnlyExtension(on: boolean): Extension {
    return on
      ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
      : [];
  }
  function isReadOnly(): boolean {
    return locked || swapping || holds > 0 || gate.readOnly();
  }
  function syncReadOnly(): void {
    view?.dispatch({
      effects: readOnlyCompartment.reconfigure(readOnlyExtension(isReadOnly())),
    });
  }
  // Whether the view held focus when the first of the current holds began.
  let holdHadFocus = false;
  // Keep the editor read-only until the returned function is called. Typed
  // input is dropped meanwhile, or queued for the replay with `queueInput`.
  // The editor loses focus while it is not editable; the last release gives
  // it back, as a swap's end does.
  function hold(queueInput = false): () => void {
    if (holds === 0) {
      holdHadFocus = view?.hasFocus ?? false;
    }
    holds += 1;
    if (queueInput) {
      queuingHolds += 1;
    }
    syncReadOnly();
    let released = false;
    return () => {
      if (!released) {
        released = true;
        holds -= 1;
        if (queueInput) {
          queuingHolds -= 1;
        }
        syncReadOnly();
        if (holds === 0) {
          restoreFocusAfterHold();
        }
        resumeReplay();
      }
    };
  }
  function restoreFocusAfterHold(): void {
    const had = holdHadFocus;
    holdHadFocus = false;
    if (!had || locked || view === undefined) {
      return;
    }
    if (swapping) {
      // A swap the hold's work started: its end gives focus back.
      hadFocusAtSwap = true;
      return;
    }
    const active = document.activeElement;
    if (active === null || active === document.body) {
      view.focus();
    }
  }
  // The document span of the lines fully on screen, or null when none is.
  function visibleSpan(v: EditorView): { from: number; to: number } | null {
    // clientHeight leaves out a horizontal scrollbar covering the last line.
    const el = v.scrollDOM;
    const top = el.getBoundingClientRect().top + el.clientTop;
    return fullyVisibleLineSpan(
      v.viewportLineBlocks.map((b) => ({
        from: b.from,
        to: b.to,
        top: v.documentTop + b.top,
        bottom: v.documentTop + b.bottom,
      })),
      top,
      top + el.clientHeight,
    );
  }
  // Marks the Select All transaction, which the outside-window filter lets pass.
  const selectVisibleMark = Annotation.define<boolean>();
  // Select All covers what is on screen, not the whole loaded window.
  function selectVisible(v: EditorView): boolean {
    const span = visibleSpan(v);
    if (span === null) {
      return false;
    }
    v.dispatch({
      selection: { anchor: span.from, head: span.to },
      userEvent: 'select',
      annotations: selectVisibleMark.of(true),
    });
    return true;
  }
  // Set by a keydown for the rest of its task: selections made while it is
  // set come from a key command, not from the native select-all.
  let keyActive = false;
  // The keydown CodeMirror is handling, for the same span as keyActive.
  let currentKeydown: KeyboardEvent | undefined;
  // The native (menu) select-all arrives as a DOM selection covering the whole
  // rendered viewport; replace it with the on-screen span.
  function narrowNativeSelectAll(
    tr: Transaction,
  ): TransactionSpec | Transaction {
    const v = view;
    if (
      v === undefined ||
      keyActive ||
      swapping ||
      tr.docChanged ||
      tr.selection === undefined ||
      !tr.isUserEvent('select') ||
      tr.isUserEvent('select.pointer')
    ) {
      return tr;
    }
    const main = tr.selection.main;
    if (main.from > v.viewport.from || main.to < v.viewport.to) {
      return tr;
    }
    const span = visibleSpan(v);
    if (span === null) {
      return tr;
    }
    return {
      selection: { anchor: span.from, head: span.to },
      userEvent: 'select',
    };
  }

  const undoCommand: Command = () => {
    runUndo('undo');
    return true;
  };
  const redoCommand: Command = () => {
    runUndo('redo');
    return true;
  };
  // No CodeMirror `history()`: undo/redo is owned by the Rust journal (the whole
  // document lives there, not in CM), so Mod-z / Mod-Shift-z route to runUndo. A
  // local CM history would fight it — undoing only the window's slice of edits.
  const coreSetup: Extension = [
    highlightSpecialChars(),
    drawSelection(),
    dropCursor(),
    highlightActiveLine(),
    EditorView.domEventHandlers({
      keydown(event) {
        keyActive = true;
        currentKeydown = event;
        queueMicrotask(() => {
          keyActive = false;
          currentKeydown = undefined;
        });
        return false;
      },
    }),
    EditorState.transactionFilter.of(narrowNativeSelectAll),
    keymap.of(
      coreKeyBindings({
        closeBox,
        selectVisible,
        undo: undoCommand,
        redo: redoCommand,
      }),
    ),
  ];

  function buildState(doc: string, cursorPos?: number): EditorState {
    return EditorState.create({
      doc,
      ...(cursorPos !== undefined ? { selection: { anchor: cursorPos } } : {}),
      extensions: [
        // Required in every view, see the note in Editor.svelte.
        EditorView.cspNonce.of(readCspNonce()),
        coreSetup,
        keymapCompartment.of(currentKeymap()),
        // Applied at creation only: a setState here can move the caret (see the
        // `swapping` filter below) and the one phrase used is the control-char
        // tooltip, which picks up a new language the next time a file opens.
        cmPhraseExtension(),
        gutterCompartment.of(gutterExtension(showLineNumbers)),
        wrapCompartment.of(wordWrap ? EditorView.lineWrapping : []),
        themeCompartment.of(varEditorTheme(dark)),
        readOnlyCompartment.of(readOnlyExtension(isReadOnly())),
        // setState tears down the DOM of the old window while the browser
        // selection still points into it, so the selection collapses and the
        // DOM observer syncs that wreckage back as a plain 'select'
        // transaction, landing the caret on the new window's last line. The
        // swap has already put the caret where the caller asked for, so during
        // a swap the DOM is not a selection source. Only DOM-derived syncs are
        // dropped: our own dispatches carry no userEvent, a pointer selection
        // carries 'select.pointer'.
        EditorState.transactionFilter.of((tr) =>
          swapping &&
          !tr.docChanged &&
          tr.annotation(Transaction.userEvent) === 'select'
            ? []
            : tr,
        ),
        // Commands that ignore readOnly (insertTab) could still change the
        // document mid-swap, and the update listener would drop that change.
        EditorState.transactionFilter.of((tr) =>
          rejectDuringSwap(
            swapping || holds > 0,
            tr.docChanged,
            tr.annotation(Transaction.userEvent),
          )
            ? []
            : tr,
        ),
        // While the selection lies outside the window, a user edit or a key
        // command would act on the window edge: reject it and replay the key.
        EditorState.transactionFilter.of(rejectOutsideWindow),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !swapping && !applyingRemote) {
            handleUserEdit(update);
          }
          if (!swapping && (update.docChanged || update.selectionSet)) {
            trackSelection(update.state, update.docChanged);
          }
          if (update.docChanged || update.selectionSet) {
            reportSelection();
          }
        }),
      ],
    });
  }

  function livePos(doc: Text, pos: number): LinePos {
    const line = doc.lineAt(pos);
    return { line: line.number - 1, col: pos - line.from };
  }

  function docPos(doc: Text, pos: LinePos): number {
    const line = doc.line(pos.line + 1);
    return line.from + Math.min(pos.col, line.length);
  }

  function liveSelection(state: EditorState): LineSelection {
    const main = state.selection.main;
    return {
      anchor: livePos(state.doc, main.anchor),
      head: livePos(state.doc, main.head),
    };
  }
  // Fold the state's live selection into the global one: a document change
  // replaces it, a selection change replaces the ends the user moved.
  function trackSelection(state: EditorState, docChanged: boolean): void {
    const live = liveSelection(state);
    globalSel = selectionAfterChange(
      globalSel,
      lastLive,
      live,
      windowStartLine,
      docChanged,
    );
    lastLive = live;
  }

  // Report the global caret Ln/Col, coalesced to one update per frame.
  function reportSelection(): void {
    if (selRaf !== 0) {
      return;
    }
    selRaf = requestAnimationFrame(() => {
      selRaf = 0;
      if (view === undefined) {
        return;
      }
      // The global head, which may lie outside the window after a swap.
      const head = globalSel.head;
      onstatus({
        line: head.line + 1,
        col: head.col + 1,
        totalLines,
        windowStartLine,
      });
    });
  }

  function lock(message: string): void {
    if (locked) {
      return;
    }
    locked = true;
    view?.dispatch({
      effects: readOnlyCompartment.reconfigure(readOnlyExtension(true)),
    });
    onerror(message);
  }

  // The edit kind of a transaction batch, used for undo grouping: a paste, a
  // deletion, an ordinary insertion, or anything else (e.g. programmatic).
  function editKind(update: ViewUpdate): string {
    const trs = update.transactions;
    if (trs.some((t) => t.isUserEvent('input.paste'))) {
      return 'paste';
    }
    if (trs.some((t) => t.isUserEvent('delete'))) {
      return 'delete';
    }
    if (trs.some((t) => t.isUserEvent('input'))) {
      return 'input';
    }
    return 'other';
  }

  // A user edit inside the current window: translate the transaction's changes to
  // global byte edits, decide its undo group, and enqueue an apply. The window's
  // end offset and end line are recomputed from the post-change document (its start
  // is unchanged).
  function handleUserEdit(update: ViewUpdate): void {
    const docBefore = update.startState.doc.toString();
    const changes: RawChange[] = [];
    update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      changes.push({ fromA, toA, inserted: inserted.toString() });
    });
    const edits = mapChangesToEdits(
      windowStartOffset,
      docBefore,
      breaks,
      insertSep,
      changes,
    );
    breaks = applyBreaks(docBefore, breaks, changes, insertSep);
    const docAfter = update.state.doc.toString();
    windowEndOffset =
      windowStartOffset + charToByte(docAfter, breaks, docAfter.length);
    windowEndLine = windowStartLine + update.state.doc.lines;
    const now = Date.now();
    const composing = view?.composing ?? false;
    const kind = editKind(update);
    // A Replace is a step of its own, however soon it follows other typing.
    const newGroup =
      forceNewGroup ||
      decideNewGroup(
        { time: lastApplyTime, kind: lastEditKind, composing: prevComposing },
        {
          time: now,
          kind,
          composing,
          compositionStart: composing && !prevComposing,
        },
      );
    forceNewGroup = false;
    editSeq += 1;
    scheduleResultsRefresh();
    lastApplyTime = now;
    lastEditKind = kind;
    prevComposing = composing;
    enqueueApply(edits, newGroup);
  }

  function enqueueApply(
    edits: { start: number; end: number; text: string }[],
    newGroup: boolean,
  ): void {
    applyChain = applyChain.then(async () => {
      if (locked) {
        return;
      }
      if (!gate.canApply()) {
        // Unreachable while the editor is read-only; refusing here would leave
        // the typed text out of the core, so say so instead of drifting.
        lock(t('editor.locked.write', { detail: 'busy' }));
        return;
      }
      let res: ApplyResult;
      try {
        res = await invoke<ApplyResult>('windowed_apply', {
          sessionId,
          edits,
          newGroup,
        });
      } catch (e) {
        lock(t('editor.locked.write', { detail: String(e) }));
        return;
      }
      totalBytes = res.total_bytes;
      totalLines = res.total_lines;
      onapplied(res.total_bytes, res.total_lines);
      reportSelection();
    });
  }

  // Run an undo or redo: serialized behind the apply chain (so it never races an
  // in-flight edit), it invokes the Rust journal command and mirrors the result.
  // A "nothing to undo/redo" is a silent no-op; any other failure locks the editor
  // via the same path an apply failure does.
  function runUndo(dir: 'undo' | 'redo'): void {
    if (locked || swapping) {
      return;
    }
    // Input typed from here to the end of the undo is queued: it replays at
    // the caret the undo leaves, instead of landing on content about to change.
    const release = hold(true);
    applyChain = applyChain.then(async () => {
      try {
        if (locked || view === undefined) {
          return;
        }
        let res: UndoResult;
        try {
          res = await runop(
            sessionId,
            () =>
              invoke<UndoResult>(
                dir === 'undo' ? 'windowed_undo' : 'windowed_redo',
                { sessionId },
              ),
            (r) => r.reload_only,
          );
        } catch (e) {
          const msg = String(e);
          if (
            msg.includes('nothing-to-undo') ||
            msg.includes('nothing-to-redo')
          ) {
            return;
          }
          lock(t('editor.locked.undo', { detail: msg }));
          return;
        }
        applyUndoResult(res);
      } finally {
        release();
      }
    });
  }

  // Mirror an undo/redo result into the view. If every applied edit lands inside
  // the current window's byte range, dispatch them as local CM changes (byte→char
  // mapped, suppressing the re-send to Rust); otherwise the change is off-window,
  // so reload the window at the change (standard editor jump-to-undo behaviour).
  function applyUndoResult(res: UndoResult): void {
    if (view === undefined) {
      return;
    }
    editSeq += 1;
    scheduleResultsRefresh();
    if (res.reload_only) {
      // A replace all undone or redone: the state layer has recorded the totals
      // and the dirty flag; the window shows the content as it is now.
      totalLines = res.total_lines;
      totalBytes = res.total_bytes;
      void reloadWindow();
      return;
    }
    // Marks the tab dirty and records the fresh totals (v1: an undo back to the
    // saved state also stays dirty — the accepted trade-off).
    onapplied(res.total_bytes, res.total_lines);
    // The edits arrive in sequential frames; track the window end as each shifts
    // it to test containment without partially dispatching.
    let end = windowEndOffset;
    let inWindow = true;
    for (const e of res.edits) {
      if (e.start < windowStartOffset || e.end > end) {
        inWindow = false;
        break;
      }
      end += byteLength(e.text) - (e.end - e.start);
    }
    if (!inWindow) {
      totalLines = res.total_lines;
      totalBytes = res.total_bytes;
      void loadWindow(res.first_line, 'goto');
      return;
    }
    totalLines = res.total_lines;
    totalBytes = res.total_bytes;
    let landed = true;
    applyingRemote = true;
    try {
      for (const e of res.edits) {
        const doc = view.state.doc.toString();
        const from = byteToChar(doc, breaks, e.start - windowStartOffset);
        const to = byteToChar(doc, breaks, e.end - windowStartOffset);
        if (from === null || to === null) {
          landed = false;
          break;
        }
        view.dispatch({ changes: { from, to, insert: e.text } });
        breaks = replaceBreaks(doc, breaks, from, to, scanBreaks(e.text));
        if (swapping) {
          docChangedDuringSwap = true;
        }
      }
    } finally {
      applyingRemote = false;
    }
    if (!landed) {
      // An edit boundary inside a CRLF has no document position; the window
      // is reloaded from the core instead of guessing one.
      void loadWindow(res.first_line, 'goto');
      return;
    }
    const docAfter = view.state.doc.toString();
    windowEndOffset =
      windowStartOffset + charToByte(docAfter, breaks, docAfter.length);
    windowEndLine = windowStartLine + view.state.doc.lines;
    reportSelection();
  }

  // Load the window covering `target` (0-based global line). `mode` decides how the
  // scroll position is set afterward: 'preserve' keeps the line at the viewport top
  // fixed (no visual jump — used by scroll-triggered swaps), 'goto' scrolls the
  // target line to the top (used by an explicit jump), 'reveal' keeps the global
  // selection like 'preserve' and scrolls its head into view, 'reload' keeps the
  // view where it is but reads the window again even if it covers the same lines
  // (the content under it changed).
  // Enter/leave the swap phase. The whole swap — including the awaits inside
  // loadWindow — runs with the editor read-only: a keystroke landing between the
  // apply flush and the setState would be applied against the old window's byte
  // offsets and then silently overwritten by the swapped-in text, and one landing
  // between setState and the anchor rAF would be dropped by the `swapping` guard
  // in the update listener. Read-only closes both gaps honestly (input is briefly
  // refused instead of silently lost). endSwap is idempotent and always restores
  // the flag, so no exit path can wedge the editor in the ignore-edits state.
  // The content is non-editable during a swap, which can move focus to <body>.
  // endSwap gives focus back when the editor had it and nothing else holds it.
  // User document changes are rejected during a swap, and Tab is blocked so it
  // cannot walk focus out of the editor.
  function beginSwap(): void {
    hadFocusAtSwap = view?.hasFocus ?? false;
    docChangedDuringSwap = false;
    swapping = true;
    view?.dispatch({
      effects: readOnlyCompartment.reconfigure(readOnlyExtension(true)),
    });
  }
  function endSwap(): void {
    if (!swapping) {
      return;
    }
    swapping = false;
    if (!locked) {
      syncReadOnly();
      // A pointer selection made after the swap's setState was not tracked.
      if (view !== undefined) {
        trackSelection(view.state, false);
      }
      const active = document.activeElement;
      if (hadFocusAtSwap && (active === null || active === document.body)) {
        view?.focus();
      }
    }
    if (replayPending) {
      void drainReplay();
    }
    notifySettled();
  }
  // Input typed while the selection lies outside the window (and fits one) is
  // queued, the window is swapped back to the selection, and the queue is then
  // replayed there as ordinary user transactions.
  type ReplayItem =
    | { kind: 'text'; text: string; userEvent: string }
    | { kind: 'key'; event: KeyboardEvent }
    | {
        kind: 'copy' | 'cut';
        supply: (text: string | null) => void;
        written: Promise<boolean>;
      };
  let replayQueue: ReplayItem[] = [];
  // True from the first queued item until the queue has drained, so nothing
  // overtakes it.
  let replayPending = false;
  let draining = false;
  let replayTimer: ReturnType<typeof setTimeout> | undefined;

  function isWindows(): boolean {
    return platform.os === 'windows';
  }

  function selectionOutside(doc: Text): boolean {
    return (
      !insideWindow(globalSel, windowStartLine, doc.lines) &&
      fitsWindow(globalSel)
    );
  }
  function replayState(): ReplayState {
    const v = view;
    const active = document.activeElement;
    return {
      locked: v === undefined || locked,
      focusElsewhere:
        v !== undefined &&
        active !== null &&
        active !== document.body &&
        !v.dom.contains(active),
      dropHold: holds > queuingHolds,
      queueHold: queuingHolds > 0,
      swapping,
      replayPending,
      outside: v !== undefined && selectionOutside(v.state.doc),
    };
  }
  // Whether input should be handled by the replay: focus is in the editor (or
  // nowhere) and the selection is outside the window, or a replay is running,
  // or an undo or redo is under way.
  function replayWanted(): boolean {
    return replayStateWanted(replayState());
  }

  function dropReplay(): void {
    for (const item of replayQueue) {
      if (item.kind === 'copy' || item.kind === 'cut') {
        item.supply(null);
      }
    }
    replayQueue = [];
    replayPending = false;
    clearTimeout(replayTimer);
    replayTimer = undefined;
    notifySettled();
  }

  function startReplaySwap(): void {
    replayTimer = undefined;
    replayPending = true;
    if (view === undefined || locked || swapping) {
      dropReplay();
      return;
    }
    // An undo or redo is still running: resumeReplay carries on after it.
    if (holds > 0) {
      return;
    }
    // The layout may have changed since the table was last read.
    refreshAltGr();
    const start = windowStartFor(globalSel, totalLines);
    void loadWindow(start + MARGIN_LINES, 'reveal');
    // The keys that got here may have come with focus on <body>.
    hadFocusAtSwap = true;
  }
  // Carry on with the queued input once nothing holds it back: swap back to
  // the selection, or drain the queue when the window already covers it.
  function resumeReplay(): void {
    if (
      !replayPending ||
      swapping ||
      draining ||
      holds > 0 ||
      replayTimer !== undefined
    ) {
      return;
    }
    if (view === undefined || locked) {
      dropReplay();
    } else if (selectionOutside(view.state.doc)) {
      startReplaySwap();
    } else {
      void drainReplay();
    }
  }

  function queueReplay(item: ReplayItem): void {
    replayQueue.push(item);
    if (!replayPending) {
      if (holds > 0) {
        replayPending = true;
      } else {
        startReplaySwap();
      }
    }
  }
  // Safety net for a key command CodeMirror ran at the window edge: reject the
  // transaction and replay the keydown once the window is back on the selection.
  function rejectOutsideWindow(
    tr: Transaction,
  ): Transaction | readonly TransactionSpec[] {
    if (
      swapping ||
      locked ||
      tr.annotation(selectVisibleMark) === true ||
      !selectionOutside(tr.startState.doc)
    ) {
      return tr;
    }
    const edit =
      tr.docChanged && tr.annotation(Transaction.userEvent) !== undefined;
    const keySelect =
      keyActive &&
      !tr.docChanged &&
      tr.selection !== undefined &&
      !tr.isUserEvent('select.pointer');
    if (!edit && !keySelect) {
      return tr;
    }
    if (tr.isUserEvent('input.type') && !tr.isUserEvent('input.type.compose')) {
      // Text no keydown announced, such as an AltGr character.
      let text = '';
      tr.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
        text += inserted.toString();
      });
      if (text !== '') {
        queueDeferred({ kind: 'text', text, userEvent: 'input.type' });
      }
      return [];
    }
    const e = currentKeydown;
    if (
      e !== undefined &&
      !replayPending &&
      replayKind(e, isWindows()) === 'chord'
    ) {
      queueDeferred({ kind: 'key', event: e });
    }
    return [];
  }
  // Never swap inside a filter: the swap starts in the next task.
  function queueDeferred(item: ReplayItem): void {
    replayQueue.push(item);
    if (!replayPending) {
      replayPending = true;
      replayTimer = setTimeout(startReplaySwap, 0);
    }
  }
  // The text a copy or cut with an empty caret took, line by line: CodeMirror
  // pastes it back above the caret line. A copy of a selection clears it.
  let linewiseCopy: string | null = null;

  async function runReplayItem(v: EditorView, item: ReplayItem): Promise<void> {
    if (item.kind === 'text') {
      v.dispatch(
        item.userEvent === 'input.paste'
          ? pasteSpec(v.state, item.text, linewiseCopy)
          : v.state.replaceSelection(item.text),
        {
          userEvent: item.userEvent,
          scrollIntoView: true,
        },
      );
    } else if (item.kind === 'key') {
      runScopeHandlers(v, item.event, 'editor');
    } else {
      const copied = copiedRange(v.state);
      linewiseCopy = linewiseAfterCopy(copied);
      item.supply(copied.text === '' && !copied.linewise ? null : copied.text);
      if (!(await item.written)) {
        return;
      }
      // Delete only after the write succeeded, as editorCut does.
      if (item.kind === 'cut' && view === v && !swapping) {
        v.dispatch({
          changes: copied.ranges,
          userEvent: 'delete.cut',
          scrollIntoView: true,
        });
      }
    }
  }
  // Replay the queue in order once the swap is over. New input keeps being
  // queued until the queue is empty. A swap or an undo that begins meanwhile
  // pauses the drain; its end resumes it.
  async function drainReplay(): Promise<void> {
    if (draining) {
      return;
    }
    draining = true;
    try {
      while (replayQueue.length > 0) {
        const v = view;
        if (swapping || holds > 0) {
          return;
        }
        if (
          v === undefined ||
          locked ||
          !insideWindow(globalSel, windowStartLine, v.state.doc.lines)
        ) {
          dropReplay();
          return;
        }
        const item = replayQueue.shift();
        if (item !== undefined) {
          await runReplayItem(v, item);
        }
      }
      replayPending = false;
    } catch (e) {
      dropReplay();
      throw e;
    } finally {
      draining = false;
      notifySettled();
    }
  }
  // The layout's AltGr characters, as the core last reported them. Null until
  // the first answer, and always off Windows.
  let altGrTable: AltGrTable | null = null;
  function refreshAltGr(): void {
    if (isWindows()) {
      invoke<AltGrTable>('altgr_table').then(
        (table) => {
          altGrTable = table;
        },
        () => {},
      );
    }
  }
  const neverReplayed = new Set<Command>([
    toggleTabFocusMode,
    undoCommand,
    redoCommand,
  ]);
  // The editor's key bindings in the order CodeMirror ranks them: the
  // off-screen moves, the editor's own keys, then the shared keymap.
  function keyLayers(): KeyLayers {
    const { offscreen, normal } = buildKeymap('windowed', platform.os, (id) =>
      shortcutsState.accel(id),
    );
    return [
      offscreen,
      coreKeyBindings({
        closeBox,
        selectVisible,
        undo: undoCommand,
        redo: redoCommand,
      }),
      normal,
    ];
  }

  function blockTabDuringSwap(e: KeyboardEvent): void {
    if (
      !swapping ||
      e.key !== 'Tab' ||
      e.ctrlKey ||
      e.metaKey ||
      e.altKey ||
      view === undefined
    ) {
      return;
    }
    const active = document.activeElement;
    if (
      active === null ||
      active === document.body ||
      view.dom.contains(active)
    ) {
      e.preventDefault();
    }
  }
  // Keydowns CodeMirror had already prevented when they bubbled out of the
  // editor, before any window-level accelerator handler.
  const claimedByEditor = new WeakSet<KeyboardEvent>();
  function onViewKeydown(e: KeyboardEvent): void {
    if (e.defaultPrevented) {
      claimedByEditor.add(e);
    }
  }

  function onDocKeydown(e: KeyboardEvent): void {
    const action = decideKey({
      event: e,
      os: platform.os,
      state: replayState(),
      draining,
      altGr: altGrTable,
      layers: keyLayers,
    });
    if (action.type === 'text' || action.type === 'key') {
      e.preventDefault();
      e.stopPropagation();
      queueReplay(
        action.type === 'text'
          ? { kind: 'text', text: action.text, userEvent: 'input.type' }
          : { kind: 'key', event: e },
      );
      return;
    }
    if (isImeKey(e) && replayWanted()) {
      // A composition cannot be replayed: move the view, the user composes
      // again. The key is not prevented.
      if (!replayPending) {
        startReplaySwap();
      }
    } else if (
      !replayPending &&
      e.isTrusted &&
      replayWanted() &&
      replayKind(e, isWindows()) === 'chord'
    ) {
      // A chord that is a no-op at the window edge leaves no transaction:
      // replay it unless a menu accelerator took it after CodeMirror passed
      // on it.
      setTimeout(() => {
        const v = view;
        if (
          (claimedByEditor.has(e) || !e.defaultPrevented) &&
          !replayPending &&
          v !== undefined &&
          selectionOutside(v.state.doc) &&
          chordReplaysAtEdge(keyLayers(), e, platform.os, neverReplayed)
        ) {
          queueReplay({ kind: 'key', event: e });
        }
      }, 0);
    }
    blockTabDuringSwap(e);
  }

  function onDocCompositionStart(): void {
    if (holds === 0 && replayWanted() && !replayPending) {
      startReplaySwap();
    }
  }

  function onDocPaste(e: ClipboardEvent): void {
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (text === '') {
      return;
    }
    if (replayWanted()) {
      e.preventDefault();
      e.stopPropagation();
      queueReplay({ kind: 'text', text, userEvent: 'input.paste' });
      return;
    }
    // CodeMirror's own paste only knows the copies it made itself.
    const v = view;
    if (
      v !== undefined &&
      !v.state.readOnly &&
      v.dom.contains(document.activeElement) &&
      pasteIsLinewise(v.state, text, linewiseCopy)
    ) {
      e.preventDefault();
      e.stopPropagation();
      v.dispatch(pasteSpec(v.state, text, linewiseCopy), {
        userEvent: 'input.paste',
        scrollIntoView: true,
      });
    }
  }
  // WebKit allows a clipboard write only while the copy event is handled, so
  // the write starts here and its text is supplied once the window is back.
  function onDocCopyCut(e: ClipboardEvent): void {
    if (replayWanted()) {
      e.preventDefault();
      e.stopPropagation();
      let supply: (text: string | null) => void = () => {};
      const blob = new Promise<Blob>((resolve, reject) => {
        supply = (text) => {
          if (text === null) {
            reject(new Error('nothing to copy'));
          } else {
            resolve(new Blob([text], { type: 'text/plain' }));
          }
        };
      });
      // A write that fails never reads this promise; that is not an error.
      void blob.catch(() => {});
      const written = navigator.clipboard
        .write([new ClipboardItem({ 'text/plain': blob })])
        .then(
          () => true,
          () => false,
        );
      queueReplay({ kind: e.type === 'cut' ? 'cut' : 'copy', supply, written });
      return;
    }
    const v = view;
    if (v !== undefined && v.dom.contains(document.activeElement)) {
      linewiseCopy = linewiseAfterCopy(copiedRange(v.state));
    }
  }

  async function loadWindow(
    target: number,
    mode: 'preserve' | 'goto' | 'reveal' | 'reload',
  ): Promise<void> {
    if (view === undefined || locked || swapping) {
      traceSwap({
        at: 'skip',
        mode,
        target,
        windowStartLine,
        locked,
        swapping,
      });
      return;
    }
    const w = nextWindow(target, totalLines, WINDOW_LINES, MARGIN_LINES);
    if (w.startLine === windowStartLine && mode === 'preserve') {
      traceSwap({ at: 'same', mode, target, windowStartLine });
      return;
    }
    traceSwap({
      at: 'enter',
      mode,
      target,
      windowStartLine,
      want: w.startLine,
    });
    beginSwap();
    try {
      // Every in-flight apply must land before the read, or the read returns
      // stale bytes/lines that would desync the swapped-in window.
      await applyChain;
      if (locked || view === undefined) {
        endSwap();
        return;
      }
      let res: WindowRead;
      try {
        res = await invoke<WindowRead>('windowed_read', {
          sessionId,
          startLine: w.startLine,
          endLine: w.endLine,
        });
      } catch (e) {
        // Locked first, so the swap's end does not refocus the editor just
        // before the error dialog shows.
        lock(t('editor.locked.read', { detail: String(e) }));
        endSwap();
        return;
      }
      // Capture the anchor and the cursor's global position against the OLD
      // window before the vars are overwritten.
      const anchor =
        mode === 'preserve' || mode === 'reload' ? captureAnchor() : null;
      // Selection moves made while the swap was waiting on the read were not
      // tracked (the swap ignores the listener); fold them in against the old
      // window before the window variables change. An undo applied meanwhile
      // changed the document, not just the selection.
      trackSelection(view.state, docChangedDuringSwap);
      docChangedDuringSwap = false;

      windowStartLine = res.start_line;
      windowStartOffset = res.start_offset;
      windowEndOffset = res.end_offset;
      breaks = scanBreaks(res.text);
      totalLines = res.total_lines;
      totalBytes = res.total_bytes;

      // buildState reads `swapping`, so the fresh state starts read-only and
      // stays that way until endSwap runs in the anchor rAF below. The caret
      // goes in before the view ever sees the state, so no gap exists between
      // the new document and its selection.
      const fresh = buildState(res.text);
      // A goto puts the caret at the target line. Otherwise the remembered
      // global selection is intersected with the new window; the global one is
      // kept so a later swap can bring a clamped end back.
      if (mode === 'goto') {
        globalSel = gotoSelection(
          windowStartLine +
            clamp(target - windowStartLine, 0, fresh.doc.lines - 1),
        );
      }
      const swapped = selectionAfterSwap(globalSel, {
        startLine: windowStartLine,
        lineCount: fresh.doc.lines,
        lineLength: (local) => fresh.doc.line(local + 1).length,
      });
      globalSel = swapped.global;
      lastLive = swapped.live;
      view.setState(
        fresh.update({
          selection: {
            anchor: docPos(fresh.doc, swapped.live.anchor),
            head: docPos(fresh.doc, swapped.live.head),
          },
        }).state,
      );
      windowEndLine = windowStartLine + view.state.doc.lines;
      traceSwap({
        at: 'placed',
        mode,
        target,
        windowStartLine,
        caretLine: windowStartLine + swapped.live.head.line + 1,
      });

      requestAnimationFrame(() => {
        try {
          if (view !== undefined) {
            if (mode === 'goto') {
              scrollLineToTop(target);
            } else if (mode === 'reveal') {
              view.dispatch({
                effects: EditorView.scrollIntoView(
                  view.state.selection.main.head,
                  { y: 'center' },
                ),
              });
            } else if (anchor !== null) {
              restoreAnchor(anchor);
            }
          }
        } finally {
          endSwap();
          reportSelection();
        }
      });
    } catch (e) {
      // The swap died mid-flight (possibly after setState): the buffer/offset
      // pairing is no longer trustworthy, so surface it as a lock rather than
      // limping on with silently misaligned coordinates.
      lock(t('editor.locked.swap', { detail: String(e) }));
      endSwap();
    }
  }

  /** Global 0-based line at the top of the viewport, and how many pixels its top is
   *  scrolled above the viewport edge, so a swap can restore the same view. */
  function captureAnchor(): { globalLine: number; pixelWithin: number } | null {
    if (view === undefined) {
      return null;
    }
    const rect = view.scrollDOM.getBoundingClientRect();
    const pos = view.posAtCoords({ x: rect.left + 2, y: rect.top + 2 });
    if (pos === null) {
      return null;
    }
    const line = view.state.doc.lineAt(pos);
    const coords = view.coordsAtPos(line.from);
    const pixelWithin = coords !== null ? rect.top - coords.top : 0;
    return {
      globalLine: windowStartLine + (line.number - 1),
      pixelWithin,
    };
  }

  function restoreAnchor(anchor: {
    globalLine: number;
    pixelWithin: number;
  }): void {
    if (view === undefined) {
      return;
    }
    const localNo = clamp(
      anchor.globalLine - windowStartLine + 1,
      1,
      view.state.doc.lines,
    );
    const line = view.state.doc.line(localNo);
    view.scrollDOM.scrollTop =
      view.lineBlockAt(line.from).top + anchor.pixelWithin;
  }

  function scrollLineToTop(globalLine: number): void {
    if (view === undefined) {
      return;
    }
    const localNo = clamp(
      globalLine - windowStartLine + 1,
      1,
      view.state.doc.lines,
    );
    const line = view.state.doc.line(localNo);
    view.scrollDOM.scrollTop = view.lineBlockAt(line.from).top;
  }

  function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
  }

  /** Global 0-based line at the given y (viewport-relative) coordinate. */
  function lineAtViewportY(y: number): number {
    if (view === undefined) {
      return windowStartLine;
    }
    const rect = view.scrollDOM.getBoundingClientRect();
    const pos = view.posAtCoords({ x: rect.left + 2, y });
    if (pos === null) {
      return windowStartLine;
    }
    return windowStartLine + (view.state.doc.lineAt(pos).number - 1);
  }

  // On scroll, load the neighbouring window once the viewport nears a window edge.
  // IME composition defers the swap (full handling lands next segment): a swap
  // mid-composition would tear the composing text out from under the input.
  async function maybeSwap(): Promise<void> {
    if (
      view === undefined ||
      swapInFlight ||
      swapping ||
      holds > 0 ||
      locked ||
      view.composing
    ) {
      return;
    }
    const rect = view.scrollDOM.getBoundingClientRect();
    const top = lineAtViewportY(rect.top + 2);
    const bottom = lineAtViewportY(rect.bottom - 2);
    let target: number | null = null;
    if (windowStartLine > 0 && top - windowStartLine < SWAP_THRESHOLD_LINES) {
      target = top;
    } else if (
      windowEndLine < totalLines &&
      windowEndLine - bottom < SWAP_THRESHOLD_LINES
    ) {
      target = bottom;
    }
    if (target === null) {
      return;
    }
    swapInFlight = true;
    try {
      await loadWindow(target, 'preserve');
    } finally {
      swapInFlight = false;
    }
  }

  function onScroll(): void {
    if (!swapping) {
      void maybeSwap();
      reportTopLine();
    }
  }
  // Report the viewport's top line, coalesced to one call per frame.
  function reportTopLine(): void {
    if (ontopline === undefined || topRaf !== 0) {
      return;
    }
    topRaf = requestAnimationFrame(() => {
      topRaf = 0;
      if (view !== undefined && !swapping) {
        // The inverse of scrollLineToTop. scrollTop is rounded, so probe a
        // couple of pixels in or a line's own top would read as the line above.
        const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop + 2);
        ontopline?.(
          windowStartLine + view.state.doc.lineAt(block.from).number - 1,
        );
      }
    });
  }
  // --- Find, replace and go to line ------------------------------------------
  // The search itself runs in the Rust core over the edited content. Every
  // selection set here is the global selection, then a window load that reveals
  // it (never a selection dispatched straight into CodeMirror, which a later
  // window swap would overwrite with the old global selection).
  // Cap on results-list rows, as in the viewer.
  const SEARCH_MAX = 5000;
  // How long after the last edit the results list is searched again.
  const REFRESH_MS = 500;

  let panel = $state<'none' | 'goto' | 'search'>('none');
  let panels = $state<ReturnType<typeof FindPanels> | null>(null);
  let gotoValue = $state('');
  let findQuery = $state('');
  let findCase = $state(false);
  let replaceText = $state('');
  // The query and case the shown results were searched with.
  let resultQuery = $state('');
  let resultCase = $state(false);
  let results = $state<EditResult[]>([]);
  let cursor = $state(-1);
  let searching = $state(false);
  let searchFinished = $state(false);
  let searchFailed = $state(false);
  let truncated = $state(false);
  // A line under the results: the outcome of the last replace or find.
  let statusNote = $state('');
  // Id of the running results search; hits and done for any other id are
  // ignored.
  let currentSearchId: string | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let unlistenHit: UnlistenFn | null = null;
  let unlistenDone: UnlistenFn | null = null;

  const searchStatus = $derived(
    statusNote !== ''
      ? statusNote
      : searching
        ? t('large.search.searching', { count: results.length })
        : searchFailed
          ? t('large.search.failed')
          : searchFinished
            ? t('large.search.results', { count: results.length }) +
              (truncated ? t('large.search.truncatedSuffix') : '')
            : '',
  );
  // Callers waiting for no swap to run and the replay queue to be empty.
  let settleWaiters: (() => void)[] = [];
  function isSettled(): boolean {
    return !swapping && !replayPending;
  }
  function notifySettled(): void {
    if (!isSettled()) {
      return;
    }
    const waiting = settleWaiters;
    settleWaiters = [];
    for (const wake of waiting) {
      wake();
    }
  }
  function releaseSettleWaiters(): void {
    const waiting = settleWaiters;
    settleWaiters = [];
    for (const wake of waiting) {
      wake();
    }
  }
  // Resolves once no window swap is running and the replay queue is empty, so
  // a find never retargets queued typing and a window load is never skipped
  // because a swap is in flight. False when the editor cannot take the
  // operation: it is gone, locked, or busy with whole-file work.
  async function settled(): Promise<boolean> {
    while (!isSettled() && !gone) {
      await new Promise<void>((resolve) => settleWaiters.push(resolve));
    }
    return view !== undefined && !locked && !gone && holds === 0;
  }
  // Like `settled`, and takes the input hold in the same step, so nothing can
  // start in between. Null when the editor cannot take the operation.
  async function settledHold(): Promise<(() => void) | null> {
    for (;;) {
      if (!(await settled())) {
        return null;
      }
      const release = hold();
      if (isSettled()) {
        return release;
      }
      release();
    }
  }
  // Run `run` after every edit typed so far has reached the core, and keep
  // later edits behind it.
  function behindApplies<T>(run: () => Promise<T>): Promise<T> {
    const result = applyChain.then(run);
    applyChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  // Read the window again where it is: the content under it changed.
  function reloadWindow(): Promise<void> {
    return loadWindow(windowStartLine + MARGIN_LINES, 'reload');
  }

  function cancelSearch(): void {
    if (currentSearchId !== null) {
      const id = currentSearchId;
      currentSearchId = null;
      void invoke('windowed_search_cancel', { searchId: id });
    }
  }
  function resetResults(): void {
    cancelSearch();
    results = [];
    cursor = -1;
    searching = false;
    searchFinished = false;
    searchFailed = false;
    truncated = false;
  }
  // Start a fresh results search. Each run gets a unique id, cancelling the
  // previous one.
  function runSearch(
    query: string = findQuery,
    caseSensitive: boolean = findCase,
  ): void {
    if (query === '') {
      return;
    }
    resetResults();
    statusNote = '';
    resultQuery = query;
    resultCase = caseSensitive;
    const id = crypto.randomUUID();
    currentSearchId = id;
    searching = true;
    void behindApplies(() =>
      invoke('windowed_search', {
        sessionId,
        query,
        caseSensitive,
        maxResults: SEARCH_MAX,
        searchId: id,
      }),
    ).catch(() => {
      if (currentSearchId === id) {
        searching = false;
        searchFailed = true;
      }
    });
  }
  // An edit makes the list out of date: cancel the scan and search again once
  // the edits stop. Only while the find bar shows a list.
  function scheduleResultsRefresh(): void {
    if (panel !== 'search' || (!searching && !searchFinished)) {
      return;
    }
    cancelSearch();
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (panel === 'search' && !gone) {
        runSearch(resultQuery, resultCase);
      }
    }, REFRESH_MS);
  }

  async function listenForResults(isDisposed: () => boolean): Promise<void> {
    const hit = await listen<SearchHitPayload>('windowed-search-hit', (e) => {
      if (e.payload.search_id !== currentSearchId) {
        return;
      }
      results.push({
        line: e.payload.line + 1,
        col: e.payload.col,
        preview: e.payload.preview,
      });
    });
    const done = await listen<SearchDonePayload>(
      'windowed-search-done',
      (e) => {
        if (e.payload.search_id !== currentSearchId) {
          return;
        }
        searching = false;
        if (e.payload.error) {
          searchFailed = true;
        } else if (!e.payload.stale) {
          searchFinished = true;
          truncated = e.payload.truncated;
        }
      },
    );
    if (isDisposed()) {
      hit();
      done();
      return;
    }
    unlistenHit = hit;
    unlistenDone = done;
  }
  // Select a hit: the global selection, then the window that shows it.
  async function showHit(hit: FindHit): Promise<void> {
    globalSel = hitSelection(hit);
    await loadWindow(hit.start.line, 'reveal');
  }
  // Find the next (or previous) hit from the caret, over the content as the core
  // has it: queued behind the edits already typed. Looks again once if more was
  // typed meanwhile.
  async function findStep(backward: boolean): Promise<void> {
    const query = findQuery;
    if (query === '') {
      openFind();
      return;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!(await settled())) {
        return;
      }
      const { first, last } = orderedPositions(globalSel);
      const from = backward ? first : last;
      const seq = editSeq;
      let hit: FindHit | null;
      try {
        hit = await behindApplies(() =>
          invoke<FindHit | null>('windowed_find', {
            sessionId,
            query,
            caseSensitive: findCase,
            line: from.line,
            col: from.col,
            backward,
          }),
        );
      } catch {
        statusNote = t('large.search.failed');
        return;
      }
      if (seq !== editSeq) {
        continue;
      }
      if (hit === null) {
        statusNote = t('large.search.results', { count: 0 });
        return;
      }
      if (!(await settled())) {
        return;
      }
      statusNote = '';
      await showHit(hit);
      return;
    }
  }
  // Replace the hit the selection covers, then go on to the next one. Acts on
  // the global selection: when that is outside the window the window is brought
  // to it first, and what is selected must still match the query. If it does
  // not, Replace acts as Find Next.
  async function replaceOne(): Promise<void> {
    const query = findQuery;
    if (query === '') {
      openFind();
      return;
    }
    if (!(await settled())) {
      return;
    }
    let v = view;
    if (v === undefined) {
      return;
    }
    if (!insideWindow(globalSel, windowStartLine, v.state.doc.lines)) {
      if (!fitsWindow(globalSel)) {
        void findStep(false);
        return;
      }
      await loadWindow(
        windowStartFor(globalSel, totalLines) + MARGIN_LINES,
        'reveal',
      );
      if (!(await settled())) {
        return;
      }
      v = view;
      if (v === undefined) {
        return;
      }
    }
    const main = v.state.selection.main;
    if (
      main.empty ||
      !textMatchesQuery(v.state.sliceDoc(main.from, main.to), query, findCase)
    ) {
      void findStep(false);
      return;
    }
    // The normal edit path: a user-annotated transaction, which the
    // outside-window filter lets through because the selection is inside the
    // window now, and which reaches the core like typing and undoes like it.
    forceNewGroup = true;
    v.dispatch({
      changes: { from: main.from, to: main.to, insert: replaceText },
      selection: { anchor: main.from + replaceText.length },
      userEvent: 'replace',
    });
    void findStep(false);
  }
  // Replace every hit in the core as one undoable step. The editor is
  // read-only from here until the window has been read again, and nothing typed
  // meanwhile is queued.
  async function replaceAll(): Promise<void> {
    const query = findQuery;
    if (query === '') {
      openFind();
      return;
    }
    const release = await settledHold();
    if (release === null) {
      return;
    }
    try {
      const res = await behindApplies(() =>
        runop(
          sessionId,
          () =>
            invoke<ReplaceAllResult>('windowed_replace_all', {
              sessionId,
              query,
              caseSensitive: findCase,
              replacement: replaceText,
            }),
          (r) => r.count > 0,
        ),
      );
      if (gone) {
        return;
      }
      totalLines = res.total_lines;
      totalBytes = res.total_bytes;
      cancelSearch();
      results = [];
      cursor = -1;
      searching = false;
      searchFinished = false;
      statusNote = formatReplaced(t('cm.replacedMany'), res.count);
      if (res.count > 0) {
        editSeq += 1;
        await reloadWindow();
      }
    } catch (e) {
      if (!gone) {
        lock(t('editor.locked.write', { detail: String(e) }));
      }
    } finally {
      release();
    }
  }

  async function jumpToResult(index: number): Promise<void> {
    const r = results[index];
    if (r === undefined) {
      return;
    }
    cursor = index;
    if (!(await settled())) {
      return;
    }
    const start = { line: r.line - 1, col: r.col };
    await showHit({ start, end: endOfMatch(start, resultQuery) });
  }

  function stepResult(delta: number): void {
    const next = moveResultCursor(cursor, results.length, delta);
    if (next >= 0) {
      void jumpToResult(next);
    }
  }
  // Enter in the query field looks up the list when the query changed, and goes
  // to the next hit; Shift+Enter goes to the previous one.
  function searchOrNext(backward: boolean): void {
    if (
      findQuery !== resultQuery ||
      findCase !== resultCase ||
      (!searching && !searchFinished)
    ) {
      runSearch();
    }
    void findStep(backward);
  }

  function onSearchKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePanel();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      stepResult(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      stepResult(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (panels?.isReplaceFocused() === true) {
        void replaceOne();
      } else if (panels?.isQueryFocused() === true) {
        searchOrNext(e.shiftKey);
      } else {
        stepResult(1);
      }
    }
  }

  function openGoto(): void {
    resetResults();
    panel = 'goto';
    gotoValue = '';
    requestAnimationFrame(() => panels?.focusGoto());
  }

  function closePanel(): void {
    if (panel === 'none') {
      return;
    }
    if (panel === 'search') {
      resetResults();
      clearTimeout(refreshTimer);
      statusNote = '';
    }
    panel = 'none';
    view?.focus();
  }

  async function submitGoto(): Promise<void> {
    const target = parseGotoRange(gotoValue, totalLines);
    closePanel();
    if (target === null || !(await settled())) {
      return;
    }
    if (target.kind === 'line') {
      globalSel = gotoSelection(target.line);
      await loadWindow(target.line, 'reveal');
    } else {
      // A range is selected only as far as one window holds.
      globalSel = gotoRangeSelection(target.range.start, target.range.end);
      await loadWindow(target.range.start, 'reveal');
    }
  }

  function onGotoKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePanel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void submitGoto();
    }
  }
  // The shortcut registry's `goto-line` key opens the goto box. Find and its
  // relatives are native menu accelerators (they never reach this listener),
  // so DocumentApp routes them to the exports below.
  function onWindowKeydown(e: KeyboardEvent): void {
    const accel = shortcutsState.accel('goto-line');
    if (accel !== null && matchWindowShortcut(e, accel, platform.os)) {
      e.preventDefault();
      openGoto();
    }
  }
  // Esc closes whichever box is open, from the editor too.
  function closeBox(): boolean {
    if (panel === 'none') {
      return false;
    }
    closePanel();
    return true;
  }

  onMount(() => {
    let disposed = false;
    const caret = initialCaret;
    void (async (): Promise<void> => {
      let target = 0;
      let res: WindowRead;
      try {
        // A replace all (or its undo) may still be running from before this
        // editor mounted: the first read waits for it, so it never shows
        // content that is about to change.
        res = await gate.whenIdle(() => {
          totalLines = initialTotalLines;
          target = Math.min(
            Math.max(0, initialTopLine),
            Math.max(0, totalLines - 1),
          );
          const w = nextWindow(target, totalLines, WINDOW_LINES, MARGIN_LINES);
          return invoke<WindowRead>('windowed_read', {
            sessionId,
            startLine: w.startLine,
            endLine: w.endLine,
          });
        });
      } catch (e) {
        onerror(t('editor.locked.read', { detail: String(e) }));
        return;
      }
      if (disposed) {
        return;
      }
      windowStartLine = res.start_line;
      windowStartOffset = res.start_offset;
      windowEndOffset = res.end_offset;
      breaks = scanBreaks(res.text);
      // The tab's line ending is read from the first window when it has none
      // yet, before the editor accepts any input.
      insertSep =
        insertLineEnding ?? ondetectending(detectBreakStyle(res.text));
      totalLines = res.total_lines;
      totalBytes = res.total_bytes;
      const v = new EditorView({
        parent: container,
        state: buildState(res.text),
      });
      view = v;
      windowEndLine = windowStartLine + v.state.doc.lines;
      lastLive = liveSelection(v.state);
      globalSel = toGlobalSelection(lastLive, windowStartLine);
      // Continue from the line the user was viewing: place the caret there and
      // scroll it to the top so the unlock feels like the same view kept its place.
      if (target > windowStartLine || caret !== undefined) {
        const localNo = clamp(
          target - windowStartLine + 1,
          1,
          v.state.doc.lines,
        );
        const cLine = v.state.doc.line(localNo);
        let anchor = cLine.from;
        // A remount puts the caret back where it was when that line is in the
        // window; the scroll below still decides what is on screen.
        if (
          caret !== undefined &&
          caret.line > windowStartLine &&
          caret.line <= windowEndLine
        ) {
          const caretLine = v.state.doc.line(caret.line - windowStartLine);
          anchor = Math.min(
            caretLine.from + Math.max(0, caret.col - 1),
            caretLine.to,
          );
        }
        v.dispatch({ selection: { anchor } });
        requestAnimationFrame(() => scrollLineToTop(target));
      }
      v.scrollDOM.addEventListener('scroll', onScroll);
      v.dom.addEventListener('keydown', onViewKeydown);
      document.addEventListener('keydown', onDocKeydown, true);
      document.addEventListener(
        'compositionstart',
        onDocCompositionStart,
        true,
      );
      document.addEventListener('paste', onDocPaste, true);
      document.addEventListener('cut', onDocCopyCut, true);
      document.addEventListener('copy', onDocCopyCut, true);
      window.addEventListener('keydown', onWindowKeydown);
      window.addEventListener('focus', refreshAltGr);
      refreshAltGr();
      reportSelection();
      // Claim keyboard focus on load so an unlocked/restored windowed tab types
      // without a click.
      focusEditorIfIdle(v, modalOpen);
      if (import.meta.env.DEV) {
        void import('../dev/editorRegistry').then((m) => m.setActiveView(v));
      }
    })();
    void listenForResults(() => disposed);
    return () => {
      disposed = true;
      gone = true;
      releaseSettleWaiters();
      cancelSearch();
      clearTimeout(refreshTimer);
      unlistenHit?.();
      unlistenDone?.();
      window.removeEventListener('keydown', onWindowKeydown);
      window.removeEventListener('focus', refreshAltGr);
      if (selRaf !== 0) {
        cancelAnimationFrame(selRaf);
      }
      if (topRaf !== 0) {
        cancelAnimationFrame(topRaf);
      }
      view?.scrollDOM.removeEventListener('scroll', onScroll);
      view?.dom.removeEventListener('keydown', onViewKeydown);
      document.removeEventListener('keydown', onDocKeydown, true);
      document.removeEventListener(
        'compositionstart',
        onDocCompositionStart,
        true,
      );
      document.removeEventListener('paste', onDocPaste, true);
      document.removeEventListener('cut', onDocCopyCut, true);
      document.removeEventListener('copy', onDocCopyCut, true);
      dropReplay();
      if (import.meta.env.DEV) {
        void import('../dev/editorRegistry').then((m) => m.setActiveView(null));
      }
      view?.destroy();
      view = undefined;
    };
  });

  // Live theme toggle.
  $effect(() => {
    const isDark = dark;
    if (view !== undefined) {
      view.dispatch({
        effects: themeCompartment.reconfigure(varEditorTheme(isDark)),
      });
    }
  });

  // Live word-wrap toggle.
  $effect(() => {
    const wrap = wordWrap;
    if (view !== undefined) {
      view.dispatch({
        effects: wrapCompartment.reconfigure(
          wrap ? EditorView.lineWrapping : [],
        ),
      });
    }
  });

  // Live line-numbers (gutter) toggle.
  $effect(() => {
    const on = showLineNumbers;
    if (view !== undefined) {
      view.dispatch({
        effects: gutterCompartment.reconfigure(gutterExtension(on)),
      });
    }
  });
  // Rebind the customizable commands when the effective shortcuts change.
  $effect(() => {
    const accels = shortcutsState.accelerators;
    const os = platform.os;
    if (view !== undefined) {
      view.dispatch({
        effects: keymapCompartment.reconfigure(
          keymapExtension('windowed', os, (id) => accels[id] ?? null),
        ),
      });
    }
  });

  // DEV/E2E surface. Every window swap appends one entry, so a caret that ends
  // up somewhere the caller did not ask for can be traced to the swap that put
  // it there. Read with `__auto.windowedTrace()`; a CI failure is the only
  // place the interleaving has ever shown up.
  const trace: unknown[] = [];
  function traceSwap(entry: Record<string, unknown>): void {
    if (import.meta.env.DEV) {
      trace.push(entry);
    }
  }

  // DEV/E2E surface, driven by DocumentApp's hooks.
  export function windowedTrace(): unknown[] {
    return trace;
  }

  export function info(): {
    windowStartLine: number;
    totalLines: number;
    totalBytes: number;
  } {
    return { windowStartLine, totalLines, totalBytes };
  }
  // Menu surface: Find, Find and Replace, Find Next, Find Previous.
  export function openFind(): void {
    panel = 'search';
    requestAnimationFrame(() => panels?.focusQuery());
  }
  export function openFindReplace(): void {
    panel = 'search';
    requestAnimationFrame(() => panels?.focusReplace());
  }
  export function findNext(): void {
    void findStep(false);
  }
  export function findPrevious(): void {
    void findStep(true);
  }
  // Whether the find bar or the goto box is open.
  export function panelOpen(): boolean {
    return panel !== 'none';
  }
  export function closeFindPanel(): void {
    closePanel();
  }

  export function goto(line: number): void {
    void loadWindow(
      clamp(Math.round(line) - 1, 0, Math.max(0, totalLines - 1)),
      'goto',
    );
  }

  export function undo(): void {
    runUndo('undo');
  }

  export function redo(): void {
    runUndo('redo');
  }
  // Edit > Select All (the macOS item is custom): the on-screen span, same as
  // Mod-a.
  export function selectAllVisible(): void {
    if (view !== undefined) {
      selectVisible(view);
    }
  }
  // Called by the host before a tab switch: ends an IME composition and
  // resolves once its text has been read into the document and applied.
  export function endComposition(): Promise<void> {
    return settleThenDrain(
      () =>
        view === undefined ? Promise.resolve() : settleViewComposition(view),
      () => applyChain,
    );
  }
  // Whether an IME composition is running in this editor.
  export function isComposing(): boolean {
    return view?.compositionStarted ?? false;
  }
  // Resolves once every edit typed so far has been applied; leaves any
  // composition alone.
  export function applied(): Promise<void> {
    return applyChain;
  }

  // Called by the host when the window regains focus, so a windowed tab types
  // without a click. Idle-gated like every other handoff.
  export function focus(): void {
    focusEditorIfIdle(view, modalOpen);
  }
</script>

<div
  class="windowed-wrap"
  style="--doc-font-size: {fontSize}px; --doc-font-family: {cssFontFamily(
    fontFamily,
  )}"
>
  <div class="editor" bind:this={container}></div>
  <FindPanels
    bind:this={panels}
    {panel}
    bind:gotoValue
    ongotokeydown={onGotoKeydown}
    bind:query={findQuery}
    bind:caseSensitive={findCase}
    bind:replacement={replaceText}
    showReplace
    status={searchStatus}
    {results}
    {cursor}
    {resultQuery}
    {resultCase}
    onsearch={() => searchOrNext(false)}
    onjump={(i) => void jumpToResult(i)}
    onclose={closePanel}
    onsearchkeydown={onSearchKeydown}
    onreplace={() => void replaceOne()}
    onreplaceall={() => void replaceAll()}
  />
</div>

<style>
  .windowed-wrap {
    position: relative;
    height: 100%;
  }
  .editor {
    height: 100%;
    overflow: hidden;
  }
  .editor :global(.cm-editor) {
    height: 100%;
    font-size: var(--doc-font-size);
  }
  .editor :global(.cm-scroller) {
    overflow: auto;
    font-family: var(--doc-font-family);
  }
</style>
