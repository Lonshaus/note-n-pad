// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { themeCssVars } from './themes';
import { themeRegistry } from './themeRegistry.svelte';
import { chromeCssVars, interfaceIsDark, type InterfaceMode } from './chrome';

/** Stamp the selected theme's editor colors onto the document root: `data-theme`
 *  (informational) plus the `--e-*` editor surface and `--tok-*` syntax vars.
 *  Called from each window's root `$effect` whenever `settingsState.themeId`
 *  changes; because it reads `themeRegistry`, that effect also re-runs when the
 *  theme set reloads (add/edit/delete/restore). A theme colors only the editor —
 *  the window chrome is `applyChrome`'s job.
 *
 *  An unresolvable id — a theme deleted elsewhere, or the registry not loaded
 *  yet — falls back to the first available theme so the editor is never left
 *  unthemed; the stored id is corrected separately (settings.svelte.ts's apply). */
export function applyTheme(id: string): void {
  const theme = themeRegistry.get(id) ?? themeRegistry.themes[0];
  if (theme === undefined) {
    return;
  }
  const root = document.documentElement;
  root.setAttribute('data-theme', theme.id);
  for (const [name, value] of Object.entries(themeCssVars(theme))) {
    root.style.setProperty(`--${name}`, value);
  }
}

/** Stamp the interface (chrome) appearance onto the document root: the `--bg`/
 *  `--fg`/`--topbar-border`/`--accent`/`--danger` variables and the native
 *  `color-scheme` (so scrollbars/form controls match). Independent of the editor
 *  theme — driven by the interface mode (light/dark/system) and, when following
 *  the system, the OS preference. Called from each window's root `$effect` on
 *  `settingsState.interfaceMode` / the OS preference. */
export function applyChrome(mode: InterfaceMode, prefersDark: boolean): void {
  const root = document.documentElement;
  // The system-color chrome vars resolve against `color-scheme`, so setting it
  // (from the mode, or the OS preference when following the system) is what
  // actually flips the interface between the native light and dark appearance.
  root.style.colorScheme = interfaceIsDark(mode, prefersDark)
    ? 'dark'
    : 'light';
  for (const [name, value] of Object.entries(chromeCssVars())) {
    root.style.setProperty(`--${name}`, value);
  }
}
