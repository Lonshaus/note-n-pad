// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Theme data model. Themes are pure data — the app core ships no theme
 *  constants: the defaults are seeded from external resource files into the app
 *  data dir on first run, and every theme (default, imported, or user-created)
 *  is loaded at runtime through `themeRegistry` (Rust `list_themes`). This module
 *  only defines the shape and the DOM-independent helpers.
 *
 *  Each theme fills the app's interface variables (bg/fg/topbar-border/accent/
 *  danger), the editor surface (bg/fg), and the 9 syntax-color roles shared by
 *  CodeMirror's synchronous HighlightStyle and the worker-highlight `.tok-*` CSS
 *  (see DocumentEditor.svelte and app.css). A theme's display name is a fixed
 *  string, never translated (like a language's own name). */

export type ThemeVariant = 'light' | 'dark';

export interface ThemeSyntax {
  keyword: string;
  string: string;
  number: string;
  comment: string;
  function: string;
  type: string;
  variable: string;
  operator: string;
  const: string;
}

/** A theme as loaded from / saved to the data layer. `isDefault` is a read-only
 *  flag the `list_themes` query adds — whether a matching default seed exists,
 *  so the UI can offer 復原 (restore) and the "（自訂）" edited marker. It is
 *  never part of the persisted file; Rust ignores it on save. */
export interface Theme {
  id: string;
  name: string;
  variant: ThemeVariant;
  editorBg: string;
  editorFg: string;
  uiBg: string;
  uiFg: string;
  uiAccent: string;
  uiBorder: string;
  danger: string;
  syntax: ThemeSyntax;
  isDefault?: boolean;
}

/** The 16 editable color fields of a theme, in display order, grouped for the
 *  color editor: editor surface, interface chrome, then the 9 syntax roles.
 *  `path` locates the value within a Theme (syntax colors are nested). Kept here
 *  next to the model so the editor and any validation share one list. */
export const THEME_COLOR_FIELDS: {
  group: 'editor' | 'ui' | 'syntax';
  key: string;
  path: keyof Theme | `syntax.${keyof ThemeSyntax}`;
}[] = [
  { group: 'editor', key: 'editorBg', path: 'editorBg' },
  { group: 'editor', key: 'editorFg', path: 'editorFg' },
  { group: 'ui', key: 'uiBg', path: 'uiBg' },
  { group: 'ui', key: 'uiFg', path: 'uiFg' },
  { group: 'ui', key: 'uiAccent', path: 'uiAccent' },
  { group: 'ui', key: 'uiBorder', path: 'uiBorder' },
  { group: 'ui', key: 'danger', path: 'danger' },
  { group: 'syntax', key: 'keyword', path: 'syntax.keyword' },
  { group: 'syntax', key: 'string', path: 'syntax.string' },
  { group: 'syntax', key: 'number', path: 'syntax.number' },
  { group: 'syntax', key: 'comment', path: 'syntax.comment' },
  { group: 'syntax', key: 'function', path: 'syntax.function' },
  { group: 'syntax', key: 'type', path: 'syntax.type' },
  { group: 'syntax', key: 'variable', path: 'syntax.variable' },
  { group: 'syntax', key: 'operator', path: 'syntax.operator' },
  { group: 'syntax', key: 'const', path: 'syntax.const' },
];

/** First-run default: the first theme of the OS-preferred variant, falling back
 *  to the first theme of any variant. Undefined only when no theme exists at all
 *  (the seeded defaults prevent that). This is the only place the OS light/dark
 *  preference has any effect — every later theme choice is the user's explicit
 *  pick, fixed until they change it again. */
export function pickDefaultTheme(
  prefersDark: boolean,
  themes: Theme[],
): string | undefined {
  const want: ThemeVariant = prefersDark ? 'dark' : 'light';
  return (themes.find((t) => t.variant === want) ?? themes[0])?.id;
}

/** The CSS custom properties (without the leading `--`) a theme sets on the
 *  document root: only the editor surface (`--e-*`) and the 9 `--tok-*` syntax
 *  roles read by both the synchronous HighlightStyle and the worker-highlight
 *  `.tok-*` CSS. A theme does not color the window chrome (`--bg` etc.) — that
 *  is the interface mode's job (chrome.ts). The theme's `ui*` fields are kept in
 *  the data model but currently unused. */
export function themeCssVars(theme: Theme): Record<string, string> {
  return {
    'e-bg': theme.editorBg,
    'e-fg': theme.editorFg,
    'tok-keyword': theme.syntax.keyword,
    'tok-string': theme.syntax.string,
    'tok-number': theme.syntax.number,
    'tok-comment': theme.syntax.comment,
    'tok-function': theme.syntax.function,
    'tok-type': theme.syntax.type,
    'tok-variable': theme.syntax.variable,
    'tok-operator': theme.syntax.operator,
    'tok-const': theme.syntax.const,
  };
}
