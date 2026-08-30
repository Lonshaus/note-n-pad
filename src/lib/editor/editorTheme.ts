// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

// A HighlightStyle whose colors are all CSS variables, so a theme change
// (data-theme id, live) recolors the editor with no `reconfigure` — the active
// theme just sets new `--tok-*` values on the root (applyTheme.ts). Covers
// exactly the tags the worker path's `.tok-*` CSS (app.css) also colors, so the
// synchronous and worker highlight paths always render identically; every other
// tag falls through to defaultHighlightStyle (fallback: true at the call site).
// Shared by DocumentEditor and the settings theme preview.
export const tokenVarHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--tok-keyword)' },
  {
    tag: [t.url, t.string, t.special(t.string), t.regexp, t.escape, t.inserted],
    color: 'var(--tok-string)',
  },
  { tag: t.number, color: 'var(--tok-number)' },
  { tag: [t.comment, t.meta, t.deleted], color: 'var(--tok-comment)' },
  { tag: t.macroName, color: 'var(--tok-function)' },
  { tag: [t.typeName, t.namespace, t.className], color: 'var(--tok-type)' },
  {
    tag: [
      t.labelName,
      t.definition(t.variableName),
      t.local(t.variableName),
      t.propertyName,
      t.definition(t.propertyName),
    ],
    color: 'var(--tok-variable)',
  },
  { tag: t.operator, color: 'var(--tok-operator)' },
  {
    tag: [t.atom, t.bool, t.literal, t.special(t.variableName)],
    color: 'var(--tok-const)',
  },
  { tag: t.invalid, color: '#f00' },
  { tag: t.link, textDecoration: 'underline' },
  {
    tag: t.heading,
    color: 'var(--tok-keyword)',
    textDecoration: 'underline',
    fontWeight: 'bold',
  },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
]);

/** The editor's own chrome (background/foreground/gutter/selection/cursor),
 *  read from the active theme's `--e-*`/`--fg`/`--accent` CSS variables so it
 *  recolors live with any of the 10 built-in themes, not just a fixed
 *  dark/light pair. Shared by DocumentEditor and WindowedEditor so both editor
 *  surfaces always match. `isDark` still toggles CodeMirror's internal
 *  `{ dark }` flag (affects default contrast choices for a few built-in
 *  overlays), so this is rebuilt per variant rather than one static extension. */
export function varEditorTheme(isDark: boolean): Extension {
  return EditorView.theme(
    {
      '&': { color: 'var(--e-fg)', backgroundColor: 'var(--e-bg)' },
      '.cm-content': { caretColor: 'var(--e-fg)' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--e-fg)' },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
        {
          backgroundColor: 'color-mix(in srgb, var(--accent) 35%, transparent)',
        },
      // The line-number gutter follows the interface chrome (--bg/--fg), not the
      // editor theme, so the numbers stay legible even when a dark editor theme
      // pairs with a light interface (or vice versa). A chrome-colored right
      // border separates it from the theme-colored editor content.
      '.cm-gutters': {
        backgroundColor: 'var(--bg)',
        color: 'var(--fg)',
        border: 'none',
        borderRight: '1px solid var(--topbar-border)',
      },
      // Editor content highlights use the editor theme's foreground so they stay
      // visible on the theme's background regardless of the interface chrome.
      '.cm-activeLine': {
        backgroundColor: 'color-mix(in srgb, var(--e-fg) 8%, transparent)',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'color-mix(in srgb, var(--fg) 14%, transparent)',
      },
    },
    { dark: isDark },
  );
}
