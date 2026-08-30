<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import { onMount } from 'svelte';
  import { Compartment, EditorState, type Extension } from '@codemirror/state';
  import { EditorView, lineNumbers } from '@codemirror/view';
  import {
    syntaxHighlighting,
    defaultHighlightStyle,
  } from '@codemirror/language';
  import {
    varEditorTheme,
    tokenVarHighlightStyle,
  } from '../editor/editorTheme';
  import { loadLanguage } from '../editor/language';
  import { cssFontFamily } from '../util/font';
  import { readCspNonce } from '../util/cspNonce';

  interface Props {
    // Whether the currently selected theme is a dark variant. Only drives
    // CodeMirror's internal `{ dark }` contrast flag; the actual colors come
    // from the live `--tok-*`/`--e-*` variables, so switching between two themes
    // of the same variant needs no reconfigure at all.
    isDark: boolean;
    // The active editor font/size (a global setting, not part of the theme), so
    // the preview is fully WYSIWYG: colors from the theme, font from the editor
    // settings. Applied through CSS variables like the real editor surfaces, so
    // changing them recolors/reflows live with no CodeMirror reconfigure.
    fontSize: number;
    fontFamily: string;
  }

  let { isDark, fontSize, fontFamily }: Props = $props();

  // A representative snippet that exercises every token color the themes define:
  // line and block comments, keywords, strings (plain + template), numbers,
  // types, a function name, variables, operators, and boolean/const literals.
  const SAMPLE = `// Theme preview — see each token's color
import { themes } from './registry';

const FALLBACK = 'ink';
const COUNT = 10;

interface Theme {
  id: string;
  name: string;
  variant: 'light' | 'dark';
}

export function resolveTheme(id: string): Theme {
  const found = themes.get(id);
  return found ?? themes.get(FALLBACK)!;
}

/* Block comment: numbers, strings, booleans, operators */
const ratio = 0.875;
const label = \`Total themes: \${COUNT}\`;
const enabled = ratio > 0.5 && COUNT !== 0;
`;

  let container: HTMLDivElement;
  let view: EditorView | undefined;
  const themeCompartment = new Compartment();

  onMount(() => {
    let cancelled = false;
    void loadLanguage('TypeScript').then((lang: Extension | null) => {
      if (cancelled) {
        return;
      }
      view = new EditorView({
        parent: container,
        state: EditorState.create({
          doc: SAMPLE,
          extensions: [
            // Required in every view, see the note in Editor.svelte.
            EditorView.cspNonce.of(readCspNonce()),
            lineNumbers(),
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
            themeCompartment.of(varEditorTheme(isDark)),
            syntaxHighlighting(tokenVarHighlightStyle),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            lang ?? [],
          ],
        }),
      });
    });
    return () => {
      cancelled = true;
      view?.destroy();
    };
  });

  // Colors track the CSS variables live, but CodeMirror's `{ dark }` flag (set
  // when the view is built) affects a few default overlays, so rebuild just the
  // theme extension when the selected variant flips between light and dark.
  $effect(() => {
    const dark = isDark;
    view?.dispatch({
      effects: themeCompartment.reconfigure(varEditorTheme(dark)),
    });
  });
</script>

<div
  class="theme-preview"
  style="--doc-font-size: {fontSize}px; --doc-font-family: {cssFontFamily(
    fontFamily,
  )}"
  bind:this={container}
></div>

<style>
  .theme-preview {
    flex: 1 1 auto;
    min-width: 0;
    align-self: stretch;
    border: 1px solid var(--topbar-border);
    border-radius: 8px;
    overflow: hidden;
  }
  .theme-preview :global(.cm-editor) {
    height: 100%;
    font-size: var(--doc-font-size);
  }
  .theme-preview :global(.cm-scroller) {
    overflow: auto;
    font-family: var(--doc-font-family);
  }
</style>
