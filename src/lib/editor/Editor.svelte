<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import { onMount } from 'svelte';
  import {
    Compartment,
    EditorState,
    type Extension,
    type TransactionSpec,
  } from '@codemirror/state';
  import {
    EditorView,
    keymap,
    drawSelection,
    highlightSpecialChars,
  } from '@codemirror/view';
  import { history } from '@codemirror/commands';
  import {
    syntaxHighlighting,
    defaultHighlightStyle,
  } from '@codemirror/language';
  import { basicSetup } from 'codemirror';
  import { oneDark } from '@codemirror/theme-one-dark';
  import { readCspNonce } from '../util/cspNonce';
  import { keymapExtension } from './keymap';
  import { compositionCancel } from './composition';
  import { isUndoKey } from './imeShortcuts';
  import { cmPhraseExtension, cmPhraseSignature } from './cmPhrases';
  import { shortcutsState } from '../state/shortcuts.svelte';
  import { platform } from '../state/platform.svelte';
  import { rememberCopy } from '../util/linewiseCopy';
  import { pasteFlowDeps } from '../util/pasteEnv';
  import {
    PasteFlow,
    STICKY_KEY,
    registerPasteTarget,
    type PasteHost,
  } from '../util/pasteFlow';
  import { editableWith, pasteLocks, type PasteLock } from '../util/pasteLock';

  interface Props {
    value: string;
    lang: Extension | null;
    dark: boolean;
    minimal?: boolean;
    onchange: (v: string) => void;
    onview?: ((view: EditorView | null) => void) | undefined;
  }

  let {
    value,
    lang,
    dark,
    minimal = false,
    onchange,
    onview,
  }: Props = $props();
  // Sticky notes have no search: swallow Mod-f, F3 and Shift-F3 so neither
  // the search panel nor a WebView2 find bar can open from a sticky.
  const stickyNoSearch = () => true;
  // Paper-note editor: writing surface only, no gutters/line numbers/active-line.
  // Keeps the language + theme compartments so highlighting still works.
  const minimalSetup: Extension = [
    history(),
    EditorState.allowMultipleSelections.of(true),
    drawSelection(),
    highlightSpecialChars(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    EditorView.lineWrapping,
    keymap.of([
      { key: 'Mod-f', run: stickyNoSearch },
      {
        key: 'F3',
        run: stickyNoSearch,
        shift: stickyNoSearch,
        preventDefault: true,
      },
    ]),
  ];

  let container: HTMLDivElement;
  let view: EditorView | undefined;
  // Swappable slot for the active language, reconfigured without rebuilding the view.
  const languageCompartment = new Compartment();
  // Swappable slot for the dark theme, reconfigured without rebuilding the view.
  const themeCompartment = new Compartment();
  // The rebindable commands' keys (minimal editors only; the full setup ships
  // its own keymaps).
  const keymapCompartment = new Compartment();
  // CodeMirror's own UI text in the active UI language.
  const phraseCompartment = new Compartment();
  // The paste lock of the note: its editor is its only tab.
  const editableCompartment = new Compartment();
  // Phrases baked into the state so far; a reconfigure is skipped when equal.
  let appliedPhrases = cmPhraseSignature();
  // A paste into the note: it stops the event, asks the core what the
  // clipboard holds, and pastes in one transaction.
  const pasteHost: PasteHost = {
    dest: 'sticky',
    stateOf: () => view?.state ?? null,
    apply: (_id: string, spec: TransactionSpec) => {
      view?.dispatch(spec);
    },
    showLock: (_id: string, lock: PasteLock | undefined) => {
      view?.dispatch({
        effects: editableCompartment.reconfigure(editableWith(true, lock)),
      });
    },
    eolOf: () => '\n',
  };
  const paste = new PasteFlow(pasteHost, pasteFlowDeps);

  function currentKeymap(): Extension {
    return keymapExtension('sticky', platform.os, (id) =>
      shortcutsState.accel(id),
    );
  }
  // Create the view exactly once; a reactive $effect here would rebuild the
  // editor (and drop focus) on every keystroke since it reads `value`.
  onMount(() => {
    const v = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: value,
        extensions: [
          // Every EditorView in the app must carry this, not just the first one
          // written: style-mod caches one StyleSet per document root, so whichever
          // view happens to mount first decides whether that window's shared style
          // element is created with a nonce. A later setNonce only writes the
          // attribute, which does not re-run the CSP check, so a missing nonce
          // here breaks styling for the whole window. Do not deduplicate.
          EditorView.cspNonce.of(readCspNonce()),
          minimal
            ? [minimalSetup, keymapCompartment.of(currentKeymap())]
            : basicSetup,
          // Undo while composing cancels the composition, as TextEdit does.
          platform.isMacOS
            ? compositionCancel(isUndoKey, (v) =>
                onchange(v.state.doc.toString()),
              )
            : [],
          phraseCompartment.of(cmPhraseExtension()),
          languageCompartment.of([]),
          themeCompartment.of([]),
          editableCompartment.of(
            editableWith(true, pasteLocks.get(STICKY_KEY)),
          ),
          // CodeMirror's own paste reads the clipboard by itself; ours asks
          // the core first, and reads it once.
          EditorView.domEventHandlers({
            paste: (e, v) => paste.onPaste(STICKY_KEY, v, e),
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
              onchange(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    view = v;
    const forget = registerPasteTarget(v, (text) =>
      paste.pasteText(STICKY_KEY, v.state, text),
    );
    onview?.(v);
    // DEV-only: expose this view to the automation hook. Dynamic import so the
    // registry (and its callers) are absent from the production bundle.
    if (import.meta.env.DEV) {
      void import('../dev/editorRegistry').then((m) => m.setActiveView(v));
    }
    return () => {
      forget();
      onview?.(null);
      if (import.meta.env.DEV) {
        void import('../dev/editorRegistry').then((m) => m.setActiveView(null));
      }
      v.destroy();
      view = undefined;
    };
  });
  // Propagate external value changes only when they differ from the current doc,
  // so our own edits (which already updated `value`) don't loop back in.
  $effect(() => {
    const next = value;
    if (view !== undefined && next !== view.state.doc.toString()) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
      });
    }
  });
  // Rebind the customizable commands when the effective shortcuts change.
  $effect(() => {
    const accels = shortcutsState.accelerators;
    const os = platform.os;
    if (view !== undefined && minimal) {
      view.dispatch({
        effects: keymapCompartment.reconfigure(
          keymapExtension('sticky', os, (id) => accels[id] ?? null),
        ),
      });
    }
  });
  // Swap the CodeMirror phrases when the UI language changes.
  $effect(() => {
    const ext = cmPhraseExtension();
    const sig = cmPhraseSignature();
    if (view !== undefined && sig !== appliedPhrases) {
      appliedPhrases = sig;
      // The phrase change rebuilds the view, so put the scroll position back.
      const top = view.scrollDOM.scrollTop;
      view.dispatch({ effects: phraseCompartment.reconfigure(ext) });
      const restoring = view;
      // Runs after CodeMirror's own measure pass, which moves the scroll.
      requestAnimationFrame(() => {
        restoring.scrollDOM.scrollTop = top;
      });
    }
  });
  // Swap the language extension in place; never recreate the view.
  $effect(() => {
    const next = lang;
    if (view !== undefined) {
      view.dispatch({
        effects: languageCompartment.reconfigure(next ?? []),
      });
    }
  });
  // Swap the editor theme in place; never recreate the view.
  $effect(() => {
    const isDark = dark;
    if (view !== undefined) {
      view.dispatch({
        effects: themeCompartment.reconfigure(isDark ? oneDark : []),
      });
    }
  });
</script>

<div class="editor" class:minimal bind:this={container}></div>

<style>
  .editor {
    height: 100%;
    overflow: hidden;
  }
  .editor :global(.cm-editor) {
    height: 100%;
  }
  .editor :global(.cm-scroller) {
    overflow: auto;
  }
  .editor.minimal :global(.cm-editor) {
    background: transparent;
  }
  .editor.minimal :global(.cm-content) {
    padding: 10px 12px;
    /* Memo-paper feel: system sans in stickies; document windows keep monospace. */
    font-family: system-ui, sans-serif;
    font-size: 13px;
    caret-color: var(--sticky-caret);
  }
  .editor.minimal :global(.cm-cursor) {
    border-left-color: var(--sticky-caret);
  }
  .editor.minimal :global(.cm-selectionBackground) {
    background: var(--sticky-selection) !important;
  }
  .editor.minimal :global(.cm-focused .cm-selectionBackground) {
    background: var(--sticky-selection) !important;
  }
</style>
