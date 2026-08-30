<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import { onMount } from 'svelte';
  import { Compartment, EditorState, type Extension } from '@codemirror/state';
  import {
    EditorView,
    keymap,
    drawSelection,
    highlightSpecialChars,
  } from '@codemirror/view';
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
  import {
    syntaxHighlighting,
    defaultHighlightStyle,
  } from '@codemirror/language';
  import { searchKeymap } from '@codemirror/search';
  import { basicSetup } from 'codemirror';
  import { oneDark } from '@codemirror/theme-one-dark';
  import { searchWithInSelection } from './searchPanel';
  import { readCspNonce } from '../util/cspNonce';

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

  // Paper-note editor: writing surface only, no gutters/line numbers/active-line.
  // Keeps the language + theme compartments so highlighting still works.
  const minimalSetup: Extension = [
    history(),
    drawSelection(),
    highlightSpecialChars(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    EditorView.lineWrapping,
    searchWithInSelection,
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
  ];

  let container: HTMLDivElement;
  let view: EditorView | undefined;
  // Swappable slot for the active language, reconfigured without rebuilding the view.
  const languageCompartment = new Compartment();
  // Swappable slot for the dark theme, reconfigured without rebuilding the view.
  const themeCompartment = new Compartment();

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
          minimal ? minimalSetup : basicSetup,
          languageCompartment.of([]),
          themeCompartment.of([]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onchange(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    view = v;
    onview?.(v);
    // DEV-only: expose this view to the automation hook. Dynamic import so the
    // registry (and its callers) are absent from the production bundle.
    if (import.meta.env.DEV) {
      void import('../dev/editorRegistry').then((m) => m.setActiveView(v));
    }
    return () => {
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
