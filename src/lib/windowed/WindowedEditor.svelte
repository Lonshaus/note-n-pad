<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import {
    Compartment,
    EditorState,
    Transaction,
    type Extension,
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
    type ViewUpdate,
  } from '@codemirror/view';
  import { defaultKeymap } from '@codemirror/commands';
  import { varEditorTheme } from '../editor/editorTheme';
  import { cssFontFamily } from '../util/font';
  import {
    byteLength,
    byteToCharIndex,
    decideNewGroup,
    mapChangesToEdits,
    nextWindow,
    type RawChange,
    WINDOW_LINES,
    MARGIN_LINES,
    SWAP_THRESHOLD_LINES,
  } from '../util/windowedEdit';
  import { focusEditorIfIdle } from '../util/editorFocus';
  import { readCspNonce } from '../util/cspNonce';
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
   *  (for a jump-to-change window reload), and the live file totals. */
  interface UndoResult {
    edits: { start: number; end: number; text: string }[];
    first_line: number;
    total_bytes: number;
    total_lines: number;
  }

  interface Props {
    sessionId: number;
    initialTotalLines: number;
    // 0-based line the first window should cover, so an in-place unlock continues
    // from the line the user was viewing in the read-only view.
    initialTopLine?: number;
    dark: boolean;
    fontSize: number;
    fontFamily: string;
    wordWrap: boolean;
    lineNumbers: boolean;
    // True while any dialog/modal is up in the host window; suppresses the
    // automatic focus handoff so a gate/confirm keeps the keyboard.
    modalOpen?: boolean;
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
  }

  let {
    sessionId,
    initialTotalLines,
    initialTopLine = 0,
    dark,
    fontSize,
    fontFamily,
    wordWrap,
    lineNumbers: showLineNumbers,
    modalOpen = false,
    onapplied,
    onstatus,
    onerror,
  }: Props = $props();

  let container: HTMLDivElement;
  let view: EditorView | undefined;

  // Byte/line geometry of the currently loaded window. windowStartOffset is fixed
  // while editing inside a window (edits never move the window's start); the end
  // offset tracks the window text's byte length. Line bounds are 0-based, end
  // exclusive.
  let windowStartLine = 0;
  let windowEndLine = 0;
  let windowStartOffset = 0;
  let windowEndOffset = 0;
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
  // True while a programmatic window swap replaces the document, so the update
  // listener does not mistake the replacement for a user edit, and the scroll
  // handler ignores the scroll-position changes the swap causes.
  let swapping = false;
  // Guards against re-entrant swaps while one is in flight.
  let swapInFlight = false;
  let selRaf = 0;
  // True while an undo/redo result is being mirrored into the CM document, so the
  // update listener does not re-send those (already-in-core) changes back to Rust.
  let applyingRemote = false;
  // Grouping context of the previous applied edit, used to decide whether the next
  // edit opens a new undo group or coalesces into the current one.
  let lastApplyTime = 0;
  let lastEditKind: string | null = null;
  let prevComposing = false;

  const wrapCompartment = new Compartment();
  const themeCompartment = new Compartment();
  const gutterCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();

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

  // No CodeMirror `history()`: undo/redo is owned by the Rust journal (the whole
  // document lives there, not in CM), so Mod-z / Mod-Shift-z route to runUndo. A
  // local CM history would fight it — undoing only the window's slice of edits.
  const coreSetup: Extension = [
    highlightSpecialChars(),
    drawSelection(),
    dropCursor(),
    highlightActiveLine(),
    keymap.of([
      ...defaultKeymap,
      {
        key: 'Mod-z',
        preventDefault: true,
        run: () => {
          runUndo('undo');
          return true;
        },
      },
      {
        key: 'Mod-Shift-z',
        preventDefault: true,
        run: () => {
          runUndo('redo');
          return true;
        },
      },
    ]),
  ];

  function buildState(doc: string, cursorPos?: number): EditorState {
    return EditorState.create({
      doc,
      ...(cursorPos !== undefined ? { selection: { anchor: cursorPos } } : {}),
      extensions: [
        // Required in every view, see the note in Editor.svelte.
        EditorView.cspNonce.of(readCspNonce()),
        coreSetup,
        gutterCompartment.of(gutterExtension(showLineNumbers)),
        wrapCompartment.of(wordWrap ? EditorView.lineWrapping : []),
        themeCompartment.of(varEditorTheme(dark)),
        readOnlyCompartment.of(readOnlyExtension(locked || swapping)),
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
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !swapping && !applyingRemote) {
            handleUserEdit(update);
          }
          if (update.docChanged || update.selectionSet) {
            reportSelection();
          }
        }),
      ],
    });
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
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      onstatus({
        line: windowStartLine + line.number,
        col: head - line.from + 1,
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
    const edits = mapChangesToEdits(windowStartOffset, docBefore, changes);
    windowEndOffset =
      windowStartOffset + byteLength(update.state.doc.toString());
    windowEndLine = windowStartLine + update.state.doc.lines;
    const now = Date.now();
    const composing = view?.composing ?? false;
    const kind = editKind(update);
    const newGroup = decideNewGroup(
      { time: lastApplyTime, kind: lastEditKind, composing: prevComposing },
      {
        time: now,
        kind,
        composing,
        compositionStart: composing && !prevComposing,
      },
    );
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
    applyChain = applyChain.then(async () => {
      if (locked || view === undefined) {
        return;
      }
      let res: UndoResult;
      try {
        res = await invoke<UndoResult>(
          dir === 'undo' ? 'windowed_undo' : 'windowed_redo',
          { sessionId },
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
    applyingRemote = true;
    try {
      for (const e of res.edits) {
        const doc = view.state.doc.toString();
        const from = byteToCharIndex(doc, e.start - windowStartOffset);
        const to = byteToCharIndex(doc, e.end - windowStartOffset);
        view.dispatch({ changes: { from, to, insert: e.text } });
      }
    } finally {
      applyingRemote = false;
    }
    windowEndOffset = windowStartOffset + byteLength(view.state.doc.toString());
    windowEndLine = windowStartLine + view.state.doc.lines;
    totalLines = res.total_lines;
    totalBytes = res.total_bytes;
    reportSelection();
  }

  // Load the window covering `target` (0-based global line). `mode` decides how the
  // scroll position is set afterward: 'preserve' keeps the line at the viewport top
  // fixed (no visual jump — used by scroll-triggered swaps), 'goto' scrolls the
  // target line to the top (used by an explicit jump).
  // Enter/leave the swap phase. The whole swap — including the awaits inside
  // loadWindow — runs with the editor read-only: a keystroke landing between the
  // apply flush and the setState would be applied against the old window's byte
  // offsets and then silently overwritten by the swapped-in text, and one landing
  // between setState and the anchor rAF would be dropped by the `swapping` guard
  // in the update listener. Read-only closes both gaps honestly (input is briefly
  // refused instead of silently lost). endSwap is idempotent and always restores
  // the flag, so no exit path can wedge the editor in the ignore-edits state.
  function beginSwap(): void {
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
      view?.dispatch({
        effects: readOnlyCompartment.reconfigure(readOnlyExtension(false)),
      });
    }
  }

  async function loadWindow(
    target: number,
    mode: 'preserve' | 'goto',
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
        endSwap();
        lock(t('editor.locked.read', { detail: String(e) }));
        return;
      }
      // Capture the anchor and the cursor's global position against the OLD
      // window before the vars are overwritten.
      const anchor = mode === 'preserve' ? captureAnchor() : null;
      const oldHead = view.state.selection.main.head;
      const oldLine = view.state.doc.lineAt(oldHead);
      const cursorGlobal = windowStartLine + (oldLine.number - 1);
      const cursorCol = oldHead - oldLine.from;

      windowStartLine = res.start_line;
      windowStartOffset = res.start_offset;
      windowEndOffset = res.end_offset;
      totalLines = res.total_lines;
      totalBytes = res.total_bytes;

      // buildState reads `swapping`, so the fresh state starts read-only and
      // stays that way until endSwap runs in the anchor rAF below. The caret
      // goes in before the view ever sees the state, so no gap exists between
      // the new document and its selection.
      const fresh = buildState(res.text);

      // Place the cursor at its old global line when that line is still in the
      // window, otherwise clamp it to the window edge.
      const cursorTarget = mode === 'goto' ? target : cursorGlobal;
      const localNo = clamp(
        cursorTarget - windowStartLine + 1,
        1,
        fresh.doc.lines,
      );
      const cLine = fresh.doc.line(localNo);
      const cPos =
        mode === 'goto'
          ? cLine.from
          : Math.min(cLine.from + cursorCol, cLine.to);
      view.setState(fresh.update({ selection: { anchor: cPos } }).state);
      windowEndLine = windowStartLine + view.state.doc.lines;
      traceSwap({
        at: 'placed',
        mode,
        target,
        windowStartLine,
        cursorTarget,
        localNo,
        caretLine: windowStartLine + localNo,
      });

      requestAnimationFrame(() => {
        try {
          if (view !== undefined) {
            if (mode === 'goto') {
              scrollLineToTop(target);
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
      endSwap();
      lock(t('editor.locked.swap', { detail: String(e) }));
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
    }
  }

  onMount(() => {
    let disposed = false;
    void (async (): Promise<void> => {
      totalLines = initialTotalLines;
      const target = Math.min(
        Math.max(0, initialTopLine),
        Math.max(0, totalLines - 1),
      );
      const w = nextWindow(target, totalLines, WINDOW_LINES, MARGIN_LINES);
      let res: WindowRead;
      try {
        res = await invoke<WindowRead>('windowed_read', {
          sessionId,
          startLine: w.startLine,
          endLine: w.endLine,
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
      totalLines = res.total_lines;
      totalBytes = res.total_bytes;
      const v = new EditorView({
        parent: container,
        state: buildState(res.text),
      });
      view = v;
      windowEndLine = windowStartLine + v.state.doc.lines;
      // Continue from the line the user was viewing: place the caret there and
      // scroll it to the top so the unlock feels like the same view kept its place.
      if (target > windowStartLine) {
        const localNo = clamp(
          target - windowStartLine + 1,
          1,
          v.state.doc.lines,
        );
        const cLine = v.state.doc.line(localNo);
        v.dispatch({ selection: { anchor: cLine.from } });
        requestAnimationFrame(() => scrollLineToTop(target));
      }
      v.scrollDOM.addEventListener('scroll', onScroll);
      reportSelection();
      // Claim keyboard focus on load so an unlocked/restored windowed tab types
      // without a click.
      focusEditorIfIdle(v, modalOpen);
      if (import.meta.env.DEV) {
        void import('../dev/editorRegistry').then((m) => m.setActiveView(v));
      }
    })();
    return () => {
      disposed = true;
      if (selRaf !== 0) {
        cancelAnimationFrame(selRaf);
      }
      view?.scrollDOM.removeEventListener('scroll', onScroll);
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

  // Called by the host when the window regains focus, so a windowed tab types
  // without a click. Idle-gated like every other handoff.
  export function focus(): void {
    focusEditorIfIdle(view, modalOpen);
  }
</script>

<div
  class="editor"
  style="--doc-font-size: {fontSize}px; --doc-font-family: {cssFontFamily(
    fontFamily,
  )}"
  bind:this={container}
></div>

<style>
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
