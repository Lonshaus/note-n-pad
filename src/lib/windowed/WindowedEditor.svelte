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
    Prec,
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
  import { settingsState } from '../state/settings.svelte';
  import { platform } from '../state/platform.svelte';
  import { cssFontFamily } from '../util/font';
  import {
    byteLength,
    byteToChar,
    charToByte,
    detectBreakStyle,
    fullyVisibleLineSpan,
    globalFilters,
    inApplyOrder,
    junctionRewrites,
    mapChangesToEdits,
    mapThrough,
    mirrorStep,
    nextWindow,
    scanBreaks,
    selectionFilters,
    type ByteEdit,
    type RawChange,
    WINDOW_LINES,
    MARGIN_LINES,
    swapTarget,
  } from '../util/windowedEdit';
  import {
    clipboardBlocked,
    fitsWindow,
    gotoSelection,
    insideWindow,
    isImeKey,
    isModifierKey,
    isNativeSelectAll,
    queuedSelectEnds,
    replayKind,
    replayReady,
    selectAllTarget,
    selectionAfterChange,
    selectionAfterSwap,
    toGlobalSelection,
    toLiveSelection,
    windowStartFor,
    wholeFileSelection,
    type LinePos,
    type LineSelection,
    type SelectAllEntry,
  } from '../util/windowSelection';
  import {
    blockedWhilePending,
    chordReplaysAtEdge,
    commandChain,
    copiedRange,
    coreKeyBindings,
    decideKey,
    inputWhileSelectAll,
    isSelectAllKey,
    matchesBinding,
    parkedUndoKey,
    pasteIsLinewise,
    pasteSpec,
    replayStartAction,
    replayWanted as replayStateWanted,
    resumeAction,
    settledState,
    swapEndAction,
    type AltGrTable,
    type KeyLayers,
    type ReplayState,
  } from '../util/replayKeys';
  import {
    accumulate,
    finishCapture,
    imeKeyAction,
    captureStartAllowed,
    selectQueued,
    startCapture,
    toCaptureStart,
    updateActions,
    type ImeCapture,
  } from '../util/imeCapture';
  import {
    afterShadowStop,
    dequeueStep,
    docEdgeSelect,
    globalItemAction,
    globalOpPath,
    globalSelectAction,
    globalStartAction,
    groupDecision,
    inputOutside as inputOutsideOf,
    joinAfterStep,
    keepsInput,
    needsEndPos,
    opText,
    shadowStep,
    trackOf,
    undoSelection,
    type ClipCopy,
    type ClipCut,
    type GlobalAction,
    type GlobalOp,
    type OwnCommands,
    type SelectSpec,
  } from '../util/globalRouting';
  import {
    clipCopyRoute,
    runClipCut,
    type ClipInfo,
    type ClipOutcome,
  } from '../util/clipRouting';
  import { createSelectAllGate } from '../util/selectAllGate';
  import { lastLinewiseCopy, rememberCopy } from '../util/linewiseCopy';
  import { liveTokens } from '../util/liveTokens';
  import { convertController } from '../state/convertController.svelte';
  import { pasteEnv } from '../util/pasteEnv';
  import {
    hasClips,
    resolveClip,
    runWindowedPaste,
    windowedPasteAction,
    windowedTextVia,
    type MarkInput,
    type Resolved,
  } from '../util/pasteRouting';
  import {
    ReplayQueue,
    type FinishOutcome,
    type Reservation,
  } from '../util/replayQueue';
  import { focusEditorIfIdle } from '../util/editorFocus';
  import { readCspNonce } from '../util/cspNonce';
  import type { OnApplied } from '../util/windowedApplied';
  import {
    parkGlobalOp,
    parkWindowedRead,
    parkWindowedResult,
  } from '../dev/windowedHold';
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
    // The byte before the window is a lone `\r`; the byte after it is a `\n`.
    prev_lone_cr: boolean;
    next_is_lf: boolean;
  }
  /** Result of a Rust `windowed_apply`: the live file totals after the edit,
   *  whether the content equals the last save, and the content generation. */
  interface ApplyResult {
    total_bytes: number;
    total_lines: number;
    clean: boolean;
    generation: number;
  }
  /** Result of a Rust `windowed_undo`/`windowed_redo`: the global-byte edits just
   *  applied (in application order), the 0-based line of the first edit's start
   *  (for a jump-to-change window reload), and the live file totals. A replace
   *  all undone or redone has no edits: `reload_only` says to reload the window.
   *  A step that moved a spill file sets `reload_only` too, with its edits and no
   *  token. */
  interface UndoResult {
    edits: {
      start: number;
      end: number;
      text: string;
      keep_start?: boolean;
      // A run of break bytes the core rewrote in place to this byte; no text.
      fill?: string | null;
      // Text put back from a spill file: its byte length, with no text.
      len?: number;
    }[];
    first_line: number;
    total_bytes: number;
    total_lines: number;
    reload_only: boolean;
    clean: boolean;
    generation: number;
    // The change list of a replace all undone or redone, for mapping offsets
    // with `windowed_map_replace` until it is released.
    token: number | null;
    // With a `track` argument: its two ends after the change.
    tracked?: [LinePos, LinePos];
  }
  /** Result of a Rust `windowed_replace_all`. */
  interface ReplaceAllResult {
    count: number;
    total_bytes: number;
    total_lines: number;
    clean: boolean;
    generation: number;
    token: number | null;
    tracked?: [LinePos, LinePos];
  }
  /** Result of a Rust `windowed_replace_range` or `windowed_enter`. */
  interface RangeResult extends OpTotals {
    edits: UndoResult['edits'];
    cursor: LinePos;
  }
  /** Result of a Rust `windowed_indent_range`. */
  interface IndentResult extends OpTotals {
    edits: UndoResult['edits'];
    anchor: LinePos;
    head: LinePos;
  }
  /** What a global operation reports to the window swap that ran it: the edits
   *  it made, the selection it leaves and the file's totals. */
  interface GlobalResult extends OpTotals {
    edits: UndoResult['edits'];
    sel: LineSelection;
  }
  /** What a whole-file operation reports back. */
  interface OpTotals {
    total_bytes: number;
    total_lines: number;
    clean: boolean;
    generation: number;
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
    // Fired after each successful apply, undo or redo so the state layer records
    // the fresh totals and sets the tab's dirty flag. It names this editor's own
    // session: the active tab may be another one by the time a result arrives.
    onapplied: OnApplied;
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
  // The byte before the window is a lone `\r`, and the byte after it a `\n`: the
  // window's two edges, where an edit can join a lone `\r` to a `\n` that the
  // window does not hold. Set by every read of a window; see `junctionRewrites`.
  let windowPrevLoneCr = false;
  let windowNextIsLf = false;
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
  // True while the editor sets the view's selection to where the queued input
  // acts, which is no move of the user's.
  let settingSelection = false;
  // While a click waits in the queue the view shows it, but the caret the queued
  // input acts at is where the view's selection was before it: that position,
  // followed through the changes made meanwhile.
  let heldCaret: { anchor: number; head: number } | null = null;
  // Grouping context of the previous applied edit, used to decide whether the next
  // edit opens a new undo group or coalesces into the current one.
  let lastApplyTime = 0;
  let lastEditKind: string | null = null;
  // Set for the one edit a Replace makes, so it opens its own undo group.
  let forceNewGroup = false;
  // Set after a global delete: the text typed over the selection joins its group.
  let joinNextApply = false;
  // A global operation of this editor runs; the gate it holds is its own.
  let ownGlobalOp = false;
  // DEV/E2E counters: window installs, `windowed_apply` calls, global commands.
  let windowInstalls = 0;
  let applyCalls = 0;
  let globalCalls = 0;
  let prevComposing = false;
  // Applies queued or running, for the exits that must not leave with one in
  // flight.
  let pendingApplies = 0;

  const wrapCompartment = new Compartment();
  const themeCompartment = new Compartment();
  const gutterCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();
  const keymapCompartment = new Compartment();
  const coreKeysCompartment = new Compartment();
  // The rebindable commands' keys, rebuilt whenever the shortcuts change.
  function currentKeymap(): Extension {
    return keymapExtension('windowed', platform.os, (id) =>
      shortcutsState.accel(id),
    );
  }
  // While the swap back to the caret keeps the editor editable, its key
  // bindings are taken out: a key does there what it did on <body> during any
  // other swap, with its default action and the window's accelerators intact.
  let keysParked = false;
  function parkKeys(parked: boolean): void {
    keysParked = parked;
    view?.dispatch({
      effects: [
        keymapCompartment.reconfigure(parked ? [] : currentKeymap()),
        coreKeysCompartment.reconfigure(parked ? [] : coreKeys),
      ],
    });
  }
  // CodeMirror's own keydown handling ends the moment after Escape in which Tab
  // leaves the editor. A key that lands while the keys are parked leaves it as
  // it was. The field is internal to CodeMirror.
  let tabFocusBefore: { event: KeyboardEvent; mode: number } | null = null;
  function tabFocusState(v: EditorView): { tabFocusMode: number } {
    return (v as unknown as { inputState: { tabFocusMode: number } })
      .inputState;
  }
  // The gutter renders global line numbers by adding the window's start line to
  // CM's local (1-based) line number. The closure reads the live windowStartLine,
  // so a swap repaints with the correct offset without reconfiguring.
  function gutterExtension(
    on: boolean,
    startLine: () => number = () => windowStartLine,
  ): Extension {
    return on
      ? [
          lineNumbers({ formatNumber: (n) => String(n + startLine()) }),
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
    return (
      (locked || swapping || holds > 0 || gate.readOnly()) && !swapKeepsInput()
    );
  }
  // The swap back to the caret leaves the editor editable, so focus and the
  // input method stay put: a composition begun while it runs is captured, and
  // the swap's transaction filter still rejects every other edit.
  function swapKeepsInput(): boolean {
    return keepsInput({
      swapping,
      replaySwap: replaySwapActive,
      locked,
      holds,
      gateReadOnly: gate.readOnly(),
      ownGlobalOp,
    });
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
  // Select All covers what is on screen, not the whole loaded window; under the
  // "file" setting it asks for the whole file and returns at once.
  function selectVisible(
    v: EditorView,
    entry: SelectAllEntry = 'key',
  ): boolean {
    if (selectAllTarget(settingsState.largeSelectAll, entry) === 'file') {
      selectAllGate.request();
      return true;
    }
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
  // rendered viewport; replace it with the on-screen span. Under the "file"
  // setting the Select All it asked for takes over (see `selectionFilters`).
  function narrowNativeSelectAll(
    tr: Transaction,
  ): TransactionSpec | Transaction {
    const v = view;
    if (
      v === undefined ||
      swapping ||
      tr.selection === undefined ||
      selectAllTarget(settingsState.largeSelectAll, 'native') === 'file'
    ) {
      return tr;
    }
    const main = tr.selection.main;
    if (
      !isNativeSelectAll({
        docChanged: tr.docChanged,
        isSelect: tr.isUserEvent('select'),
        isPointer: tr.isUserEvent('select.pointer'),
        keyActive,
        from: main.from,
        to: main.to,
        viewportFrom: v.viewport.from,
        viewportTo: v.viewport.to,
      })
    ) {
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
  ];
  const coreKeys: Extension = keymap.of(
    coreKeyBindings({
      closeBox,
      selectVisible,
      undo: undoCommand,
      redo: redoCommand,
    }),
  );

  function buildState(doc: string, cursorPos?: number): EditorState {
    return EditorState.create({
      doc,
      ...(cursorPos !== undefined ? { selection: { anchor: cursorPos } } : {}),
      extensions: [
        // Required in every view, see the note in Editor.svelte.
        EditorView.cspNonce.of(readCspNonce()),
        coreSetup,
        // A drop during the swap back to the caret is refused, as read-only
        // refuses it during any other swap.
        Prec.highest(
          EditorView.domEventHandlers({
            drop: (e) => {
              if (!swapKeepsInput()) {
                return false;
              }
              e.preventDefault();
              return true;
            },
          }),
        ),
        keymapCompartment.of(keysParked ? [] : currentKeymap()),
        coreKeysCompartment.of(keysParked ? [] : coreKeys),
        // Applied at creation only: a setState here can move the caret (see the
        // `swapping` filter below) and the one phrase used is the control-char
        // tooltip, which picks up a new language the next time a file opens.
        cmPhraseExtension(),
        gutterCompartment.of(gutterExtension(showLineNumbers)),
        wrapCompartment.of(wordWrap ? EditorView.lineWrapping : []),
        themeCompartment.of(varEditorTheme(dark)),
        readOnlyCompartment.of(readOnlyExtension(isReadOnly())),
        // Commands that ignore readOnly (insertTab) could still change the
        // document mid-swap, and the update listener would drop that change.
        // The filters run as: the rejection of what acts outside the window,
        // the late text of a composition, the refusal of a user edit under a
        // selection too large for one window, the swap's refusal. A
        // composition captured during the swap back to the caret passes.
        globalFilters<KeyboardEvent>({
          swapping: () => swapping,
          locked: () => locked,
          holds: () => holds,
          capturing: () => capture !== null,
          pendingIme: () => pendingIme,
          late: () => Date.now() < lateUntil,
          replayPending: () => replayPending,
          draining: () => draining,
          keyActive: () => keyActive,
          keydown: () => currentKeydown,
          globalSel: () => globalSel,
          outside: (doc) => inputOutside(doc),
          exempt: (tr) =>
            tr.annotation(selectVisibleMark) === true ||
            tr.annotation(captureMark) === true,
          captureMark: (tr) => tr.annotation(captureMark) === true,
          chord: (e) => replayKind(e, platform.os) === 'chord',
          bound: (e) => matchesBinding(keyLayers(), e, platform.os),
          defer: (run) => run(),
          queueText: (text) =>
            queueDeferred({ kind: 'text', text, userEvent: 'input.type' }),
          queueKey: (e) => queueDeferred({ kind: 'key', event: e }),
        }),
        // A Select All waiting to run takes no new edit from the user.
        EditorState.transactionFilter.of((tr) =>
          blockedWhilePending({
            pending: selectAllGate.pending(),
            docChanged: tr.docChanged,
            userEvent: tr.annotation(Transaction.userEvent),
            replayDispatch: tr.annotation(replayDispatchMark) === true,
            replayingKey,
          })
            ? []
            : tr,
        ),
        // setState tears down the DOM of the old window while the browser
        // selection still points into it, so the selection collapses and the
        // DOM observer syncs that wreckage back as a plain 'select'
        // transaction, landing the caret on the new window's last line. The
        // swap has already put the caret where the caller asked for, so during
        // a swap the DOM is not a selection source. Only DOM-derived syncs are
        // dropped: our own dispatches carry no userEvent, a pointer selection
        // carries 'select.pointer'. A composition captured in the swap back
        // to the caret keeps its syncs (see dropSwapSelect). The same factory
        // builds the filter that notes a native select-all, which must run
        // before that one.
        selectionFilters({
          swapping: () => swapping,
          keep: () => capture !== null && swapKeepsInput(),
          mode: () => settingsState.largeSelectAll,
          keyActive: () => keyActive,
          viewport: () =>
            view === undefined
              ? null
              : { from: view.viewport.from, to: view.viewport.to },
          request: () => selectAllGate.request(),
        }),
        EditorView.updateListener.of((update) => {
          // A click made while input is queued, or a composition is open,
          // joins the queue and takes effect in its place in the order.
          if (
            selectQueued({
              pointer:
                update.selectionSet &&
                !update.docChanged &&
                update.transactions.some((tr) =>
                  tr.isUserEvent('select.pointer'),
                ),
              replayPending,
              capturing: capture !== null,
            })
          ) {
            queueSelect(update);
            reportSelection();
            return;
          }
          const act = updateActions({
            docChanged: update.docChanged,
            selectionSet: update.selectionSet,
            swapping,
            applyingRemote,
            capturing: capture !== null,
          });
          if (act.accumulate) {
            captureUpdate(update);
          }
          if (act.edit) {
            handleUserEdit(update);
          }
          if (act.track && !settingSelection) {
            if (heldCaret === null) {
              trackSelection(update.state, update.docChanged);
            } else if (update.docChanged) {
              heldCaret = {
                anchor: update.changes.mapPos(heldCaret.anchor),
                head: update.changes.mapPos(heldCaret.head),
              };
              trackSelection(update.state, true, {
                anchor: livePos(update.state.doc, heldCaret.anchor),
                head: livePos(update.state.doc, heldCaret.head),
              });
            }
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
  function trackSelection(
    state: EditorState,
    docChanged: boolean,
    liveOverride?: LineSelection,
  ): void {
    const live = liveOverride ?? liveSelection(state);
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
  // The geometry that turns a view's positions into the core's bytes. The main
  // view keeps its own in the variables above, the shadow in its record.
  interface Geometry {
    startLine: number;
    startOffset: number;
    endLine: number;
    endOffset: number;
    breaks: string[];
    prevLoneCr: boolean;
    nextIsLf: boolean;
  }
  function mainGeometry(): Geometry {
    return {
      startLine: windowStartLine,
      startOffset: windowStartOffset,
      endLine: windowEndLine,
      endOffset: windowEndOffset,
      breaks,
      prevLoneCr: windowPrevLoneCr,
      nextIsLf: windowNextIsLf,
    };
  }
  function takeMainGeometry(g: Geometry): void {
    windowStartOffset = g.startOffset;
    windowEndLine = g.endLine;
    windowEndOffset = g.endOffset;
    breaks = g.breaks;
    windowPrevLoneCr = g.prevLoneCr;
    windowNextIsLf = g.nextIsLf;
  }
  // The transaction's changes as global byte edits in the window `g`, plus the
  // rewrite of every lone `\r` the changes would join to a `\n` (appended after
  // the changes, in the same pre-apply coordinates). The window's break list and
  // its end follow the post-change document; its start moves only when the
  // byte just before it is rewritten to a longer separator.
  function convertUpdate(g: Geometry, update: ViewUpdate): ByteEdit[] {
    const docBefore = update.startState.doc.toString();
    const changes: RawChange[] = [];
    update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      changes.push({ fromA, toA, inserted: inserted.toString() });
    });
    const edits = mapChangesToEdits(
      g.startOffset,
      docBefore,
      g.breaks,
      insertSep,
      changes,
    );
    const junction = junctionRewrites(
      docBefore,
      g.breaks,
      changes,
      insertSep,
      g.prevLoneCr,
      g.nextIsLf,
    );
    for (const rewrite of junction.rewrites) {
      const at = g.startOffset + rewrite.at;
      edits.push({
        start: at,
        end: at + 1,
        text: insertSep,
        keep_start: true,
        cascade: true,
      });
    }
    g.breaks = junction.breaksAfter;
    g.startOffset += junction.startShift;
    g.prevLoneCr = junction.prevLoneCr;
    const docAfter = update.state.doc.toString();
    g.endOffset =
      g.startOffset + charToByte(docAfter, g.breaks, docAfter.length);
    g.endLine = g.startLine + update.state.doc.lines;
    return edits;
  }
  // Whether the edit opens a new undo group, shared by both views.
  function groupFor(update: ViewUpdate, composing: boolean): boolean {
    const now = Date.now();
    const kind = editKind(update);
    // A Replace is a step of its own, however soon it follows other typing; the
    // text typed over a selection joins the global delete that cleared it.
    const newGroup = groupDecision({
      joinNextApply,
      forceNewGroup,
      prev: {
        time: lastApplyTime,
        kind: lastEditKind,
        composing: prevComposing,
      },
      current: {
        time: now,
        kind,
        composing,
        compositionStart: composing && !prevComposing,
      },
    });
    joinNextApply = false;
    forceNewGroup = false;
    lastApplyTime = now;
    lastEditKind = kind;
    prevComposing = composing;
    return newGroup;
  }
  // Hand edits made in a view to the core. `shown` is whether the main view
  // already holds them; `lineDelta` is how many lines they added to the window.
  function dispatchEdits(
    edits: ByteEdit[],
    newGroup: boolean,
    shown: boolean,
    lineDelta: number,
  ): void {
    editSeq += 1;
    scheduleResultsRefresh();
    logChange({ edits: inApplyOrder(edits) }, shown);
    enqueueApply(edits, newGroup, lineDelta);
  }
  // A step that moved the core's line count and the window's by different
  // amounts: the window and the file no longer agree on where lines are. The
  // caller reads the window again.
  function junctionMismatch(coreDelta: number, windowDelta: number): void {
    traceSwap({ at: 'junctionMismatch', coreDelta, windowDelta });
  }
  function lineDeltaOf(update: ViewUpdate): number {
    return update.state.doc.lines - update.startState.doc.lines;
  }
  // A user edit inside the current window: translate the transaction's changes to
  // global byte edits, decide its undo group, and enqueue an apply.
  function handleUserEdit(update: ViewUpdate): void {
    const g = mainGeometry();
    const edits = convertUpdate(g, update);
    takeMainGeometry(g);
    dispatchEdits(
      edits,
      groupFor(update, view?.composing ?? false),
      true,
      lineDeltaOf(update),
    );
  }

  function enqueueApply(
    edits: ByteEdit[],
    newGroup: boolean,
    lineDelta: number,
  ): void {
    // The prop reads the host's current tab, which is another one by the time a
    // result arrives after a tab switch.
    const owner = sessionId;
    pendingApplies += 1;
    applyChain = applyChain.then(async () => {
      try {
        if (locked) {
          return;
        }
        if (!gate.canApply()) {
          // Unreachable while the editor is read-only; refusing here would
          // leave the typed text out of the core, so say so instead of
          // drifting.
          lock(t('editor.locked.write', { detail: 'busy' }));
          return;
        }
        const linesBefore = totalLines;
        let res: ApplyResult;
        try {
          applyCalls += 1;
          res = await invoke<ApplyResult>('windowed_apply', {
            sessionId: owner,
            edits,
            newGroup,
          });
        } catch (e) {
          lock(t('editor.locked.write', { detail: String(e) }));
          return;
        }
        if (import.meta.env.DEV) {
          const parked = parkWindowedResult();
          if (parked !== null) {
            await parked;
          }
        }
        totalBytes = res.total_bytes;
        totalLines = res.total_lines;
        onapplied(
          owner,
          res.total_bytes,
          res.total_lines,
          res.clean,
          res.generation,
        );
        if (res.total_lines - linesBefore !== lineDelta) {
          junctionMismatch(res.total_lines - linesBefore, lineDelta);
          void reloadWindow();
        }
        reportSelection();
      } finally {
        pendingApplies -= 1;
        notifyFlushWaiters();
      }
    });
  }
  // Set around the synchronous call of a key command the drain replays, so an
  // undo bound to that key runs in its place in the queue.
  let replayingKey = false;
  // An undo or redo asked for. It joins the replay queue while input is queued,
  // a composition is open, a swap runs or the shadow does, so it runs in the
  // order it was pressed in; otherwise it runs now.
  function runUndo(dir: 'undo' | 'redo'): void {
    if (locked) {
      return;
    }
    if (
      !replayingKey &&
      (replayPending || capture !== null || swapping || shadow !== null)
    ) {
      queueUndo(dir);
      return;
    }
    runUndoNow(dir);
  }
  function queueUndo(dir: 'undo' | 'redo'): void {
    replayQueue.enqueue({ kind: dir });
    replayPending = true;
    wakeShadow();
    notifyFlushWaiters();
    // Anything running carries on with the queue when it ends.
    if (
      !swapping &&
      capture === null &&
      shadow === null &&
      !draining &&
      holds === 0 &&
      replayTimer === undefined
    ) {
      resumeReplay();
    }
  }
  // Run an undo or redo: serialized behind the apply chain (so it never races an
  // in-flight edit), it invokes the Rust journal command and mirrors the result.
  // A "nothing to undo/redo" is a silent no-op; any other failure locks the editor
  // via the same path an apply failure does.
  function runUndoNow(dir: 'undo' | 'redo'): void {
    if (locked || swapping) {
      return;
    }
    // Input typed from here to the end of the undo is queued: it replays at
    // the caret the undo leaves, instead of landing on content about to change.
    const release = hold(true);
    // Same as `enqueueApply`: the session this undo was asked of.
    const owner = sessionId;
    applyChain = applyChain.then(async () => {
      try {
        if (locked || view === undefined) {
          return;
        }
        const res = await coreUndo(owner, dir, trackOf(globalSel));
        if (res === null) {
          return;
        }
        if (!res.reload_only) {
          // Records the fresh totals and sets the tab's dirty flag.
          onapplied(
            owner,
            res.total_bytes,
            res.total_lines,
            res.clean,
            res.generation,
          );
        }
        applyUndoResult(res);
      } finally {
        release();
      }
    });
  }
  // The core's undo or redo. Null when there is nothing to undo or the editor
  // locked on a failure.
  async function coreUndo(
    owner: number,
    dir: 'undo' | 'redo',
    track: [LinePos, LinePos] | undefined,
  ): Promise<UndoResult | null> {
    try {
      return await runop(
        owner,
        () =>
          invoke<UndoResult>(
            dir === 'undo' ? 'windowed_undo' : 'windowed_redo',
            {
              sessionId: owner,
              ...(track !== undefined ? { track } : {}),
            },
          ),
        (r) => r.reload_only,
      );
    } catch (e) {
      const msg = String(e);
      if (msg.includes('nothing-to-undo') || msg.includes('nothing-to-redo')) {
        return null;
      }
      lock(t('editor.locked.undo', { detail: msg }));
      return null;
    }
  }
  // Whether the edits lie inside the window `g`, tracking its end as each
  // shifts it.
  function editsInWindow(g: Geometry, edits: UndoResult['edits']): boolean {
    let end = g.endOffset;
    for (const e of edits) {
      if (e.start < g.startOffset || e.end > end) {
        return false;
      }
      end += e.fill ? 0 : (e.len ?? byteLength(e.text)) - (e.end - e.start);
    }
    return true;
  }
  // Dispatch undo/redo edits into a view as local changes, byte to char mapped
  // (a run of break bytes the core rewrote in place changes the break list
  // only). Returns how many landed: one whose boundary falls inside a CRLF has no
  // document position and stops the rest.
  function mirrorEdits(
    v: EditorView,
    g: Geometry,
    edits: UndoResult['edits'],
  ): number {
    let landed = 0;
    for (const e of edits) {
      const step = mirrorStep(
        v.state.doc.toString(),
        g.breaks,
        g.startOffset,
        e,
      );
      if (step === null) {
        break;
      }
      if (step.change !== null) {
        v.dispatch({ changes: step.change });
      }
      g.breaks = step.breaks;
      landed += 1;
    }
    const docAfter = v.state.doc.toString();
    g.endOffset =
      g.startOffset + charToByte(docAfter, g.breaks, docAfter.length);
    g.endLine = g.startLine + v.state.doc.lines;
    return landed;
  }
  // The change an undo made lies outside the window: show it. A tracked
  // selection is revealed at its head, not replaced by a caret at the change.
  function jumpAfterUndo(res: UndoResult): void {
    const jump = undoSelection({ tracked: res.tracked, branch: 'goto' });
    if (jump.sel !== null) {
      globalSel = jump.sel;
      void loadWindow(jump.sel.head.line, 'reveal');
    } else {
      void loadWindow(res.first_line, 'goto');
    }
  }
  // Mirror an undo/redo result into the view. If every applied edit lands inside
  // the current window's byte range, dispatch them as local CM changes (byte→char
  // mapped, suppressing the re-send to Rust); otherwise the change is off-window,
  // so reload the window at the change (standard editor jump-to-undo behaviour).
  // Whatever the view does not show yet is kept for the clicks made on it.
  function applyUndoResult(res: UndoResult): void {
    if (view === undefined) {
      releaseToken(res.token);
      return;
    }
    editSeq += 1;
    scheduleResultsRefresh();
    if (res.reload_only) {
      // A replace all undone or redone: the state layer has recorded the totals
      // and the dirty flag; the window shows the content as it is now.
      totalLines = res.total_lines;
      totalBytes = res.total_bytes;
      // The selection a window does not mirror follows the change.
      const reloaded = undoSelection({
        tracked: res.tracked,
        branch: 'reload_only',
      });
      if (reloaded.sel !== null) {
        globalSel = reloaded.sel;
      }
      if (res.token !== null) {
        logChange({ token: res.token }, false);
        void reloadWindow();
        return;
      }
      // A step that moved a spill file: the text is not sent, so the window is
      // read again, at the change when it lies outside.
      logChange({ edits: res.edits }, false);
      if (editsInWindow(mainGeometry(), res.edits)) {
        void reloadWindow();
      } else {
        jumpAfterUndo(res);
      }
      return;
    }
    const linesBefore = totalLines;
    totalLines = res.total_lines;
    totalBytes = res.total_bytes;
    const g = mainGeometry();
    if (!editsInWindow(g, res.edits)) {
      logChange({ edits: res.edits }, false);
      jumpAfterUndo(res);
      return;
    }
    const windowLines = g.endLine - g.startLine;
    let landed: number;
    applyingRemote = true;
    try {
      landed = mirrorEdits(view, g, res.edits);
    } finally {
      applyingRemote = false;
    }
    takeMainGeometry(g);
    if (swapping && landed > 0) {
      docChangedDuringSwap = true;
    }
    if (landed < res.edits.length) {
      // An edit boundary inside a CRLF has no document position; the window
      // is reloaded from the core instead of guessing one.
      if (landed > 0) {
        logChange({ edits: res.edits.slice(0, landed) }, true);
      }
      logChange({ edits: res.edits.slice(landed) }, false);
      jumpAfterUndo(res);
      return;
    }
    logChange({ edits: res.edits }, true);
    // The mirrored edits moved the selection to the window's; it is the
    // tracked one.
    const mirrored = undoSelection({ tracked: res.tracked, branch: 'mirror' });
    if (mirrored.sel !== null) {
      globalSel = mirrored.sel;
      alignViewToGlobal(view);
    }
    if (
      res.total_lines - linesBefore !==
      g.endLine - g.startLine - windowLines
    ) {
      junctionMismatch(
        res.total_lines - linesBefore,
        g.endLine - g.startLine - windowLines,
      );
      void reloadWindow();
    }
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
  // cannot walk focus out of the editor. The swap back to the caret is the one
  // exception to read-only (see swapKeepsInput): only a captured composition
  // gets through, and the swap waits for it before the setState.
  function beginSwap(): void {
    hadFocusAtSwap = view?.hasFocus ?? false;
    docChangedDuringSwap = false;
    swapping = true;
    view?.dispatch({
      effects: readOnlyCompartment.reconfigure(
        readOnlyExtension(!swapKeepsInput()),
      ),
    });
    if (swapKeepsInput()) {
      parkKeys(true);
    }
  }
  function endSwap(): void {
    if (!swapping) {
      return;
    }
    swapping = false;
    if (keysParked) {
      parkKeys(false);
    }
    if (!locked) {
      syncReadOnly();
      // A pointer selection made after the swap's setState was not tracked,
      // unless it was queued.
      if (
        view !== undefined &&
        !replayPending &&
        capture === null &&
        !queueHasSelect()
      ) {
        trackSelection(view.state, false);
      }
      const active = document.activeElement;
      if (
        view !== undefined &&
        hadFocusAtSwap &&
        (active === null || active === document.body)
      ) {
        // WebKit scrolls a refocused editor to its caret, which a swap may
        // have clamped to the window's first line; keep the restored view.
        const top = view.scrollDOM.scrollTop;
        view.focus();
        view.scrollDOM.scrollTop = top;
      }
    }
    const after = swapEndAction({
      replayPending,
      replaySwap: replaySwapActive,
      capturing: capture !== null,
    });
    replaySwapActive = false;
    if (after === 'drain') {
      void drainReplay();
    } else if (after === 'resume') {
      resumeReplay();
    }
    notifySettled();
  }
  // Input typed while the selection lies outside the window (and fits one) is
  // queued, the window is swapped back to the selection, and the queue is then
  // replayed there as ordinary user transactions.
  // A pointer selection made while input is queued waits in the queue as
  // global byte offsets, and takes effect in its place in the order.
  interface SelectEnd {
    off: number;
    // How many logged core changes `off` already reflects.
    at: number;
  }
  interface SelectItem {
    kind: 'select';
    anchor: SelectEnd;
    head: SelectEnd;
    // The pass that brings the ends up to date with the core, while one runs.
    mapping: Promise<void> | null;
  }
  type ReplayItem =
    | { kind: 'text'; text: string; userEvent: string }
    | {
        kind: 'key';
        event: KeyboardEvent;
        // A selection key whose effect on the global selection is done: it
        // only needs its replay on the window holding the head.
        handled?: true;
        // The selection to put back when that replay does nothing.
        restore?: LineSelection;
      }
    | {
        kind: 'copy' | 'cut';
        supply: (text: string | null) => void;
        written: Promise<boolean>;
      }
    // A copy or cut of a selection too large for the web clipboard: it goes
    // through a clip file, and nothing waits for a write.
    | { kind: 'copy' | 'cut'; clip: true }
    // A paste: what the clipboard holds is asked of the core when it is taken
    // out. `mark` was taken at the event, and stays as it was.
    | { kind: 'clipPaste'; mark: MarkInput }
    | SelectItem
    | { kind: 'undo' | 'redo' }
    // Held by an open composition: nothing passes it until its commit takes
    // the place.
    | { kind: 'slot' };
  // The queue and, with it, the clip reservations of the copies and cuts in it.
  const replayQueue = new ReplayQueue<ReplayItem>({
    reserve: () => invoke<Reservation>('clip_copy_reserve'),
    release: (token) => {
      invoke('clip_copy_release', { token }).catch(() => {});
    },
  });
  // True from the first queued item until the queue has drained, so nothing
  // overtakes it.
  let replayPending = false;
  let draining = false;
  let replayTimer: ReturnType<typeof setTimeout> | undefined;
  // The swap now running is the one that brings the window back to the
  // selection for the queue.
  let replaySwapActive = false;
  // The composition running while the selection lies outside the window, and the
  // state it began from. Its changes stay out of the core and out of globalSel;
  // they are undone when it ends and the committed text is replayed.
  let capture: ImeCapture | null = null;
  let captureStart: EditorState | null = null;
  // Marks the transaction that undoes a capture.
  const captureMark = Annotation.define<boolean>();
  // Marks a transaction the replay dispatches for input accepted earlier.
  const replayDispatchMark = Annotation.define<boolean>();
  // An input method key came and no composition has started yet.
  let pendingIme = false;
  // Until then, the last text of a capture that ended may still arrive.
  let lateUntil = 0;
  const LATE_MS = 100;
  // How long after a commit the swap back to the caret waits for the next
  // composition of the run.
  const CHAIN_MS = 40;

  function isWindows(): boolean {
    return platform.os === 'windows';
  }
  // Whether input acts outside the loaded window `doc`: the selection lies
  // outside it, or is too large for any window.
  function inputOutside(doc: Text): boolean {
    return inputOutsideOf(globalSel, {
      startLine: windowStartLine,
      lineCount: doc.lines,
    });
  }
  // --- Pointer selections in the queue ---------------------------------------
  // Every change made to the core's content, in order: the edits of either
  // view, an undo or redo result, a replace all as its token. A queued
  // selection brings its offsets up to date by passing the changes it has not
  // seen yet, each exactly once. An entry goes once nothing can need it, and a
  // token it holds is released to the core.
  type CoreChange = { edits: ByteEdit[] } | { token: number };
  let changeLog: CoreChange[] = [];
  let logBase = 0;
  // The first logged change the main view does not show yet. A click made on
  // that view converts its offsets in the frame before it.
  let unshownFrom: number | null = null;

  function logHead(): number {
    return logBase + changeLog.length;
  }
  function logChange(change: CoreChange, shown: boolean): void {
    if (!shown && unshownFrom === null) {
      unshownFrom = logHead();
    }
    changeLog.push(change);
    for (const item of replayQueue.items) {
      if (item.kind === 'select') {
        advanceItem(item);
      }
    }
    trimLog();
  }
  function releaseToken(token: number | null): void {
    if (token !== null) {
      invoke('windowed_release_replace', { sessionId, token }).catch(() => {});
    }
  }
  // Forget the changes no queued selection and no stale view can still need.
  function trimLog(): void {
    let keep = logHead();
    if (unshownFrom !== null) {
      keep = Math.min(keep, unshownFrom);
    }
    for (const item of replayQueue.items) {
      if (item.kind === 'select') {
        keep = Math.min(keep, item.anchor.at, item.head.at);
      }
    }
    while (logBase < keep) {
      const gone = changeLog.shift();
      if (gone !== undefined && 'token' in gone) {
        releaseToken(gone.token);
      }
      logBase += 1;
    }
  }
  // Pass the edits logged after the end, up to the first token (whose mapping
  // is the core's). True when the end is up to date.
  function advanceEnd(end: SelectEnd): boolean {
    while (end.at < logHead()) {
      const change = changeLog[end.at - logBase];
      if (change === undefined || 'token' in change) {
        return change === undefined;
      }
      end.off = mapThrough(end.off, change.edits);
      end.at += 1;
    }
    return true;
  }
  // Bring a queued selection up to date: edits at once, a token through the
  // core in a pass that runs until nothing is left to pass.
  function advanceItem(item: SelectItem): void {
    if (item.mapping !== null) {
      return;
    }
    const anchorDone = advanceEnd(item.anchor);
    const headDone = advanceEnd(item.head);
    if (!anchorDone || !headDone) {
      item.mapping = mapEnds(item);
    }
  }
  async function mapEnds(
    item: SelectItem,
    first?: Promise<void>,
  ): Promise<void> {
    try {
      await first;
      for (;;) {
        const waiting = [item.anchor, item.head].filter(
          (end) => end.at < logHead(),
        );
        const at = Math.min(...waiting.map((end) => end.at));
        const change = changeLog[at - logBase];
        if (waiting.length === 0 || change === undefined) {
          break;
        }
        const group = waiting.filter((end) => end.at === at);
        if ('token' in change) {
          const out = await invoke<number[]>('windowed_map_replace', {
            sessionId,
            token: change.token,
            offsets: group.map((end) => end.off),
          });
          group.forEach((end, i) => {
            end.off = out[i] ?? end.off;
            end.at += 1;
          });
        } else {
          for (const end of group) {
            end.off = mapThrough(end.off, change.edits);
            end.at += 1;
          }
        }
      }
    } catch (e) {
      // A selection that left the queue meanwhile may have lost its token.
      if (replayQueue.includes(item)) {
        lock(t('editor.locked.write', { detail: String(e) }));
      }
    } finally {
      item.mapping = null;
    }
  }
  // Resolves once the selection is up to date with every change logged so far.
  async function mapped(item: SelectItem): Promise<void> {
    for (;;) {
      advanceItem(item);
      if (item.mapping === null) {
        return;
      }
      await item.mapping;
    }
  }
  function lastSelect(): SelectItem | null {
    for (let i = replayQueue.length - 1; i >= 0; i -= 1) {
      const item = replayQueue.items[i];
      if (item !== undefined && item.kind === 'select') {
        return item;
      }
    }
    return null;
  }
  // A document position of the view as a global byte offset. While a
  // composition is open the view holds text the core does not, so the position
  // is first taken back to the document the composition began from.
  function viewOffset(pos: number): number {
    const v = view;
    if (v === undefined) {
      return windowStartOffset;
    }
    let doc = v.state.doc;
    let at = pos;
    if (capture !== null && captureStart !== null) {
      at = toCaptureStart(capture.changes, captureStart.doc, pos);
      doc = captureStart.doc;
    }
    return windowStartOffset + charToByte(doc.toString(), breaks, at);
  }
  // The window around global line `line`, as the swap to that line shows it,
  // read from the core.
  function readAround(line: number): Promise<WindowRead> {
    const w = nextWindow(line, totalLines, WINDOW_LINES, MARGIN_LINES);
    return invoke<WindowRead>('windowed_read', {
      sessionId,
      startLine: w.startLine,
      endLine: w.endLine,
    });
  }
  // A global line and column as an end in the core's frame: from the view when
  // its window holds the line, else read from the core behind the edits typed
  // so far.
  async function coreEndOf(pos: LinePos): Promise<SelectEnd> {
    const v = view;
    if (v !== undefined) {
      const doc =
        capture !== null && captureStart !== null
          ? captureStart.doc
          : v.state.doc;
      const local = pos.line - windowStartLine;
      if (local >= 0 && local < doc.lines) {
        const line = doc.line(local + 1);
        const at = line.from + Math.min(pos.col, line.length);
        return {
          off: windowStartOffset + charToByte(doc.toString(), breaks, at),
          at: unshownFrom ?? logHead(),
        };
      }
    }
    // The read runs behind everything dispatched so far; the changes the core
    // has made by then are the ones already in what it reads.
    const { read, at } = await behindApplies(async () => {
      const here = logHead();
      return { read: await readAround(pos.line), at: here };
    });
    // The position is found in the text as the view would hold it.
    const lines = read.text.replace(/\r\n|\r/g, '\n').split('\n');
    const local = clamp(pos.line - read.start_line, 0, lines.length - 1);
    let from = 0;
    for (let i = 0; i < local; i += 1) {
      from += (lines[i]?.length ?? 0) + 1;
    }
    const doc = lines.join('\n');
    const col = Math.min(pos.col, lines[local]?.length ?? 0);
    return {
      off:
        read.start_offset + charToByte(doc, scanBreaks(read.text), from + col),
      at,
    };
  }
  // Queue a pointer selection of the main view.
  function queueSelect(update: ViewUpdate): void {
    const prev = update.startState.selection.main;
    const next = update.state.selection.main;
    const at = unshownFrom ?? logHead();
    const last = lastSelect();
    const ends = queuedSelectEnds<SelectEnd>(
      prev,
      next,
      (pos) => ({ off: viewOffset(pos), at }),
      last !== null
        ? { anchor: { ...last.anchor }, head: { ...last.head } }
        : { anchor: { off: 0, at }, head: { off: 0, at } },
    );
    const item: SelectItem = {
      kind: 'select',
      anchor: ends.anchor,
      head: ends.head,
      mapping: null,
    };
    // Without a queued selection the end a click left alone is the global one.
    const unmoved: ('anchor' | 'head')[] = [];
    if (last === null) {
      if (prev.anchor === next.anchor) {
        unmoved.push('anchor');
      }
      if (prev.head === next.head) {
        unmoved.push('head');
      }
    }
    if (heldCaret === null && last === null) {
      heldCaret = { anchor: prev.anchor, head: prev.head };
    }
    replayQueue.enqueueSelect(item);
    if (unmoved.length > 0) {
      const jobs = unmoved.map((key) => coreEndOf(globalSel[key]));
      item.mapping = mapEnds(
        item,
        Promise.all(jobs).then((resolved) => {
          unmoved.forEach((key, i) => {
            const end = resolved[i];
            if (end !== undefined) {
              item[key] = end;
            }
          });
        }),
      );
    } else {
      advanceItem(item);
    }
    trimLog();
  }
  // The global line and column of a byte offset, asked of the core: the window
  // the swap to that line would show is loaded and the position is taken from
  // its text.
  async function globalPosOf(off: number): Promise<LinePos> {
    const target = await invoke<number>('windowed_offset_line', {
      sessionId,
      offset: off,
    });
    const read = await readAround(target);
    const doc = read.text.replace(/\r\n|\r/g, '\n');
    const breaks = scanBreaks(read.text);
    const rel = off - read.start_offset;
    const at =
      byteToChar(doc, breaks, rel) ?? byteToChar(doc, breaks, rel - 1) ?? 0;
    const before = doc.slice(0, at);
    const line = read.start_line + before.split('\n').length - 1;
    return { line, col: at - (before.lastIndexOf('\n') + 1) };
  }
  // Where a pointer selection that is up to date lies for the view `v` with the
  // window `g`: document positions when both ends are inside it, and always
  // the global selection.
  async function placeSelect(
    v: EditorView,
    g: Geometry,
    item: SelectItem,
  ): Promise<{
    doc: { anchor: number; head: number } | null;
    global: LineSelection;
  }> {
    const place = async (
      off: number,
    ): Promise<{ pos: number | null; global: LinePos }> => {
      const inside =
        off >= g.startOffset &&
        (off < g.endOffset || (off === g.endOffset && g.endLine >= totalLines));
      if (!inside) {
        return { pos: null, global: await globalPosOf(off) };
      }
      const text = v.state.doc.toString();
      const rel = off - g.startOffset;
      // An offset inside a CRLF moves to the break's start.
      const pos =
        byteToChar(text, g.breaks, rel) ??
        byteToChar(text, g.breaks, rel - 1) ??
        0;
      const local = livePos(v.state.doc, pos);
      return {
        pos,
        global: { line: local.line + g.startLine, col: local.col },
      };
    };
    const anchor = await place(item.anchor.off);
    const head = await place(item.head.off);
    return {
      doc:
        anchor.pos !== null && head.pos !== null
          ? { anchor: anchor.pos, head: head.pos }
          : null,
      global: { anchor: anchor.global, head: head.global },
    };
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
      outside: v !== undefined && inputOutside(v.state.doc),
      globalPath: globalOpPath(globalSel),
    };
  }
  // Whether input should be handled by the replay: focus is in the editor (or
  // nowhere) and the selection is outside the window, or a replay is running,
  // or an undo or redo is under way.
  function replayWanted(): boolean {
    return replayStateWanted(replayState());
  }
  // A copy or cut that waits to write the web clipboard is told there is
  // nothing to write.
  function refuseSupply(item: ReplayItem): void {
    if ((item.kind === 'copy' || item.kind === 'cut') && 'supply' in item) {
      item.supply(null);
    }
  }
  function dropReplay(): void {
    for (const item of replayQueue.items) {
      refuseSupply(item);
    }
    replayQueue.dropAll();
    releaseResolved();
    heldCaret = null;
    replayPending = false;
    replaySwapActive = false;
    clearTimeout(replayTimer);
    replayTimer = undefined;
    trimLog();
    wakeShadow();
    notifySettled();
  }

  function startReplaySwap(): void {
    replayTimer = undefined;
    replayPending = true;
    const action = replayStartAction({
      gone: view === undefined,
      locked,
      swapping,
      capturing: capture !== null,
      composing: view?.composing === true,
      holds,
    });
    if (action === 'drop') {
      dropReplay();
      return;
    }
    // The end of the swap, the capture or the undo carries on with the queue.
    if (action === 'wait') {
      return;
    }
    // An item judged by the selection alone needs no window on the caret.
    if (!draining && headRouted()) {
      void drainReplay();
      return;
    }
    // The layout may have changed since the table was last read.
    refreshAltGr();
    // A selection no window holds is shown at its head.
    const target = fitsWindow(globalSel)
      ? windowStartFor(globalSel, totalLines) + MARGIN_LINES
      : globalSel.head.line;
    replaySwapActive = true;
    void loadWindow(target, 'reveal');
    // The keys that got here may have come with focus on <body>.
    hadFocusAtSwap = true;
  }
  // Whether the window holds the selection the queued input acts at.
  function replayWindowReady(v: EditorView): boolean {
    return replayReady(globalSel, windowStartLine, v.state.doc.lines);
  }
  // Carry on with the queued input once nothing holds it back: swap back to
  // the selection when the queue's head needs the caret and the window does not
  // hold it, else drain the queue.
  function resumeReplay(): void {
    if (
      !replayPending ||
      swapping ||
      draining ||
      shadow !== null ||
      holds > 0 ||
      replayTimer !== undefined
    ) {
      return;
    }
    if (view === undefined || locked) {
      dropReplay();
      return;
    }
    const action = resumeAction(
      replayQueue.head?.kind ?? null,
      replayWindowReady(view),
    );
    if (action === 'swap') {
      startReplaySwap();
    } else {
      void drainReplay();
    }
  }

  function queueReplay(item: ReplayItem): void {
    replayQueue.enqueue(item);
    wakeShadow();
    notifyFlushWaiters();
    if (!replayPending) {
      if (holds > 0) {
        replayPending = true;
      } else {
        startReplaySwap();
      }
    }
  }
  // Start the swap after `delay` ms, restarting a wait that is already running.
  function armReplaySwap(delay: number): void {
    replayPending = true;
    clearTimeout(replayTimer);
    replayTimer = setTimeout(startReplaySwap, delay);
  }
  // Never swap inside a filter: the swap starts in the next task.
  function queueDeferred(item: ReplayItem): void {
    replayQueue.enqueue(item);
    wakeShadow();
    notifyFlushWaiters();
    if (!replayPending) {
      armReplaySwap(0);
    }
  }
  // Run an item that acts at the caret in the view `v`. `current` says whether
  // the view is still the one the item belongs to once a clipboard write is
  // through.
  async function runReplayItem(
    v: EditorView,
    item: ReplayItem,
    current: () => boolean,
    restore: (sel: LineSelection) => void = restoreMainSelection,
  ): Promise<void> {
    if (item.kind === 'text') {
      v.dispatch(
        item.userEvent === 'input.paste'
          ? pasteSpec(v.state, item.text, lastLinewiseCopy())
          : v.state.replaceSelection(item.text),
        {
          userEvent: item.userEvent,
          scrollIntoView: true,
          annotations: replayDispatchMark.of(true),
        },
      );
    } else if (item.kind === 'key') {
      replayingKey = true;
      let handled = false;
      try {
        handled = runScopeHandlers(v, item.event, 'editor');
      } finally {
        replayingKey = false;
      }
      if (!handled && item.restore !== undefined) {
        restore(item.restore);
      }
    } else if (
      (item.kind === 'copy' || item.kind === 'cut') &&
      'supply' in item
    ) {
      // The routing sent the ones whose selection grew past one window through
      // a clip, so this selection fits.
      const copied = copiedRange(v.state);
      rememberCopy(v.state);
      item.supply(copied.text === '' && !copied.linewise ? null : copied.text);
      if (!(await item.written)) {
        return;
      }
      // Delete only after the write succeeded, as editorCut does.
      if (item.kind === 'cut' && current()) {
        v.dispatch({
          changes: copied.ranges,
          userEvent: 'delete.cut',
          scrollIntoView: true,
          annotations: replayDispatchMark.of(true),
        });
      }
    }
  }
  // Show the selection the queued input acts at in the view, which may have
  // been moved by a click meanwhile. Set only when it differs, so consecutive
  // vertical moves keep the goal column. Neither the global selection nor the
  // edit bookkeeping sees it.
  function setViewSelection(v: EditorView, anchor: number, head: number): void {
    const main = v.state.selection.main;
    if (main.anchor === anchor && main.head === head) {
      return;
    }
    settingSelection = true;
    try {
      v.dispatch({ selection: { anchor, head } });
    } finally {
      settingSelection = false;
    }
  }
  function alignViewToGlobal(v: EditorView): void {
    const doc = v.state.doc;
    const live = toLiveSelection(globalSel, {
      startLine: windowStartLine,
      lineCount: doc.lines,
      lineLength: (local) => doc.line(local + 1).length,
    });
    setViewSelection(v, docPos(doc, live.anchor), docPos(doc, live.head));
    lastLive = liveSelection(v.state);
    heldCaret = null;
  }
  // A pointer selection that has caught up with the core takes effect: the
  // view shows it when its window holds both ends, and the global selection is
  // set either way. Otherwise the next step brings the window to it.
  async function runSelect(v: EditorView, item: SelectItem): Promise<void> {
    await applyChain;
    await mapped(item);
    if (locked || view !== v) {
      return;
    }
    const place = await placeSelect(v, mainGeometry(), item);
    if (locked || view !== v) {
      return;
    }
    heldCaret = null;
    if (place.doc !== null) {
      setViewSelection(v, place.doc.anchor, place.doc.head);
      lastLive = liveSelection(v.state);
      globalSel = toGlobalSelection(lastLive, windowStartLine);
    } else {
      globalSel = place.global;
    }
  }
  // --- Global operations -----------------------------------------------------
  // A selection too large for one window is edited as an operation on the file
  // in the core, from the lines and columns of its ends. The window swap that
  // follows shows the result.
  // The editor's own key commands, which the table of selection commands has
  // no other way to know.
  const ownCommands: OwnCommands = {
    closeBox,
    selectVisible,
    undo: undoCommand,
    redo: redoCommand,
  };
  function commandsOf(item: ReplayItem | undefined): Command[] {
    return item !== undefined && item.kind === 'key'
      ? commandChain(keyLayers(), item.event, platform.os)
      : [];
  }
  function mainWindow(): { startLine: number; lineCount: number } {
    return {
      startLine: windowStartLine,
      lineCount: view?.state.doc.lines ?? 0,
    };
  }
  function routeOf(item: ReplayItem, sel: LineSelection): GlobalAction {
    return globalItemAction({
      item,
      sel,
      commands: commandsOf(item),
      panelOpen: panelOpen(),
      own: ownCommands,
      totalLines,
      win: mainWindow(),
    });
  }
  // Whether the queue's head is judged by the selection alone and so needs no
  // window on the caret first.
  function headRouted(): boolean {
    const item = replayQueue.head;
    if (item === undefined || capture !== null || shadow !== null) {
      return false;
    }
    return routeOf(item, globalSel).type !== 'normal';
  }
  function restoreMainSelection(sel: LineSelection): void {
    globalSel = sel;
    if (view !== undefined) {
      alignViewToGlobal(view);
    }
  }
  function startOf(sel: LineSelection): LinePos {
    const { anchor, head } = sel;
    const headFirst =
      head.line < anchor.line ||
      (head.line === anchor.line && head.col < anchor.col);
    return headFirst ? head : anchor;
  }
  async function invokeGlobal(
    owner: number,
    op: GlobalOp,
    sel: LineSelection,
    text: string,
    sep: string,
    lines: [number, number],
  ): Promise<GlobalResult> {
    const ends = { sessionId: owner, anchor: sel.anchor, head: sel.head };
    if (op === 'indent' || op === 'outdent') {
      const r = await invoke<IndentResult>('windowed_indent_range', {
        ...ends,
        outdent: op === 'outdent',
        insertSep: sep,
        mapLines: lines,
        newGroup: true,
      });
      return { ...r, sel: { anchor: r.anchor, head: r.head } };
    }
    if (op === 'enter') {
      const r = await invoke<RangeResult>('windowed_enter', {
        ...ends,
        insertSep: sep,
        newGroup: true,
      });
      return { ...r, sel: { anchor: r.cursor, head: r.cursor } };
    }
    const r = await invoke<RangeResult>('windowed_replace_range', {
      ...ends,
      text: opText(op, text, sep),
      insertSep: sep,
      newGroup: true,
    });
    // A split line leaves the caret where the selection began.
    const at = op === 'split' ? startOf(sel) : r.cursor;
    return { ...r, sel: { anchor: at, head: at } };
  }
  // One clip copy of a range of the session. It ends with an outcome that
  // shows no message, whatever it is.
  // `item` holds the reservation made when it was queued, which the core
  // releases when the copy ends, however it ends.
  async function copyToClip(
    owner: number,
    c: ClipCopy,
    item: ReplayItem,
  ): Promise<ClipOutcome> {
    traceSwap({ at: 'clipCopy' });
    const reservation = (await replayQueue.reservationOf(item)) ?? null;
    let outcome: FinishOutcome = 'drop';
    try {
      const done = await invoke<ClipOutcome>('clip_copy_session', {
        sessionId: owner,
        anchor: c.copy.anchor,
        head: c.copy.head,
        linewise: c.linewise,
        reservation,
      });
      outcome = 'clip';
      return done;
    } finally {
      // A reservation the command took is released there; one it never reached
      // is given back here.
      replayQueue.finish(item, outcome);
    }
  }
  // What an operation that changed nothing reports: the totals are the
  // editor's own and unused.
  function unchanged(): GlobalResult {
    return {
      edits: [],
      sel: globalSel,
      total_bytes: totalBytes,
      total_lines: totalLines,
      clean: true,
      generation: 0,
    };
  }
  // A cut through a clip: the selection leaves the file only if the clip was
  // offered, in the same operation, so no other edit comes in between.
  async function invokeClipCut(
    owner: number,
    cut: ClipCut,
    item: ReplayItem,
    sep: string,
  ): Promise<GlobalResult> {
    const { removed } = await runClipCut({
      offer: () => copyToClip(owner, cut, item),
      remove: async () => {
        const head =
          cut.remove.head === 'end'
            ? await invoke<LinePos>('windowed_end_pos', { sessionId: owner })
            : cut.remove.head;
        return invoke<RangeResult>('windowed_replace_range', {
          sessionId: owner,
          anchor: cut.remove.anchor,
          head,
          text: '',
          insertSep: sep,
          newGroup: true,
        });
      },
    });
    if (removed === null) {
      return unchanged();
    }
    return {
      ...removed,
      sel: { anchor: removed.cursor, head: removed.cursor },
    };
  }
  // Take `item` off the queue when it is its head.
  // Drop the queue's head without running it.
  function dropHead(): void {
    const item = replayQueue.take();
    if (item !== undefined) {
      replayQueue.finish(item, 'drop');
    }
    trimLog();
  }
  function takeItem(item: ReplayItem): void {
    if (replayQueue.takeIf(item)) {
      trimLog();
    }
  }
  // A copy through a clip, behind the edits typed so far. The file and the
  // window stay as they are; input meanwhile waits in the queue.
  async function runClipCopy(item: ReplayItem, c: ClipCopy): Promise<void> {
    if (c.refuseSupply) {
      refuseSupply(item);
    }
    const owner = sessionId;
    try {
      await behindApplies(() => copyToClip(owner, c, item));
    } catch {
      // A copy that failed shows no message, as a cut to the web clipboard.
    } finally {
      replayQueue.finish(item, 'drop');
    }
  }
  // Whether the editor has the focus, so that a paste the system sends to the
  // focused element reaches it.
  function editorFocused(): boolean {
    return (
      view !== undefined &&
      document.hasFocus() &&
      view.dom.contains(document.activeElement)
    );
  }
  // What the clipboard holds for a queued paste. The answer is kept while the
  // paste waits for a swap or a hold, so it is asked once.
  // A clip it holds is pinned: the pin goes back when the paste has run or is
  // dropped.
  const resolvedPastes = new Map<ReplayItem, Resolved>();
  function forgetResolved(item: ReplayItem): void {
    const known = resolvedPastes.get(item);
    resolvedPastes.delete(item);
    if (known?.kind === 'clip') {
      known.release();
    }
  }
  function releaseResolved(): void {
    for (const known of resolvedPastes.values()) {
      if (known.kind === 'clip') {
        known.release();
      }
    }
    resolvedPastes.clear();
  }
  async function resolvePaste(item: ReplayItem): Promise<Resolved> {
    if (item.kind !== 'clipPaste') {
      return { kind: 'none' };
    }
    const known = resolvedPastes.get(item);
    if (known !== undefined) {
      return known;
    }
    const v = view;
    const via = windowedTextVia({
      fits: fitsWindow(globalSel),
      editable:
        v !== undefined &&
        !locked &&
        v.state.facet(EditorView.editable) &&
        !v.state.readOnly,
      focused: editorFocused(),
    });
    let resolved: Resolved = { kind: 'none' };
    try {
      resolved = await resolveClip(
        { ...pasteEnv, focusStill: editorFocused },
        item.mark,
        via,
      );
    } catch {
      // Nothing is pasted.
    }
    if (resolved.kind === 'clip' || resolved.kind === 'system') {
      resolvedPastes.set(item, resolved);
    }
    return resolved;
  }
  // The text of another app that the page read goes on as typed text; a clip
  // or the system's text goes into the file in the core.
  function pasteCall(item: ReplayItem): (() => Promise<GlobalResult>) | null {
    if (item.kind !== 'clipPaste') {
      return null;
    }
    const owner = sessionId;
    const sep = insertSep;
    return async () => {
      const resolved = await resolvePaste(item);
      if (replayQueue.head !== item) {
        // The queue was dropped meanwhile.
        forgetResolved(item);
        return unchanged();
      }
      if (resolved.kind === 'text') {
        replayQueue.replaceAt(0, {
          kind: 'text',
          text: resolved.text,
          userEvent: 'input.paste',
        });
        return unchanged();
      }
      replayQueue.takeIf(item);
      trimLog();
      if (resolved.kind === 'none') {
        return unchanged();
      }
      // The paste lets go of the pin itself.
      resolvedPastes.delete(item);
      const sel = globalSel;
      const ends = { sessionId: owner, anchor: sel.anchor, head: sel.head };
      const caret =
        sel.anchor.line === sel.head.line && sel.anchor.col === sel.head.col;
      ownGlobalOp = true;
      try {
        globalCalls += 1;
        return await runop(
          owner,
          async () => {
            const r = await runWindowedPaste<RangeResult>(
              {
                pasteClip: (pin, info) =>
                  invoke<RangeResult>('windowed_paste_clip', {
                    ...ends,
                    pin,
                    linewise: info.linewise && caret,
                    insertSep: sep,
                    newGroup: true,
                  }),
                pasteSystem: () =>
                  invoke<RangeResult>('windowed_paste_system', {
                    ...ends,
                    insertSep: sep,
                    newGroup: true,
                  }),
                clipStatus: () =>
                  invoke<ClipInfo | null>('clip_status', { mark: null }),
                pin: (clipId) => invoke<number>('clip_pin', { clipId }),
                unpin: (pin) => {
                  invoke('clip_unpin', { pin }).catch(() => {});
                },
                report: (error) => {
                  convertController.report(t('convert.failed', { error }));
                },
              },
              resolved,
            );
            if (r.kind === 'gone') {
              return unchanged();
            }
            if (import.meta.env.DEV) {
              const parked = parkGlobalOp();
              if (parked !== null) {
                await parked;
              }
            }
            const done = r.value;
            return { ...done, sel: { anchor: done.cursor, head: done.cursor } };
          },
          (r) => r.edits.length > 0,
        );
      } finally {
        ownGlobalOp = false;
        notifyFlushWaiters();
      }
    };
  }
  // The call of the global operation `action` makes for `item`, on the
  // selection as it is when the call runs. Null for an action that is none.
  function callFor(
    action: GlobalAction,
    item: ReplayItem,
  ): (() => Promise<GlobalResult>) | null {
    if (action.type === 'clipPaste') {
      return pasteCall(item);
    }
    let op: GlobalOp;
    let text = '';
    let cut: ClipCut | null = null;
    if (action.type === 'deleteFirst') {
      op = 'delete';
    } else if (action.type === 'op') {
      op = action.op;
      if (action.op === 'clipCut') {
        cut = action.cut;
      }
      if (op === 'replace' && item.kind === 'text') {
        text = item.text;
      }
    } else {
      return null;
    }
    const clipCut = cut;
    const owner = sessionId;
    const sep = insertSep;
    const consumes = action.type === 'op';
    const joins = action.type === 'deleteFirst';
    return async () => {
      // The item is done with once its operation starts, except the text a
      // delete clears the selection for.
      if (consumes && replayQueue.takeIf(item)) {
        trimLog();
      }
      if (clipCut !== null && clipCut.refuseSupply) {
        refuseSupply(item);
      }
      const sel = globalSel;
      const lines: [number, number] = [windowStartLine, windowEndLine];
      ownGlobalOp = true;
      try {
        globalCalls += 1;
        const res = await runop(
          owner,
          async () => {
            const done =
              clipCut !== null
                ? await invokeClipCut(owner, clipCut, item, sep)
                : await invokeGlobal(owner, op, sel, text, sep, lines);
            if (import.meta.env.DEV) {
              const parked = parkGlobalOp();
              if (parked !== null) {
                await parked;
              }
            }
            return done;
          },
          (r) => r.edits.length > 0,
        );
        joinNextApply = joins;
        return res;
      } finally {
        ownGlobalOp = false;
        if (clipCut !== null) {
          replayQueue.finish(item, 'drop');
        }
        notifyFlushWaiters();
      }
    };
  }
  // The core has made the operation's change: queued clicks follow it, and the
  // selection is the operation's.
  function applyGlobalResult(res: GlobalResult): void {
    totalLines = res.total_lines;
    totalBytes = res.total_bytes;
    logChange({ edits: res.edits }, false);
    editSeq += 1;
    scheduleResultsRefresh();
    globalSel = res.sel;
    heldCaret = null;
    reportSelection();
  }
  // Run a global operation behind the edits typed so far. False when it failed
  // (the editor is locked then) or the editor is gone.
  async function runGlobal(
    call: () => Promise<GlobalResult>,
  ): Promise<boolean> {
    try {
      await behindApplies(async () => {
        const res = await call();
        if (!gone) {
          applyGlobalResult(res);
        }
      });
      return !gone;
    } catch (e) {
      if (!gone) {
        lock(t('editor.locked.write', { detail: String(e) }));
      }
      return false;
    }
  }
  // The window swap that runs a global operation and shows its result. The
  // editor stays open to a composition meanwhile, as in the swap back to the
  // caret.
  function startGlobalOp(action: GlobalAction, item: ReplayItem): void {
    const call = callFor(action, item);
    if (call === null) {
      return;
    }
    refreshAltGr();
    replaySwapActive = true;
    void loadWindow(globalSel.head.line, 'reveal', call);
    hadFocusAtSwap = true;
  }
  // The end of the file, asked for only by the keys that need it.
  async function selectEnd(spec: SelectSpec): Promise<LinePos> {
    if (!needsEndPos(spec)) {
      return { line: 0, col: 0 };
    }
    await applyChain;
    return invoke<LinePos>('windowed_end_pos', { sessionId });
  }
  // Keep the selection key the outcome says is replayed at the head's window,
  // else take it out of the queue.
  function takeSelectOutcome(
    item: ReplayItem,
    out: { replay: boolean; restore: LineSelection | null },
  ): void {
    if (out.replay) {
      if (item.kind === 'key') {
        item.handled = true;
        if (out.restore !== null) {
          item.restore = out.restore;
        }
      }
    } else {
      replayQueue.takeIf(item);
      trimLog();
    }
  }
  // A selection key on a selection too large for one window, in the main view.
  async function runKeySelect(
    v: EditorView,
    item: ReplayItem,
    spec: SelectSpec,
  ): Promise<void> {
    const end = await selectEnd(spec);
    if (locked || view !== v) {
      return;
    }
    const out = globalSelectAction(spec, globalSel, end);
    heldCaret = null;
    globalSel = out.sel;
    takeSelectOutcome(item, out);
    if (!out.replay && replayWindowReady(v)) {
      alignViewToGlobal(v);
      v.dispatch({
        effects: EditorView.scrollIntoView(v.state.selection.main.head, {
          y: 'center',
        }),
      });
    }
  }
  // Replay swaps in a row that left the selection outside the window.
  let swapStreak = 0;
  // Replay the queue in order once the swap is over. New input keeps being
  // queued until the queue is empty. A swap or an undo that begins meanwhile
  // pauses the drain; its end resumes it. An item that needs the caret finding
  // the selection outside the window stops it, and the resume after it swaps
  // the window to the selection. An item that works on a selection too large
  // for a window is judged here, by the selection as it is now, and a
  // whole-file operation stops the drain for the swap that runs it.
  async function drainReplay(): Promise<void> {
    if (draining || shadow !== null) {
      return;
    }
    draining = true;
    let resume = false;
    let global: { action: GlobalAction; item: ReplayItem } | null = null;
    try {
      for (;;) {
        const v = view;
        if (v === undefined || locked) {
          dropReplay();
          return;
        }
        const head = replayQueue.head;
        if (head !== undefined && head.kind === 'select') {
          advanceItem(head);
        }
        const { step, action } = dequeueStep({
          item: head,
          sel: globalSel,
          commands: commandsOf(head),
          panelOpen: panelOpen(),
          own: ownCommands,
          swapping,
          holds,
          headMapping: head?.kind === 'select' && head.mapping !== null,
          ready: replayWindowReady(v),
          totalLines,
          win: mainWindow(),
        });
        joinNextApply = joinAfterStep(joinNextApply, step);
        if (step === 'wait') {
          return;
        }
        if (step === 'done') {
          swapStreak = 0;
          replayPending = false;
          return;
        }
        if (step === 'swap') {
          swapStreak += 1;
          if (swapStreak > 2) {
            // The swap cannot bring the selection inside: use what is there.
            swapStreak = 0;
            globalSel = toGlobalSelection(
              toLiveSelection(globalSel, {
                startLine: windowStartLine,
                lineCount: v.state.doc.lines,
                lineLength: (local) => v.state.doc.line(local + 1).length,
              }),
              windowStartLine,
            );
            continue;
          }
          resume = true;
          return;
        }
        swapStreak = 0;
        if (head === undefined) {
          return;
        }
        if (step === 'drop') {
          dropHead();
        } else if (step === 'global') {
          if (action.type === 'clipPaste') {
            // The queue waits while the clipboard is asked.
            const resolved = await resolvePaste(head);
            if (replayQueue.head !== head) {
              continue;
            }
            if (resolved.kind === 'text') {
              replayQueue.replaceAt(0, {
                kind: 'text',
                text: resolved.text,
                userEvent: 'input.paste',
              });
              continue;
            }
            if (resolved.kind === 'none') {
              dropHead();
              continue;
            }
          }
          // A composition no capture covers holds the operation back; its end
          // carries on with the queue.
          const start = globalStartAction({
            gone: false,
            locked,
            swapping,
            capturing: capture !== null,
            composing: v.composing,
            holds,
          });
          if (start === 'wait') {
            return;
          }
          if (start === 'drop') {
            dropReplay();
            return;
          }
          global = { action, item: head };
          return;
        } else if (step === 'clipCopy') {
          takeItem(head);
          if (action.type === 'clipCopy') {
            await runClipCopy(head, action);
          }
          if (replayQueue.length === 0) {
            // A copy leaves the selection where it was, so with nothing
            // queued behind it the window stays too.
            swapStreak = 0;
            replayPending = false;
            return;
          }
        } else if (step === 'keySelect') {
          if (action.type === 'select') {
            await runKeySelect(v, head, action.select);
          }
        } else if (step === 'map') {
          if (head.kind === 'select' && head.mapping !== null) {
            await head.mapping;
          }
        } else if (step === 'select') {
          replayQueue.take();
          if (head.kind === 'select') {
            await runSelect(v, head);
          }
          trimLog();
        } else if (step === 'undo') {
          replayQueue.take();
          const dir =
            action.type === 'undo' || action.type === 'redo'
              ? action.type
              : head.kind;
          // The hold it takes pauses the drain; its release carries on.
          if (dir === 'undo' || dir === 'redo') {
            runUndoNow(dir);
          }
          return;
        } else {
          alignViewToGlobal(v);
          replayQueue.take();
          try {
            await runReplayItem(v, head, () => view === v && !swapping);
          } finally {
            replayQueue.finish(head, 'web');
          }
        }
      }
    } catch (e) {
      dropReplay();
      throw e;
    } finally {
      draining = false;
      notifySettled();
      notifyFlushWaiters();
      if (global !== null) {
        startGlobalOp(global.action, global.item);
      } else if (resume) {
        resumeReplay();
      }
    }
  }
  function queueHasSelect(): boolean {
    return replayQueue.some((item) => item.kind === 'select');
  }
  // --- The shadow ------------------------------------------------------------
  // While a composition stays open outside the window, the queue cannot wait
  // for the composition to end. The swap back to the caret reads the window as
  // usual; a shadow, an editor nobody sees, takes it and replays the queue into
  // the core, up to the slot the composition holds. The editor on screen keeps
  // showing the old window, open to the composition, until the swap installs
  // the new one. The shadow never sets `draining` and never takes a hold, so
  // the next composition of a run is still captured and late text still queued.
  interface Shadow {
    view: EditorView;
    host: HTMLElement;
    g: Geometry;
    // Its own global selection and the live one it was last reconciled with.
    sel: LineSelection;
    live: LineSelection;
    // A selection or a document change that is not the user's.
    silent: boolean;
    remote: boolean;
    // Set while it waits for something to replay.
    wake: (() => void) | null;
    // An undo a replayed key started.
    keyUndo: Promise<void> | null;
    busy: boolean;
  }
  let shadow: Shadow | null = null;

  function wakeShadow(): void {
    const wake = shadow?.wake;
    if (wake !== null && wake !== undefined) {
      wake();
    }
  }
  function shadowUpdate(update: ViewUpdate): void {
    const sh = shadow;
    if (sh === null || sh.view !== update.view) {
      return;
    }
    if (update.docChanged && !sh.remote) {
      const edits = convertUpdate(sh.g, update);
      dispatchEdits(edits, groupFor(update, false), false, lineDeltaOf(update));
    }
    if ((update.docChanged || update.selectionSet) && !sh.silent) {
      const live = liveSelection(update.state);
      sh.sel = selectionAfterChange(
        sh.sel,
        sh.live,
        live,
        sh.g.startLine,
        update.docChanged,
      );
      sh.live = live;
    }
  }
  function buildShadowState(doc: string): EditorState {
    return EditorState.create({
      doc,
      extensions: [
        EditorView.cspNonce.of(readCspNonce()),
        coreSetup,
        currentKeymap(),
        keymap.of(
          coreKeyBindings({
            closeBox: () => false,
            selectVisible: () => false,
            undo: () => {
              startKeyUndo('undo');
              return true;
            },
            redo: () => {
              startKeyUndo('redo');
              return true;
            },
          }),
        ),
        cmPhraseExtension(),
        gutterExtension(showLineNumbers, () => shadow?.g.startLine ?? 0),
        wordWrap ? EditorView.lineWrapping : [],
        varEditorTheme(dark),
        EditorView.updateListener.of(shadowUpdate),
      ],
    });
  }
  function startKeyUndo(dir: 'undo' | 'redo'): void {
    const sh = shadow;
    if (sh !== null) {
      sh.keyUndo = shadowUndo(sh, dir);
    }
  }
  // Put a freshly read window into the shadow, with the selection it holds
  // intersected with it, or at the start of `gotoLine` after an undo's jump.
  function placeShadow(sh: Shadow, res: WindowRead, gotoLine?: number): void {
    sh.g = {
      startLine: res.start_line,
      startOffset: res.start_offset,
      endLine: res.start_line,
      endOffset: res.end_offset,
      breaks: scanBreaks(res.text),
      prevLoneCr: res.prev_lone_cr,
      nextIsLf: res.next_is_lf,
    };
    totalLines = res.total_lines;
    totalBytes = res.total_bytes;
    const fresh = buildShadowState(res.text);
    if (gotoLine !== undefined) {
      sh.sel = gotoSelection(
        res.start_line +
          clamp(gotoLine - res.start_line, 0, fresh.doc.lines - 1),
      );
    }
    const swapped = selectionAfterSwap(sh.sel, {
      startLine: res.start_line,
      lineCount: fresh.doc.lines,
      lineLength: (local) => fresh.doc.line(local + 1).length,
    });
    sh.sel = swapped.global;
    sh.live = swapped.live;
    sh.silent = true;
    try {
      sh.view.setState(
        fresh.update({
          selection: {
            anchor: docPos(fresh.doc, swapped.live.anchor),
            head: docPos(fresh.doc, swapped.live.head),
          },
        }).state,
      );
    } finally {
      sh.silent = false;
    }
    sh.g.endLine = sh.g.startLine + sh.view.state.doc.lines;
  }
  function createShadow(res: WindowRead): Shadow {
    const host = document.createElement('div');
    const size = view?.dom.getBoundingClientRect();
    host.style.cssText =
      'position: absolute; left: -100000px; top: 0; opacity: 0; pointer-events: none; ' +
      `width: ${size?.width ?? 800}px; height: ${size?.height ?? 600}px;`;
    host.inert = true;
    container.appendChild(host);
    const v = new EditorView({
      parent: host,
      state: buildShadowState(res.text),
    });
    const sh: Shadow = {
      view: v,
      host,
      g: {
        startLine: res.start_line,
        startOffset: res.start_offset,
        endLine: res.start_line,
        endOffset: res.end_offset,
        breaks: [],
        prevLoneCr: res.prev_lone_cr,
        nextIsLf: res.next_is_lf,
      },
      sel: globalSel,
      live: globalSel,
      silent: false,
      remote: false,
      wake: null,
      keyUndo: null,
      busy: false,
    };
    shadow = sh;
    placeShadow(sh, res);
    return sh;
  }
  function destroyShadow(sh: Shadow): void {
    if (shadow === sh) {
      shadow = null;
    }
    sh.view.destroy();
    sh.host.remove();
    notifyFlushWaiters();
  }
  // Read the shadow's window again around `target`.
  async function readShadowWindow(
    sh: Shadow,
    target: number,
    gotoLine?: number,
  ): Promise<void> {
    await applyChain;
    if (locked || shadow !== sh) {
      return;
    }
    const w = nextWindow(target, totalLines, WINDOW_LINES, MARGIN_LINES);
    let res: WindowRead;
    try {
      res = await invoke<WindowRead>('windowed_read', {
        sessionId,
        startLine: w.startLine,
        endLine: w.endLine,
      });
    } catch (e) {
      lock(t('editor.locked.read', { detail: String(e) }));
      return;
    }
    if (shadow === sh) {
      placeShadow(sh, res, gotoLine);
    }
  }
  // An undo or redo run by the shadow: straight at the core behind the edits
  // before it, with no hold, and the result mirrored into the shadow.
  async function shadowUndo(sh: Shadow, dir: 'undo' | 'redo'): Promise<void> {
    const owner = sessionId;
    const out: { res: UndoResult | null; linesBefore: number } = {
      res: null,
      linesBefore: 0,
    };
    const step = applyChain.then(async () => {
      if (locked || shadow !== sh) {
        return;
      }
      const res = await coreUndo(owner, dir, trackOf(sh.sel));
      if (res === null) {
        return;
      }
      out.linesBefore = totalLines;
      if (!res.reload_only) {
        onapplied(
          owner,
          res.total_bytes,
          res.total_lines,
          res.clean,
          res.generation,
        );
      }
      editSeq += 1;
      scheduleResultsRefresh();
      totalLines = res.total_lines;
      totalBytes = res.total_bytes;
      if (!res.reload_only) {
        logChange({ edits: res.edits }, false);
      } else if (res.token !== null) {
        logChange({ token: res.token }, false);
      } else {
        logChange({ edits: res.edits }, false);
      }
      out.res = res;
    });
    applyChain = step;
    await step;
    const res = out.res;
    if (res === null || shadow !== sh) {
      return;
    }
    if (res.reload_only) {
      const reloaded = undoSelection({
        tracked: res.tracked,
        branch: 'reload_only',
      });
      if (reloaded.sel !== null) {
        sh.sel = reloaded.sel;
      }
      await readShadowWindow(sh, sh.g.startLine + MARGIN_LINES);
      return;
    }
    let landed = 0;
    const windowLines = sh.g.endLine - sh.g.startLine;
    if (editsInWindow(sh.g, res.edits)) {
      sh.remote = true;
      try {
        landed = mirrorEdits(sh.view, sh.g, res.edits);
      } finally {
        sh.remote = false;
      }
    }
    const windowDelta = sh.g.endLine - sh.g.startLine - windowLines;
    const coreDelta = res.total_lines - out.linesBefore;
    const mismatch = landed === res.edits.length && coreDelta !== windowDelta;
    if (mismatch) {
      junctionMismatch(coreDelta, windowDelta);
    }
    if (landed < res.edits.length || mismatch) {
      const jump = undoSelection({ tracked: res.tracked, branch: 'goto' });
      if (jump.sel !== null) {
        sh.sel = jump.sel;
        await readShadowWindow(sh, jump.sel.head.line);
      } else {
        await readShadowWindow(sh, res.first_line, res.first_line);
      }
      return;
    }
    const mirrored = undoSelection({ tracked: res.tracked, branch: 'mirror' });
    if (mirrored.sel !== null) {
      sh.sel = mirrored.sel;
      alignShadow(sh);
    }
  }
  function alignShadow(sh: Shadow): void {
    const doc = sh.view.state.doc;
    const live = toLiveSelection(sh.sel, {
      startLine: sh.g.startLine,
      lineCount: doc.lines,
      lineLength: (local) => doc.line(local + 1).length,
    });
    sh.silent = true;
    try {
      setViewSelection(
        sh.view,
        docPos(doc, live.anchor),
        docPos(doc, live.head),
      );
    } finally {
      sh.silent = false;
    }
    sh.live = liveSelection(sh.view.state);
  }
  async function shadowSelect(sh: Shadow, item: SelectItem): Promise<void> {
    await applyChain;
    await mapped(item);
    if (locked || shadow !== sh) {
      return;
    }
    const place = await placeSelect(sh.view, sh.g, item);
    if (locked || shadow !== sh) {
      return;
    }
    if (place.doc !== null) {
      sh.silent = true;
      try {
        setViewSelection(sh.view, place.doc.anchor, place.doc.head);
      } finally {
        sh.silent = false;
      }
      sh.live = liveSelection(sh.view.state);
      sh.sel = toGlobalSelection(sh.live, sh.g.startLine);
    } else {
      sh.sel = place.global;
    }
  }
  // A queued item that works on a selection too large for a window, which the
  // shadow cannot run: the read loop does.
  interface GlobalStop {
    action: GlobalAction;
    item: ReplayItem;
  }
  // Run what the shadow stopped at: a copy through a clip, or a whole-file
  // operation. False when it failed.
  async function runStop(stop: GlobalStop): Promise<boolean> {
    if (stop.action.type === 'clipCopy') {
      takeItem(stop.item);
      await runClipCopy(stop.item, stop.action);
      return true;
    }
    const call = callFor(stop.action, stop.item);
    return call !== null && (await runGlobal(call));
  }
  // Replay the queue into the core through the shadow, up to the slot of an
  // open composition. The selection it reached becomes the global one. Stops at
  // a whole-file operation and hands it back.
  async function shadowDrain(sh: Shadow): Promise<GlobalStop | null> {
    sh.busy = true;
    let streak = 0;
    try {
      for (;;) {
        if (locked || gone || shadow !== sh) {
          return null;
        }
        const head = replayQueue.head;
        if (head !== undefined && head.kind === 'select') {
          advanceItem(head);
        }
        const { step, action } = shadowStep({
          item: head,
          sel: sh.sel,
          commands: commandsOf(head),
          panelOpen: panelOpen(),
          own: ownCommands,
          headMapping: head?.kind === 'select' && head.mapping !== null,
          ready:
            head === undefined ||
            replayReady(sh.sel, sh.g.startLine, sh.view.state.doc.lines),
          totalLines,
          win: {
            startLine: sh.g.startLine,
            lineCount: sh.view.state.doc.lines,
          },
        });
        joinNextApply = joinAfterStep(joinNextApply, step);
        if (step === 'wait' || step === 'done') {
          return null;
        }
        if (step === 'swap') {
          streak += 1;
          if (streak > 2) {
            return null;
          }
          await readShadowWindow(
            sh,
            fitsWindow(sh.sel)
              ? windowStartFor(sh.sel, totalLines) + MARGIN_LINES
              : sh.sel.head.line,
          );
          continue;
        }
        streak = 0;
        if (head === undefined) {
          return null;
        }
        if (step === 'drop') {
          dropHead();
        } else if (step === 'global') {
          return { action, item: head };
        } else if (step === 'keySelect') {
          if (action.type === 'select') {
            const end = await selectEnd(action.select);
            if (locked || shadow !== sh) {
              return null;
            }
            const out = globalSelectAction(action.select, sh.sel, end);
            sh.sel = out.sel;
            takeSelectOutcome(head, out);
          }
        } else if (step === 'map') {
          if (head.kind === 'select' && head.mapping !== null) {
            await head.mapping;
          }
        } else if (step === 'select') {
          replayQueue.take();
          if (head.kind === 'select') {
            await shadowSelect(sh, head);
          }
          trimLog();
        } else if (step === 'undo') {
          replayQueue.take();
          const dir =
            action.type === 'undo' || action.type === 'redo'
              ? action.type
              : head.kind;
          if (dir === 'undo' || dir === 'redo') {
            await shadowUndo(sh, dir);
          }
        } else {
          alignShadow(sh);
          replayQueue.take();
          try {
            await runReplayItem(
              sh.view,
              head,
              () => shadow === sh,
              (sel) => {
                sh.sel = sel;
                alignShadow(sh);
              },
            );
          } finally {
            replayQueue.finish(head, 'web');
          }
          const undone = sh.keyUndo;
          sh.keyUndo = null;
          if (undone !== null) {
            await undone;
          }
        }
        notifyFlushWaiters();
      }
    } finally {
      sh.busy = false;
      globalSel = sh.sel;
      notifyFlushWaiters();
    }
  }
  // Run the shadow over a window read while a composition is open, until the
  // composition is over and everything queued has been replayed, or a
  // whole-file operation stops it.
  async function runShadow(res: WindowRead): Promise<GlobalStop | null> {
    const sh = createShadow(res);
    try {
      for (;;) {
        const stop = await shadowDrain(sh);
        if (stop !== null) {
          return stop;
        }
        if (locked || gone || capture === null) {
          return null;
        }
        // The composition is still open: wait for its commit or for anything
        // queued meanwhile.
        await new Promise<void>((resume) => {
          sh.wake = resume;
        });
        sh.wake = null;
      }
    } finally {
      destroyShadow(sh);
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
    const before = tabFocusBefore;
    tabFocusBefore = null;
    if (before !== null && before.event === e && view !== undefined) {
      tabFocusState(view).tabFocusMode = before.mode;
    }
  }
  // Select All takes the keydown before anything is queued, so a swap, an undo
  // or the native select-all of Windows cannot lose or reorder it; while one
  // waits to run, every other key is dropped. Not for a text field elsewhere.
  function selectAllKeydown(e: KeyboardEvent): boolean {
    if (view === undefined || clipboardFocus() === 'other') {
      return false;
    }
    if (!modalOpen && isSelectAllKey(e, platform.os)) {
      if (selectAllTarget(settingsState.largeSelectAll, 'key') === 'file') {
        e.preventDefault();
        e.stopPropagation();
        selectAllGate.request();
        return true;
      }
      // CodeMirror's own Select All would take the whole loaded window. With
      // input queued the key waits its turn behind it instead.
      if (
        !swapping &&
        !keysParked &&
        !replayWanted() &&
        selectVisible(view, 'key')
      ) {
        e.preventDefault();
        e.stopPropagation();
        return true;
      }
    }
    const kind = isModifierKey(e.key) ? 'modifier' : 'keydown';
    if (inputWhileSelectAll(selectAllGate.pending(), kind) === 'drop') {
      e.preventDefault();
      e.stopPropagation();
      return true;
    }
    return false;
  }
  // Whether the key is a doc-edge move whose target the window does not hold,
  // typed where the replay takes the editor's input.
  function docEdgeKeyOutside(e: KeyboardEvent): boolean {
    const st = replayState();
    if (
      st.locked ||
      st.focusElsewhere ||
      st.dropHold ||
      (st.swapping && !st.replayPending && !st.queueHold)
    ) {
      return false;
    }
    return (
      docEdgeSelect({
        commands: commandChain(keyLayers(), e, platform.os),
        panelOpen: panelOpen(),
        own: ownCommands,
        totalLines,
        win: mainWindow(),
      }) !== undefined
    );
  }

  function onDocKeydown(e: KeyboardEvent): void {
    if (selectAllKeydown(e)) {
      return;
    }
    tabFocusBefore =
      keysParked && view !== undefined
        ? { event: e, mode: tabFocusState(view).tabFocusMode }
        : null;
    // While the keys are parked, an undo or redo key joins the queue instead
    // of doing nothing.
    if (keysParked) {
      const dir = parkedUndoKey(
        coreKeyBindings({
          closeBox,
          selectVisible,
          undo: undoCommand,
          redo: redoCommand,
        }),
        e,
        platform.os,
        undoCommand,
        redoCommand,
      );
      if (dir !== null) {
        e.preventDefault();
        e.stopPropagation();
        queueUndo(dir);
        return;
      }
    }
    // An input method key leaves the view where it is: a composition is
    // captured where it starts, and text that comes without one is replayed.
    const ime = imeKeyAction({
      ime: isImeKey(e),
      wanted: replayWanted(),
      capturing: capture !== null,
    });
    if (ime !== 'keep') {
      pendingIme = ime === 'mark';
    }
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
    // A move to the start or end of the file whose target is outside the
    // window goes through the replay, which moves the selection in the file.
    if (docEdgeKeyOutside(e)) {
      e.preventDefault();
      e.stopPropagation();
      queueReplay({ kind: 'key', event: e });
      return;
    }
    if (
      !replayPending &&
      e.isTrusted &&
      replayWanted() &&
      replayKind(e, platform.os) === 'chord'
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
          inputOutside(v.state.doc) &&
          chordReplaysAtEdge(keyLayers(), e, platform.os, neverReplayed)
        ) {
          queueReplay({ kind: 'key', event: e });
        }
      }, 0);
    }
    blockTabDuringSwap(e);
  }

  function onDocCompositionStart(): void {
    const v = view;
    if (
      v === undefined ||
      !captureStartAllowed({
        capturing: capture !== null,
        locked,
        swapping,
        replaySwap: swapping && replaySwapActive,
        draining,
        holds,
        wanted: replayWanted(),
        outside: inputOutside(v.state.doc),
        selectAllPending: selectAllGate.pending(),
      })
    ) {
      return;
    }
    capture = startCapture(v.state.doc.length);
    captureStart = v.state;
    pendingIme = false;
    // Everything queued from here on waits behind the composition's commit.
    replayQueue.enqueue({ kind: 'slot' });
    replayPending = true;
  }
  // CodeMirror has read the composition's last text by the time this bubbles up
  // to the document; the capture ends in the next microtask.
  function onDocCompositionEnd(): void {
    if (capture !== null) {
      queueMicrotask(endCapture);
    } else if (replayPending) {
      // A composition no capture covered held the queue back.
      queueMicrotask(resumeReplay);
    }
  }
  function captureUpdate(update: ViewUpdate): void {
    if (
      capture === null ||
      update.transactions.some((tr) => tr.annotation(captureMark) === true)
    ) {
      return;
    }
    if (capture.changes.newLength !== update.changes.length) {
      lock(t('editor.locked.write', { detail: 'ime' }));
      return;
    }
    capture = accumulate(capture, update.changes);
  }
  // Undo the composition's changes, put the caret back, and replay what it
  // committed at the real caret.
  function endCapture(): void {
    const v = view;
    const cap = capture;
    const start = captureStart;
    if (cap === null || start === null) {
      return;
    }
    let committed = '';
    if (v !== undefined && !locked) {
      const done = finishCapture(start.doc, cap.changes);
      committed = done.committed;
      if (!cap.changes.empty) {
        v.dispatch({
          changes: done.revert,
          selection: start.selection,
          annotations: captureMark.of(true),
        });
        if (!v.state.doc.eq(start.doc)) {
          lock(t('editor.locked.write', { detail: 'ime' }));
        }
      }
    }
    capture = null;
    captureStart = null;
    lateUntil = Date.now() + LATE_MS;
    // The commit takes the slot's place, ahead of what was queued during the
    // composition.
    const slot = replayQueue.findIndex((item) => item.kind === 'slot');
    const text: ReplayItem = {
      kind: 'text',
      text: committed,
      userEvent: 'input.type',
    };
    if (slot === -1) {
      if (committed !== '') {
        replayQueue.enqueue(text);
      }
    } else if (committed !== '') {
      replayQueue.replaceAt(slot, text);
    } else {
      replayQueue.removeAt(slot);
    }
    if (
      replayQueue.length === 0 &&
      !swapping &&
      !draining &&
      holds === 0 &&
      replayTimer === undefined
    ) {
      replayPending = false;
    }
    wakeShadow();
    notifySettled();
    notifyFlushWaiters();
    // A run of compositions follows each commit within moments (the next key
    // commits one and starts the next): swap back to the caret after the run.
    // A swap or the shadow still running carries on with the queue. With the
    // window already on the caret the queue goes in now, so the next
    // composition of the run is typed after it as plain input.
    if (swapping || shadow !== null) {
      return;
    }
    if (
      replayQueue.length > 0 &&
      v !== undefined &&
      inputOutside(v.state.doc)
    ) {
      armReplaySwap(CHAIN_MS);
    } else {
      resumeReplay();
    }
  }
  // Focus leaving the editor ends the "input method key" state; a capture whose
  // compositionend never came is ended after a moment.
  function onViewFocusOut(): void {
    pendingIme = false;
    const cap = capture;
    if (cap !== null) {
      setTimeout(() => {
        if (capture === cap) {
          endCapture();
        }
      }, 300);
    }
  }
  // Where focus is, as far as the clipboard rules care.
  function clipboardFocus(): 'editor' | 'none' | 'other' {
    const active = document.activeElement;
    if (active === null || active === document.body) {
      return 'none';
    }
    return view?.dom.contains(active) === true ? 'editor' : 'other';
  }
  // Whether the clipboard event is refused: a Select All waits to run, or the
  // selection is too large for one window to copy, cut or paste over.
  function clipboardRefused(
    e: ClipboardEvent,
    kind: 'copy' | 'cut' | 'paste',
  ): boolean {
    const focus = clipboardFocus();
    const waiting =
      focus !== 'other' &&
      inputWhileSelectAll(selectAllGate.pending(), kind) === 'drop';
    if (!waiting && !clipboardBlocked(kind, globalSel, focus)) {
      return false;
    }
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  function onDocPaste(e: ClipboardEvent): void {
    if (clipboardRefused(e, 'paste')) {
      return;
    }
    const focus = clipboardFocus();
    const clips = hasClips(platform.os);
    // The mark is taken now, at the event, and not awaited.
    const action = windowedPasteAction({
      focus,
      hasClips: clips,
      mark: clips && focus !== 'other' ? pasteEnv.clipPasteMark() : null,
    });
    if (action.kind === 'field') {
      return;
    }
    if (action.kind === 'queue') {
      // The clipboard may hold a clip of ours, which only the core can tell: the
      // page reads nothing, and the paste waits behind the input before it.
      e.preventDefault();
      e.stopPropagation();
      queueReplay(action.item);
      return;
    }
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
      pasteIsLinewise(v.state, text, lastLinewiseCopy())
    ) {
      e.preventDefault();
      e.stopPropagation();
      v.dispatch(pasteSpec(v.state, text, lastLinewiseCopy()), {
        userEvent: 'input.paste',
        scrollIntoView: true,
      });
    }
  }
  // WebKit allows a clipboard write only while the copy event is handled, so
  // the write starts here and its text is supplied once the window is back.
  function onDocCopyCut(e: ClipboardEvent): void {
    if (clipboardRefused(e, e.type === 'cut' ? 'cut' : 'copy')) {
      return;
    }
    // A selection too large for one window goes through a clip file, made
    // when the item is taken out of the queue; the web clipboard is not used.
    const route = clipCopyRoute({
      mode: 'edit',
      focus: clipboardFocus(),
      globalSel,
      wholeFile: false,
      domSelection: false,
      sel: null,
      loadedRows: null,
    });
    if (route === 'session') {
      e.preventDefault();
      e.stopPropagation();
      queueReplay({ kind: e.type === 'cut' ? 'cut' : 'copy', clip: true });
      return;
    }
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
      rememberCopy(v.state);
    }
  }
  // `op`, a global operation, runs behind the edits typed so far before the
  // window is read, and the window is then the one around the head of the
  // selection it leaves.
  async function loadWindow(
    target: number,
    mode: 'preserve' | 'goto' | 'reveal' | 'reload',
    op?: () => Promise<GlobalResult>,
  ): Promise<void> {
    // The swap back to the caret starts with a composition open: the editor
    // stays open to it and the queue drains in a shadow meanwhile.
    if (
      view === undefined ||
      locked ||
      swapping ||
      (capture !== null && !replaySwapActive)
    ) {
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
    let w = nextWindow(target, totalLines, WINDOW_LINES, MARGIN_LINES);
    if (
      op === undefined &&
      w.startLine === windowStartLine &&
      mode === 'preserve'
    ) {
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
    if (op !== undefined) {
      // Like the swap back to the caret: the editor stays open to a composition.
      replaySwapActive = true;
    }
    beginSwap();
    pendingIme = false;
    let pendingOp = op;
    let globalRan = false;
    try {
      let res: WindowRead;
      for (;;) {
        // Every in-flight apply must land before the read, or the read returns
        // stale bytes/lines that would desync the swapped-in window.
        await applyChain;
        if (locked || view === undefined) {
          endSwap();
          return;
        }
        if (pendingOp !== undefined) {
          const call = pendingOp;
          pendingOp = undefined;
          if (!(await runGlobal(call))) {
            endSwap();
            return;
          }
          globalRan = true;
          w = nextWindow(
            globalSel.head.line,
            totalLines,
            WINDOW_LINES,
            MARGIN_LINES,
          );
        }
        const seq = editSeq;
        try {
          traceSwap({ at: 'read' });
          res = await invoke<WindowRead>('windowed_read', {
            sessionId,
            startLine: w.startLine,
            endLine: w.endLine,
          });
          if (import.meta.env.DEV) {
            const parked = parkWindowedRead();
            if (parked !== null) {
              await parked;
            }
          }
        } catch (e) {
          // Locked first, so the swap's end does not refocus the editor just
          // before the error dialog shows.
          lock(t('editor.locked.read', { detail: String(e) }));
          endSwap();
          return;
        }
        if (capture === null) {
          break;
        }
        // A composition runs in the old window: the queue drains in a shadow
        // while it does, and the new window goes in once it is over. If
        // anything changed the core since the read, read again. A whole-file
        // operation the shadow stopped at runs here, and the window is read
        // again around the selection it leaves.
        const stop = await runShadow(res);
        await applyChain;
        if (locked || view === undefined) {
          endSwap();
          return;
        }
        if (stop !== null) {
          if (!(await runStop(stop))) {
            endSwap();
            return;
          }
          // A copy changes neither the file nor the selection.
          globalRan = globalRan || stop.action.type !== 'clipCopy';
          if (afterShadowStop(stop.action) === 'reread') {
            w = nextWindow(
              globalSel.head.line,
              totalLines,
              WINDOW_LINES,
              MARGIN_LINES,
            );
            continue;
          }
        }
        if (capture === null && editSeq === seq) {
          break;
        }
      }
      // Capture the anchor and the cursor's global position against the OLD
      // window before the vars are overwritten.
      const anchor =
        mode === 'preserve' || mode === 'reload' ? captureAnchor() : null;
      // Selection moves made while the swap was waiting on the read were not
      // tracked (the swap ignores the listener); fold them in against the old
      // window before the window variables change. An undo applied meanwhile
      // changed the document, not just the selection. Queued input and a
      // queued click act on the selection the queue holds, not on the view's.
      if (
        !globalRan &&
        !replayPending &&
        capture === null &&
        !queueHasSelect()
      ) {
        trackSelection(view.state, docChangedDuringSwap);
      }
      docChangedDuringSwap = false;

      windowStartLine = res.start_line;
      windowStartOffset = res.start_offset;
      windowEndOffset = res.end_offset;
      windowPrevLoneCr = res.prev_lone_cr;
      windowNextIsLf = res.next_is_lf;
      breaks = scanBreaks(res.text);
      totalLines = res.total_lines;
      totalBytes = res.total_bytes;
      // The window shows the core as it is now: nothing is left unshown, and
      // the view shows the caret again.
      unshownFrom = null;
      heldCaret = null;
      trimLog();
      // buildState reads `swapping`, so the fresh state starts read-only (or,
      // in the swap back to the caret, open to a captured composition only)
      // and stays that way until endSwap runs in the anchor rAF below. The caret
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
      windowInstalls += 1;
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
    // The height map, not posAtCoords: right after a scroll jump the lines at
    // the viewport are not drawn yet and posAtCoords has no answer.
    const top =
      view.scrollDOM.getBoundingClientRect().top + 2 - view.documentTop;
    const block = view.lineBlockAtHeight(top);
    return {
      globalLine:
        windowStartLine + (view.state.doc.lineAt(block.from).number - 1),
      pixelWithin: top - 2 - block.top,
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
    // The height map, as in captureAnchor: an undrawn viewport must not read
    // as the window's first line, or every swap would chain back to line 0.
    const block = view.lineBlockAtHeight(y - view.documentTop);
    return windowStartLine + (view.state.doc.lineAt(block.from).number - 1);
  }
  // On scroll, load the neighbouring window once the viewport nears a window edge.
  // IME composition defers the swap (full handling lands next segment): a swap
  // mid-composition would tear the composing text out from under the input.
  async function maybeSwap(): Promise<void> {
    if (
      view === undefined ||
      swapInFlight ||
      swapping ||
      replayPending ||
      holds > 0 ||
      locked ||
      view.composing
    ) {
      return;
    }
    const rect = view.scrollDOM.getBoundingClientRect();
    const top = lineAtViewportY(rect.top + 2);
    const bottom = lineAtViewportY(rect.bottom - 2);
    const target = swapTarget(
      top,
      bottom,
      windowStartLine,
      windowEndLine,
      totalLines,
    );
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
  // Callers waiting for the queue to be through (see `flushed`).
  let flushWaiters: (() => void)[] = [];
  function notifyFlushWaiters(): void {
    const waiting = flushWaiters;
    flushWaiters = [];
    for (const wake of waiting) {
      wake();
    }
  }
  // Callers waiting for no swap to run and the replay queue to be empty.
  let settleWaiters: (() => void)[] = [];
  function isSettled(): boolean {
    return !swapping && !replayPending;
  }
  function notifySettled(): void {
    notifyFlushWaiters();
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
  // A Select All over the file waits here until nothing is in flight: input
  // queued, a swap, the shadow, whole-file work and edits on their way to the
  // core must all be over. Input that arrives meanwhile is dropped.
  const selectAllGate = createSelectAllGate({
    settled: () =>
      settledState({
        queueEmpty: replayQueue.length === 0,
        replayPending,
        swapping,
        shadow,
        holds,
        pendingApplies,
      }),
    run: runSelectAll,
    interval: 20,
  });
  // Select from the start of the file to its end. The part of the selection
  // inside the window is live in the view, the rest is the global selection.
  async function runSelectAll(): Promise<void> {
    const release = await settledHold();
    if (release === null) {
      return;
    }
    try {
      await applyChain;
      const end = await invoke<LinePos>('windowed_end_pos', { sessionId });
      const v = view;
      if (v === undefined || locked || gone) {
        return;
      }
      const doc = v.state.doc;
      const whole = wholeFileSelection(end, {
        startLine: windowStartLine,
        lineCount: doc.lines,
        lineLength: (local) => doc.line(local + 1).length,
      });
      setViewSelection(
        v,
        docPos(doc, whole.live.anchor),
        docPos(doc, whole.live.head),
      );
      globalSel = whole.globalSel;
      lastLive = whole.lastLive;
      heldCaret = null;
      reportSelection();
    } finally {
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
    // A transaction a filter refuses leaves the flag as it was.
    const docBefore = v.state.doc;
    const flagBefore = forceNewGroup;
    forceNewGroup = true;
    v.dispatch({
      changes: { from: main.from, to: main.to, insert: replaceText },
      selection: { anchor: main.from + replaceText.length },
      userEvent: 'replace',
    });
    if (v.state.doc === docBefore) {
      forceNewGroup = flagBefore;
    }
    void findStep(false);
  }
  // Replace every hit in the core as one undoable step. The editor is
  // read-only from here until the window has been read again, and nothing typed
  // meanwhile is queued.
  async function replaceAll(): Promise<void> {
    const owner = sessionId;
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
      const res = await behindApplies(() => {
        // A selection no window mirrors follows the replace in the core.
        const track = trackOf(globalSel);
        return runop(
          owner,
          () =>
            invoke<ReplaceAllResult>('windowed_replace_all', {
              sessionId: owner,
              query,
              caseSensitive: findCase,
              replacement: replaceText,
              insertSep,
              ...(track !== undefined ? { track } : {}),
            }),
          (r) => r.count > 0,
        );
      });
      if (gone) {
        releaseToken(res.token);
        return;
      }
      totalLines = res.total_lines;
      totalBytes = res.total_bytes;
      // The window does not show the replaced content until it is read again.
      if (res.token !== null) {
        logChange({ token: res.token }, false);
      }
      cancelSearch();
      results = [];
      cursor = -1;
      searching = false;
      searchFinished = false;
      statusNote = formatReplaced(t('cm.replacedMany'), res.count);
      if (res.count > 0) {
        editSeq += 1;
        if (res.tracked !== undefined) {
          globalSel = { anchor: res.tracked[0], head: res.tracked[1] };
        }
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
    // The reservations of the copies and cuts in the queue are renewed by the
    // window's timer for as long as this editor holds them.
    const forgetTokens = liveTokens.add('reservation', () =>
      replayQueue.liveTokens(),
    );
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
      windowPrevLoneCr = res.prev_lone_cr;
      windowNextIsLf = res.next_is_lf;
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
      v.dom.addEventListener('focusout', onViewFocusOut);
      document.addEventListener('keydown', onDocKeydown, true);
      document.addEventListener(
        'compositionstart',
        onDocCompositionStart,
        true,
      );
      document.addEventListener('compositionend', onDocCompositionEnd);
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
      forgetTokens();
      releaseSettleWaiters();
      selectAllGate.cancel();
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
      view?.dom.removeEventListener('focusout', onViewFocusOut);
      document.removeEventListener('keydown', onDocKeydown, true);
      document.removeEventListener(
        'compositionstart',
        onDocCompositionStart,
        true,
      );
      document.removeEventListener('compositionend', onDocCompositionEnd);
      capture = null;
      captureStart = null;
      document.removeEventListener('paste', onDocPaste, true);
      document.removeEventListener('cut', onDocCopyCut, true);
      document.removeEventListener('copy', onDocCopyCut, true);
      dropReplay();
      // Whatever tokens the log still holds go back to the core.
      for (const change of changeLog) {
        if ('token' in change) {
          releaseToken(change.token);
        }
      }
      changeLog = [];
      unshownFrom = null;
      wakeShadow();
      notifyFlushWaiters();
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
    // Parked keys come back from the current shortcuts when the swap ends.
    if (view !== undefined && !keysParked) {
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
  // Edit > Select All (the macOS item is custom): the on-screen span, or the
  // whole file under the "file" setting, same as Mod-a.
  export function selectAllVisible(): void {
    if (view !== undefined) {
      selectVisible(view, 'menu');
    }
  }
  // DEV/automation: the global selection, the end of the file, the length of
  // the replay queue and whether the swap now running leaves the editor open to
  // input.
  export function swapKeepsInputNow(): boolean {
    return swapKeepsInput();
  }
  export function globalSelection(): LineSelection {
    return globalSel;
  }
  export function endPos(): Promise<LinePos> {
    return invoke<LinePos>('windowed_end_pos', { sessionId });
  }
  export function replayLength(): number {
    return replayQueue.length;
  }
  // DEV/automation: the global selection and what the editor is doing with it.
  export function globalInfo(): {
    globalSel: LineSelection;
    windowStartLine: number;
    swapping: boolean;
    settled: boolean;
    keepsInput: boolean;
    ownGlobalOp: boolean;
    windowInstalls: number;
    applies: number;
    globalOps: number;
  } {
    return {
      globalSel,
      windowStartLine,
      swapping,
      settled: isSettled() && replayQueue.length === 0,
      keepsInput: swapKeepsInput(),
      ownGlobalOp,
      windowInstalls,
      applies: applyCalls,
      globalOps: globalCalls,
    };
  }
  // DEV/automation: a click at global byte `offset`, which lies in the loaded
  // window, made the way the pointer makes it. False when it does not.
  export function pointerSelect(offset: number): boolean {
    if (
      view === undefined ||
      offset < windowStartOffset ||
      offset > windowEndOffset
    ) {
      return false;
    }
    const at = byteToChar(
      view.state.doc.toString(),
      breaks,
      offset - windowStartOffset,
    );
    if (at === null) {
      return false;
    }
    view.dispatch({ selection: { anchor: at }, userEvent: 'select.pointer' });
    return true;
  }
  // Called by the host before a tab switch: ends an IME composition and
  // resolves once its text has been read into the document and applied.
  export function endComposition(): Promise<void> {
    // The text of a composition that ended outside the window reaches the
    // core only once its swap back to the caret has replayed it.
    return settleThenDrain(
      () =>
        view === undefined ? Promise.resolve() : settleViewComposition(view),
      async () => {
        await settled();
        await applyChain;
      },
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
  // Whether input has not reached the core yet or might not have: a
  // composition is open, input is queued, the shadow runs or an apply is in
  // flight. Closing now could lose it.
  export function pendingInput(): boolean {
    return (
      capture !== null ||
      view?.composing === true ||
      replayPending ||
      shadow !== null ||
      pendingApplies > 0
    );
  }
  // Resolves once everything queued before the open composition (all of it,
  // with none open) is in the core, leaving the composition open. Starts the
  // swap back to the caret when input is queued and nothing runs. What is
  // queued behind the composition's slot follows its commit.
  export async function flushed(): Promise<void> {
    for (;;) {
      if (gone || locked || view === undefined) {
        return;
      }
      await applyChain;
      const head = replayQueue.head;
      const through = head === undefined || head.kind === 'slot';
      if (
        through &&
        !draining &&
        shadow?.busy !== true &&
        pendingApplies === 0 &&
        !ownGlobalOp
      ) {
        return;
      }
      if (
        !through &&
        !swapping &&
        !draining &&
        shadow === null &&
        holds === 0
      ) {
        if (replayTimer !== undefined) {
          clearTimeout(replayTimer);
          replayTimer = undefined;
          startReplaySwap();
        } else {
          resumeReplay();
        }
      }
      await new Promise<void>((resolve) => {
        flushWaiters.push(resolve);
      });
    }
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
