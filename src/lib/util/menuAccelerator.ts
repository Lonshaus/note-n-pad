// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Windows-only: WebView2 keyboard input never reaches Tauri's native
// accelerator table, so a menu accelerator has to be matched here and run
// through the `trigger_menu_accelerator` command instead. See `main.ts`.

import {
  functionKey,
  eventKeyName,
  isComposingKey,
  type KeyLike,
} from './accelerator';
/** A keydown plus the flag the matcher uses to leave handled events alone. */
interface MenuKeyLike extends KeyLike {
  defaultPrevented: boolean;
}
/** Match a keydown against `table` (the canonical accelerators of the native
 *  menu items, as the Rust core lists them), returning the matching entry or
 *  null. Only active on Windows (`os === 'windows'`): macOS and Linux menu
 *  accelerators already fire through the platform's own mechanism, so this
 *  must never intercept a keydown there. Needs at least one modifier or an
 *  F key, and an event CodeMirror or another handler hasn't already claimed
 *  via `preventDefault`. While an IME composes, `saveAccelerator` (the
 *  effective Save key) is left alone: Notepad does not save mid-composition. */
export function matchMenuAccelerator(
  event: MenuKeyLike,
  os: string,
  table: readonly string[],
  saveAccelerator: string | null = null,
): string | null {
  if (os !== 'windows' || event.defaultPrevented) {
    return null;
  }
  const key = eventKeyName(event);
  if (key === null) {
    return null;
  }
  const parts: string[] = [];
  if (event.ctrlKey) {
    parts.push('Ctrl');
  }
  if (event.altKey) {
    parts.push('Alt');
  }
  if (event.shiftKey) {
    parts.push('Shift');
  }
  if (event.metaKey) {
    parts.push('Win');
  }
  if (parts.length === 0 && functionKey(key) === null) {
    return null;
  }
  const candidate = [...parts, key].join('+');
  if (candidate === saveAccelerator && isComposingKey(event)) {
    return null;
  }
  return table.includes(candidate) ? candidate : null;
}
