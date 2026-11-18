<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import { onMount, untrack } from 'svelte';
  import {
    Compartment,
    EditorState,
    type Extension,
    type StateEffect,
    type Text,
    type TransactionSpec,
  } from '@codemirror/state';
  import {
    EditorView,
    highlightActiveLineGutter,
    highlightSpecialChars,
    drawSelection,
    dropCursor,
    rectangularSelection,
    crosshairCursor,
    highlightActiveLine,
    type ViewUpdate,
  } from '@codemirror/view';
  import {
    foldGutter,
    indentOnInput,
    syntaxHighlighting,
    defaultHighlightStyle,
    bracketMatching,
  } from '@codemirror/language';
  import { history } from '@codemirror/commands';
  import { highlightSelectionMatches } from '@codemirror/search';
  import { searchWithInSelection } from './searchPanel';
  import { dialogMarquee } from './dialogMarquee';
  import { closeBrackets, autocompletion } from '@codemirror/autocomplete';
  import {
    loadLanguage,
    docHasLongLine,
    nextLongLineState,
    MAX_HIGHLIGHT_CHARS,
  } from './language';
  import { varEditorTheme, tokenVarHighlightStyle } from './editorTheme';
  import { cssFontFamily } from '../util/font';
  import { createHighlightClient } from '../highlight/client';
  import { resolveLanguageId } from '../highlight/languages';
  import { workerHighlight } from '../highlight/cmAdapter';
  import { isWorkerHighlightEnabled } from '../highlight/workerHighlight.svelte';
  import { focusEditorIfIdle } from '../util/editorFocus';
  import { readCspNonce } from '../util/cspNonce';
  import { keymapExtension } from './keymap';
  import { compositionCancel } from './composition';
  import { isUndoKey } from './imeShortcuts';
  import { stickyLineNumbers } from './stickyLineNumbers';
  import { cmPhraseExtension, cmPhraseSignature } from './cmPhrases';
  import { shortcutsState } from '../state/shortcuts.svelte';
  import { platform } from '../state/platform.svelte';
  import { rememberCopy } from '../util/linewiseCopy';
  import { pasteFlowDeps } from '../util/pasteEnv';
  import {
    PasteFlow,
    applyToSavedState,
    registerPasteTarget,
    type PasteHost,
  } from '../util/pasteFlow';
  import {
    editableWith,
    pasteLocks,
    refocusAfterUnlock,
    type PasteLock,
  } from '../util/pasteLock';
  import { isModalOpen, whenNoModal } from '../ConfirmModal.svelte';
  import {
    applyScrollRecord,
    scrollRecordOf,
    seededState,
    type ScrollRecord,
  } from './editorSeed';
  import type { Seed } from '../state/documentWindow.svelte';

  interface Props {
    activeId: string;
    content: Text;
    language: string | null;
    dark: boolean;
    fontSize: number;
    fontFamily: string;
    wordWrap: boolean;
    lineNumbers: boolean;
    openIds: string[];
    reloadSeq: number;
    // The tab id the last reloadSeq bump targeted; a bump aimed at another tab
    // is ignored while this editor is hidden.
    reloadTarget: string;
    // True while a windowed or large-file tab is shown instead: the editor
    // stays mounted to keep every tab's state, but takes no focus and reports
    // nothing to the status bar.
    hidden?: boolean;
    // True while a table, JSON, XML or Markdown view is drawn over this editor.
    // Separate from `hidden` so the per-tab state rules stay as they are: the
    // editor is still mounted and still holds the tab's state, but nothing can
    // be typed, deleted or pasted into it, and it never takes focus.
    overlay?: boolean;
    // True while any dialog/modal is up in the host window; suppresses the
    // automatic focus handoff so a gate/confirm keeps the keyboard.
    modalOpen?: boolean;
    onchange: (v: Text) => void;
    // The document of a tab that is not shown changed (a paste that finished
    // after a switch of tab).
    oncontentof?: (tabId: string, v: Text) => void;
    // The line ending a tab is written with.
    lineEndingOf?: (tabId: string) => '\n' | '\r\n';
    // Whether a paste that makes the document too big turns the tab into a
    // large file. False for an editor that is not a tab of the window.
    convertible?: boolean;
    onselection: (line: number, col: number) => void;
    onview?: (view: EditorView | null) => void;
    // What a tab that arrived from another window starts from besides its text:
    // its selection and history, and where it was scrolled to. Taken once, when
    // the tab's state is first built here.
    takeSeed?: (tabId: string) => Seed | undefined;
    // A tab's state was built from such a seed: its document is the tab's text.
    onseeded?: (tabId: string, doc: Text) => void;
    // Fired when the long-line gate for the active tab flips: true while the
    // document holds a line past LONG_LINE_THRESHOLD (synchronous highlighting
    // is off, worker highlighting takes over), false otherwise.
    onlongline?: (active: boolean) => void;
  }

  let {
    activeId,
    content,
    language,
    dark,
    fontSize,
    fontFamily,
    wordWrap,
    lineNumbers: showLineNumbers,
    openIds,
    reloadSeq,
    reloadTarget,
    hidden = false,
    overlay = false,
    modalOpen = false,
    onchange,
    oncontentof = () => {},
    lineEndingOf = () => '\n',
    convertible = true,
    onselection,
    onview,
    takeSeed,
    onseeded,
    onlongline,
  }: Props = $props();
  // basicSetup minus the gutter/line-wrapping bits, which move into compartments
  // so the settings window can toggle them live. Everything else matches the
  // upstream basicSetup bundle (search, folding, bracket matching, autocomplete).
  const coreSetup: Extension = [
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(tokenVarHighlightStyle),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    // The completion list's keys come from the keymap compartment below, so
    // the trigger key can be rebound.
    autocompletion({ defaultKeymap: false }),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    // Custom search panel with an "in selection" option; replaces the default
    // panel that openSearchPanel would otherwise self-install.
    searchWithInSelection,
  ];
  // The key bindings, rebuilt whenever the effective shortcuts change.
  function currentKeymap(): Extension {
    return keymapExtension('document', platform.os, (id) =>
      shortcutsState.accel(id),
    );
  }
  // The whole gutter column (line numbers + fold + active-line gutter) toggles
  // together, so turning line numbers off removes the gutter entirely.
  function gutterExtension(on: boolean): Extension {
    return on
      ? [stickyLineNumbers(), highlightActiveLineGutter(), foldGutter()]
      : [];
  }

  let container: HTMLDivElement;
  let view: EditorView | undefined;
  // Swappable slots reconfigured in place, shared across every tab's state.
  const languageCompartment = new Compartment();
  const themeCompartment = new Compartment();
  const wrapCompartment = new Compartment();
  const gutterCompartment = new Compartment();
  const keymapCompartment = new Compartment();
  // CodeMirror's own UI text in the active UI language.
  const phraseCompartment = new Compartment();
  // Off-main-thread highlighting for oversized documents, reconfigured in place
  // so switching tabs or toggling the flag adds/removes it (and disposes the
  // worker) without rebuilding the state.
  const workerCompartment = new Compartment();
  // Not editable while hidden or covered by a view: WebKit's `inert` blocks
  // typed text but not native editing commands (Delete, menu Select All) on a
  // still-focused editor.
  const editableCompartment = new Compartment();
  // Per-tab EditorState (doc + selection + history), keyed by tab id. Swapping
  // via view.setState keeps each tab's undo history and cursor isolated.
  const states = new Map<string, EditorState>();
  // Per-tab scroll snapshot (scroll is not part of EditorState), saved with the
  // state on switch-out and dispatched after setState on switch-in.
  const scrolls = new Map<string, StateEffect<unknown>>();
  // The same position as plain data, which is what a move to another window
  // carries (the snapshot effect above has no accessor).
  const scrollRecords = new Map<string, ScrollRecord>();
  // The last snapshot dispatched but not yet applied: CodeMirror applies a
  // scroll target only in its next measure pass, so until then the live view
  // does not show it and a capture must use this record instead.
  let pendingScroll: { id: string; snap: StateEffect<unknown> } | null = null;
  let mountedId = '';
  // Tabs whose paste lock went on while the editor had the focus.
  const refocusIds = new Set<string>();
  // The focus an unlocked editor lost is taken back unless it went elsewhere.
  function refocusEditor(id: string): void {
    const active = document.activeElement;
    if (
      view !== undefined &&
      refocusAfterUnlock({
        hadFocus: true,
        mounted: id === mountedId,
        editable: !hidden && !overlay,
        focusOnBody: active === null || active === document.body,
        modalOpen: isModalOpen(),
      })
    ) {
      view.focus();
    }
  }
  // A paste into a tab: it stops the event, asks the core what the clipboard
  // holds, and pastes in one transaction. The tab may have been switched away
  // from by then, so it reaches the tab's state wherever it is.
  const pasteHost: PasteHost = {
    dest: 'document',
    stateOf: (id) =>
      id === mountedId ? (view?.state ?? null) : (states.get(id) ?? null),
    apply: (id: string, spec: TransactionSpec) => {
      if (id === mountedId) {
        view?.dispatch(spec);
        return;
      }
      applyToSavedState(states, id, spec, oncontentof);
    },
    showLock: (id: string, lock: PasteLock | undefined) =>
      showTabLock(id, lock),
    eolOf: (id) => lineEndingOf(id),
  };
  // Put a lock on the tab's editor, or take it off.
  function showTabLock(id: string, lock: PasteLock | undefined): void {
    const effects = editableCompartment.reconfigure(
      editableWith(!hidden && !overlay, lock),
    );
    if (
      lock !== undefined &&
      id === mountedId &&
      view !== undefined &&
      document.activeElement === view.contentDOM
    ) {
      refocusIds.add(id);
    }
    if (id === mountedId) {
      view?.dispatch({ effects });
    } else {
      const saved = states.get(id);
      if (saved !== undefined) {
        states.set(id, saved.update({ effects }).state);
      }
    }
    if (lock === undefined && refocusIds.delete(id)) {
      setTimeout(() => {
        whenNoModal(() => refocusEditor(id));
      }, 0);
    }
  }
  // The window freezes a tab that is on its way to another window, and gives
  // it back, through the same lock a paste puts on it.
  export function showLock(id: string, lock: PasteLock | undefined): void {
    showTabLock(id, lock);
  }
  // The state of the tab's editor: the live one while it is shown, else the one
  // saved when it was switched away from. Null for a tab never held here.
  export function editorStateOf(id: string): EditorState | null {
    if (id === mountedId) {
      return view?.state ?? null;
    }
    return states.get(id) ?? null;
  }
  // Where the tab's editor is scrolled to, as plain data: read from the view
  // while it is shown, else from the record made when it was switched away
  // from. Null for a tab never switched out.
  export function scrollOf(id: string): ScrollRecord | null {
    if (id === mountedId) {
      return view === undefined ? null : scrollRecordOf(view);
    }
    return scrollRecords.get(id) ?? null;
  }
  const paste = new PasteFlow(pasteHost, {
    ...pasteFlowDeps,
    isLite: () => !convertible || pasteFlowDeps.isLite(),
  });
  let langSeq = 0;
  let selRaf = 0;
  // Whether the active tab's document holds a line past LONG_LINE_THRESHOLD.
  // Reactive so the language/worker effects re-apply when it flips (a long line
  // is added, or the last long line is shortened back). Per-tab: rescanned on
  // mount and on every tab switch, updated incrementally on each edit.
  let hasLongLine = $state(false);
  // Phrases baked into every state so far; a reconfigure is skipped when equal.
  let appliedPhrases = cmPhraseSignature();
  // What every tab's state is built with.
  function extensionsFor(id: string): Extension {
    return [
      // Required in every view, see the note in Editor.svelte.
      EditorView.cspNonce.of(readCspNonce()),
      coreSetup,
      keymapCompartment.of(currentKeymap()),
      // Undo while composing cancels the composition, as TextEdit does.
      platform.isMacOS ? compositionCancel(isUndoKey, afterCancel) : [],
      phraseCompartment.of(cmPhraseExtension()),
      dialogMarquee,
      gutterCompartment.of(gutterExtension(showLineNumbers)),
      wrapCompartment.of(wordWrap ? EditorView.lineWrapping : []),
      languageCompartment.of([]),
      workerCompartment.of([]),
      themeCompartment.of(varEditorTheme(dark)),
      editableCompartment.of(
        editableWith(!hidden && !overlay, pasteLocks.get(id)),
      ),
      // CodeMirror's own paste reads the clipboard by itself; ours asks the
      // core first, and reads it once.
      EditorView.domEventHandlers({
        paste: (e, v) => paste.onPaste(mountedId, v, e),
        copy: (_e, v) => {
          rememberCopy(v.state);
          return false;
        },
        cut: (_e, v) => {
          rememberCopy(v.state);
          return false;
        },
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          // Zero-copy: hand the rope reference to state, no whole-buffer string.
          onchange(update.state.doc);
          updateLongLineOnEdit(update);
        }
        if (update.docChanged || update.selectionSet) {
          reportSelection();
        }
      }),
    ];
  }
  function buildState(doc: Text, id: string): EditorState {
    return EditorState.create({ doc, extensions: extensionsFor(id) });
  }
  // The state of a tab that arrived from another window with its selection and
  // history, and the scroll it had; null when it came with neither.
  function seeded(
    id: string,
    doc: Text,
  ): { state: EditorState | null; scroll: ScrollRecord | null } | null {
    const seed = takeSeed?.(id);
    if (seed === undefined) {
      return null;
    }
    let state: EditorState | null = null;
    if (seed.editor !== null) {
      try {
        state = seededState(seed.editor, doc, extensionsFor(id));
      } catch (error) {
        console.error(
          'the editor state of a moved tab was not restored',
          error,
        );
      }
    }
    return { state, scroll: seed.scroll };
  }
  // Bring everything that mirrors the document back in line after a cancelled
  // composition replaced the state (setState runs no update listeners).
  function afterCancel(v: EditorView): void {
    onchange(v.state.doc);
    rescanLongLine(v.state.doc);
    reportSelection();
  }
  // The current scroll position of the mounted tab as a snapshot effect.
  function captureScroll(v: EditorView): StateEffect<unknown> {
    if (pendingScroll !== null && pendingScroll.id === mountedId) {
      return pendingScroll.snap;
    }
    return v.scrollSnapshot();
  }
  // Dispatch a scroll snapshot for the mounted tab and track it as pending
  // until the measure pass that applies it has run (CodeMirror's measure frame
  // is scheduled during the dispatch, so this later frame runs after it).
  function dispatchScroll(v: EditorView, snap: StateEffect<unknown>): void {
    v.dispatch({ effects: snap });
    const record = { id: mountedId, snap };
    pendingScroll = record;
    requestAnimationFrame(() => {
      if (pendingScroll === record) {
        pendingScroll = null;
      }
    });
  }
  // Report the caret's Ln/Col, coalesced to one update per frame so a burst of
  // keystrokes never churns the status-bar $state more than once per paint.
  function reportSelection(): void {
    if (selRaf !== 0) {
      return;
    }
    selRaf = requestAnimationFrame(() => {
      selRaf = 0;
      const state = view?.state;
      if (state === undefined || hidden) {
        return;
      }
      const head = state.selection.main.head;
      const line = state.doc.lineAt(head);
      onselection(line.number, head - line.from + 1);
    });
  }
  // Load a language extension off the reactive graph (async), with a sequence
  // guard so a slow earlier selection can't clobber a newer one. Synchronous
  // highlighting is forced off for oversized documents and for documents holding
  // a line past LONG_LINE_THRESHOLD (its per-keystroke re-parse stalls typing).
  async function applyLanguage(
    name: string | null,
    longLine: boolean,
  ): Promise<void> {
    const seq = ++langSeq;
    const gate =
      (view?.state.doc.length ?? 0) > MAX_HIGHLIGHT_CHARS || longLine;
    const ext = name === null || gate ? null : await loadLanguage(name);
    await Promise.resolve();
    if (seq === langSeq && view !== undefined) {
      view.dispatch({ effects: languageCompartment.reconfigure(ext ?? []) });
    }
  }
  // Recompute the long-line gate after an edit and, when it flips, notify the
  // host. Only the value is written here (no CM dispatch): the language/worker
  // effects read `hasLongLine` and re-apply once the in-progress update settles,
  // which avoids a forbidden nested dispatch from inside the update listener.
  function updateLongLineOnEdit(update: ViewUpdate): void {
    const doc = update.state.doc;
    let affectedMaxLen = 0;
    let removed = 0;
    let insertedLineBreak = false;
    update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      removed += toA - fromA;
      // A multi-line inserted rope means a line break landed in the doc, which
      // can split a long line into shorter ones (Enter mid-line, multi-line paste).
      if (inserted.lines > 1) {
        insertedLineBreak = true;
      }
      const startLine = doc.lineAt(fromB).number;
      const endLine = doc.lineAt(toB).number;
      for (let i = startLine; i <= endLine; i++) {
        const len = doc.line(i).length;
        if (len > affectedMaxLen) {
          affectedMaxLen = len;
        }
      }
    });
    const next = nextLongLineState(
      hasLongLine,
      affectedMaxLen,
      removed,
      insertedLineBreak,
      () => docHasLongLine(doc),
    );
    if (next !== hasLongLine) {
      hasLongLine = next;
      onlongline?.(next);
    }
  }
  // Rescan the long-line gate from scratch (on mount and on every tab switch)
  // and notify the host. Direct value set: not inside an effect.
  function rescanLongLine(doc: Text): void {
    const next = docHasLongLine(doc);
    hasLongLine = next;
    onlongline?.(next);
  }
  // Enable off-thread worker highlighting when the synchronous CM language path
  // is disabled (an oversized document or one with a line past the long-line
  // threshold), the setting is enabled, and a Lezer parser covers the language.
  // Otherwise reconfigure to empty, which tears down any running worker.
  // Reconfiguring to the same empty value on every call is cheap and keeps the
  // enable/disable logic in one place.
  function applyWorkerHighlight(name: string | null, longLine: boolean): void {
    if (view === undefined) {
      return;
    }
    const id = name === null ? null : resolveLanguageId(name);
    const on =
      isWorkerHighlightEnabled() &&
      (view.state.doc.length > MAX_HIGHLIGHT_CHARS || longLine) &&
      id !== null;
    const ext = on
      ? workerHighlight({ language: id, createClient: createHighlightClient })
      : [];
    view.dispatch({ effects: workerCompartment.reconfigure(ext) });
  }

  onMount(() => {
    const seed = seeded(activeId, content);
    const state = seed?.state ?? buildState(content, activeId);
    view = new EditorView({ parent: container, state });
    mountedId = activeId;
    const v = view;
    if (seed?.state != null) {
      onseeded?.(activeId, state.doc);
    }
    if (seed?.scroll != null) {
      applyScrollRecord(view, seed.scroll);
    }
    const forget = registerPasteTarget(v, (text) =>
      paste.pasteText(mountedId, v.state, text),
    );
    rescanLongLine(content);
    void applyLanguage(language, hasLongLine);
    applyWorkerHighlight(language, hasLongLine);
    reportSelection();
    onview?.(view);
    // Claim keyboard focus on load (initial mount, restore, or first open) so a
    // window opened programmatically does not silently drop the first keystrokes.
    if (!hidden && !overlay) {
      focusEditorIfIdle(view, modalOpen);
    }
    if (import.meta.env.DEV) {
      void import('../dev/editorRegistry').then((m) => m.setActiveView(view!));
    }
    return () => {
      forget();
      if (selRaf !== 0) {
        cancelAnimationFrame(selRaf);
      }
      onview?.(null);
      if (import.meta.env.DEV) {
        void import('../dev/editorRegistry').then((m) => m.setActiveView(null));
      }
      view?.destroy();
      view = undefined;
    };
  });
  // Swap the whole document (state) when the active tab changes; save the
  // outgoing tab's state first. Depends only on activeId — content/language/dark
  // are read untracked so this never re-runs on a keystroke.
  $effect(() => {
    const id = activeId;
    untrack(() => {
      if (view === undefined || id === mountedId) {
        return;
      }
      // A closed tab's state is dropped, never saved.
      if (openIds.includes(mountedId)) {
        states.set(mountedId, view.state);
        scrolls.set(mountedId, captureScroll(view));
        scrollRecords.set(mountedId, scrollRecordOf(view));
      }
      const saved = states.get(id);
      const seed = saved === undefined ? seeded(id, content) : null;
      const incoming = saved ?? seed?.state ?? buildState(content, id);
      view.setState(incoming);
      if (seed?.state != null) {
        onseeded?.(id, incoming.doc);
      }
      mountedId = id;
      view.dispatch({
        effects: [
          themeCompartment.reconfigure(varEditorTheme(dark)),
          editableCompartment.reconfigure(
            editableWith(!hidden && !overlay, pasteLocks.get(id)),
          ),
        ],
      });
      const snap = scrolls.get(id);
      if (seed?.scroll != null) {
        applyScrollRecord(view, seed.scroll);
      } else if (snap !== undefined) {
        dispatchScroll(view, snap);
      }
      rescanLongLine(incoming.doc);
      void applyLanguage(language, hasLongLine);
      applyWorkerHighlight(language, hasLongLine);
      reportSelection();
      // Re-claim focus after a tab switch (read untracked, so this never re-runs
      // on a modal toggle) so typing works without clicking the switched-to tab.
      if (!hidden && !overlay) {
        focusEditorIfIdle(view, modalOpen);
      }
    });
  });
  // Coming back from a windowed or large-file tab: report the caret and claim
  // focus again, as a fresh mount used to.
  let wasHidden = false;
  $effect(() => {
    const isHidden = hidden;
    const covered = overlay;
    untrack(() => {
      const returning = wasHidden && !isHidden;
      wasHidden = isHidden;
      if (view === undefined) {
        return;
      }
      view.dispatch({
        effects: editableCompartment.reconfigure(
          editableWith(!isHidden && !covered, pasteLocks.get(mountedId)),
        ),
      });
      if ((isHidden || covered) && view.hasFocus) {
        view.contentDOM.blur();
      }
      if (import.meta.env.DEV) {
        // The DEV automation hook drives the visible editor only.
        const v = view;
        void import('../dev/editorRegistry').then((m) => {
          if (!isHidden) {
            m.setActiveView(v);
          } else if (m.activeView() === v) {
            m.setActiveView(null);
          }
        });
      }
      if (returning) {
        reportSelection();
        if (!covered) {
          focusEditorIfIdle(view, modalOpen);
        }
      }
    });
  });
  // The reload count the editor mounted with: a bump from before it existed
  // changed a document this editor never held, and replacing the one it was
  // just built with (a moved tab's, history and all) would add an undo step.
  let reloadsSeen = untrack(() => reloadSeq);
  // Replace the active tab's whole document when the buffer changed outside the
  // editor (e.g. re-decoded under a new encoding). Only reloadSeq is tracked;
  // content is read untracked so keystrokes never trigger this.
  $effect(() => {
    const seq = reloadSeq;
    untrack(() => {
      if (view === undefined || seq === reloadsSeen) {
        return;
      }
      reloadsSeen = seq;
      if (hidden && reloadTarget !== mountedId) {
        return;
      }
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
      });
    });
  });
  // Live language change on the active tab; also re-runs when the long-line gate
  // flips (reading hasLongLine tracks it) so synchronous highlighting is
  // restored the moment the last long line is shortened.
  $effect(() => {
    const name = language;
    const longLine = hasLongLine;
    if (view !== undefined) {
      void applyLanguage(name, longLine);
    }
  });
  // Re-evaluate worker highlighting when the language, the setting, or the
  // long-line gate changes. Reading the getter tracks settingsState.workerHighlight,
  // so a settings-changed broadcast live-remounts/removes the worker compartment.
  $effect(() => {
    const name = language;
    const longLine = hasLongLine;
    isWorkerHighlightEnabled();
    if (view !== undefined) {
      applyWorkerHighlight(name, longLine);
    }
  });
  // Live theme change (window-wide).
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
  // Rebind the customizable commands when the effective shortcuts change. The
  // view takes the new bindings through its compartment; the states saved for
  // the other tabs are updated too, or they would bring the old keys back when
  // their tab is switched to.
  $effect(() => {
    const accels = shortcutsState.accelerators;
    const os = platform.os;
    untrack(() => {
      const ext = keymapExtension('document', os, (id) => accels[id] ?? null);
      const effects = keymapCompartment.reconfigure(ext);
      for (const [id, saved] of states) {
        states.set(id, saved.update({ effects }).state);
      }
      view?.dispatch({ effects });
    });
  });
  // Swap the CodeMirror phrases when the UI language changes; saved tab states
  // are updated too, or switching to one would bring the old language back.
  $effect(() => {
    const ext = cmPhraseExtension();
    const sig = cmPhraseSignature();
    untrack(() => {
      if (sig === appliedPhrases) {
        return;
      }
      appliedPhrases = sig;
      const effects = phraseCompartment.reconfigure(ext);
      for (const [id, saved] of states) {
        states.set(id, saved.update({ effects }).state);
      }
      if (view !== undefined) {
        // The phrase change rebuilds the view and drops its scroll, so put the
        // pre-change position back in a separate transaction.
        const snap = captureScroll(view);
        view.dispatch({ effects });
        dispatchScroll(view, snap);
      }
    });
  });
  // Forget saved states for tabs that have been closed.
  $effect(() => {
    const ids = new Set(openIds);
    untrack(() => {
      for (const key of states.keys()) {
        if (!ids.has(key)) {
          states.delete(key);
          scrolls.delete(key);
          scrollRecords.delete(key);
          pasteLocks.drop(key);
        }
      }
    });
  });
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
