// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** App interface (chrome) appearance — independent of the editor theme. A theme
 *  colors only the editor surface (`--e-*`/`--tok-*`); the window chrome
 *  (`--bg`/`--fg`/`--topbar-border`/`--accent`/`--danger`) just follows the
 *  system, so it looks native and never fights the editor. The chrome variables
 *  are CSS system colors (`Canvas`/`CanvasText`/`AccentColor`) — including the
 *  OS accent color — which resolve against the root `color-scheme`; the
 *  interface mode's only job is to set that `color-scheme` (light/dark/system). */

export type InterfaceMode = 'system' | 'light' | 'dark';

export function isInterfaceMode(value: string): value is InterfaceMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** Whether the interface renders dark under `mode`, given the OS preference
 *  (only consulted when the mode follows the system). Drives `color-scheme`. */
export function interfaceIsDark(
  mode: InterfaceMode,
  prefersDark: boolean,
): boolean {
  return mode === 'system' ? prefersDark : mode === 'dark';
}

/** The chrome CSS custom properties (without the leading `--`). System-color
 *  keywords track the OS light/dark and accent automatically once `color-scheme`
 *  is set, so these values are constant across modes. `danger` has no system
 *  color, so it stays a fixed red that reads on both grounds. */
export function chromeCssVars(): Record<string, string> {
  return {
    bg: 'Canvas',
    fg: 'CanvasText',
    'topbar-border': 'color-mix(in srgb, CanvasText 16%, transparent)',
    accent: 'AccentColor',
    danger: '#d84a3f',
  };
}
