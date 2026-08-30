<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import { onMount, untrack } from 'svelte';
  import {
    Compartment,
    EditorState,
    type Extension,
    type Text,
  } from '@codemirror/state';
  import {
    EditorView,
    lineNumbers,
    highlightActiveLineGutter,
    highlightSpecialChars,
    drawSelection,
    dropCursor,
    rectangularSelection,
    crosshairCursor,
    highlightActiveLine,
    keymap,
    type ViewUpdate,
  } from '@codemirror/view';
  import {
    foldGutter,
    indentOnInput,
    syntaxHighlighting,
    defaultHighlightStyle,
    bracketMatching,
    foldKeymap,
  } from '@codemirror/language';
  import { history, defaultKeymap, historyKeymap } from '@codemirror/commands';
  import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
  import { searchWithInSelection } from './searchPanel';
  import {
    closeBrackets,
    autocompletion,
    closeBracketsKeymap,
    completionKeymap,
  } from '@codemirror/autocomplete';
  import { lintKeymap } from '@codemirror/lint';
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
    // True while any dialog/modal is up in the host window; suppresses the
    // automatic focus handoff so a gate/confirm keeps the keyboard.
    modalOpen?: boolean;
    onchange: (v: Text) => void;
    onselection: (line: number, col: number) => void;
    onview?: (view: EditorView | null) => void;
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
    modalOpen = false,
    onchange,
    onselection,
    onview,
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
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    // Custom search panel with an "in selection" option; replaces the default
    // panel that openSearchPanel would otherwise self-install.
    searchWithInSelection,
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      ...lintKeymap,
    ]),
  ];

  // The whole gutter column (line numbers + fold + active-line gutter) toggles
  // together, so turning line numbers off removes the gutter entirely.
  function gutterExtension(on: boolean): Extension {
    return on ? [lineNumbers(), highlightActiveLineGutter(), foldGutter()] : [];
  }

  let container: HTMLDivElement;
  let view: EditorView | undefined;
  // Swappable slots reconfigured in place, shared across every tab's state.
  const languageCompartment = new Compartment();
  const themeCompartment = new Compartment();
  const wrapCompartment = new Compartment();
  const gutterCompartment = new Compartment();
  // Off-main-thread highlighting for oversized documents, reconfigured in place
  // so switching tabs or toggling the flag adds/removes it (and disposes the
  // worker) without rebuilding the state.
  const workerCompartment = new Compartment();
  // Per-tab EditorState (doc + selection + history), keyed by tab id. Swapping
  // via view.setState keeps each tab's undo history and cursor isolated.
  const states = new Map<string, EditorState>();
  let mountedId = '';
  let langSeq = 0;
  let selRaf = 0;
  // Whether the active tab's document holds a line past LONG_LINE_THRESHOLD.
  // Reactive so the language/worker effects re-apply when it flips (a long line
  // is added, or the last long line is shortened back). Per-tab: rescanned on
  // mount and on every tab switch, updated incrementally on each edit.
  let hasLongLine = $state(false);

  function buildState(doc: Text): EditorState {
    return EditorState.create({
      doc,
      extensions: [
        // Required in every view, see the note in Editor.svelte.
        EditorView.cspNonce.of(readCspNonce()),
        coreSetup,
        gutterCompartment.of(gutterExtension(showLineNumbers)),
        wrapCompartment.of(wordWrap ? EditorView.lineWrapping : []),
        languageCompartment.of([]),
        workerCompartment.of([]),
        themeCompartment.of(varEditorTheme(dark)),
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
      ],
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
      if (state === undefined) {
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
    const state = buildState(content);
    view = new EditorView({ parent: container, state });
    mountedId = activeId;
    rescanLongLine(content);
    void applyLanguage(language, hasLongLine);
    applyWorkerHighlight(language, hasLongLine);
    reportSelection();
    onview?.(view);
    // Claim keyboard focus on load (initial mount, restore, or first open) so a
    // window opened programmatically does not silently drop the first keystrokes.
    focusEditorIfIdle(view, modalOpen);
    if (import.meta.env.DEV) {
      void import('../dev/editorRegistry').then((m) => m.setActiveView(view!));
    }
    return () => {
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
      states.set(mountedId, view.state);
      const incoming = states.get(id) ?? buildState(content);
      view.setState(incoming);
      mountedId = id;
      view.dispatch({
        effects: themeCompartment.reconfigure(varEditorTheme(dark)),
      });
      rescanLongLine(incoming.doc);
      void applyLanguage(language, hasLongLine);
      applyWorkerHighlight(language, hasLongLine);
      reportSelection();
      // Re-claim focus after a tab switch (read untracked, so this never re-runs
      // on a modal toggle) so typing works without clicking the switched-to tab.
      focusEditorIfIdle(view, modalOpen);
    });
  });

  // Replace the active tab's whole document when the buffer changed outside the
  // editor (e.g. re-decoded under a new encoding). Only reloadSeq is tracked;
  // content is read untracked so keystrokes never trigger this.
  $effect(() => {
    const seq = reloadSeq;
    untrack(() => {
      if (view === undefined || seq === 0) {
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

  // Forget saved states for tabs that have been closed.
  $effect(() => {
    const ids = new Set(openIds);
    untrack(() => {
      for (const key of states.keys()) {
        if (!ids.has(key)) {
          states.delete(key);
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
