// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Matching a keydown against a window-scoped shortcut (tab switching, go to
// line in the large-file view) given the canonical text the Rust registry
// holds. The rules mirror CodeMirror's so a shortcut behaves the same in the
// editor and in a window handler on the same layout.

import { eventKeyName, splitAccelerator, type KeyLike } from './accelerator';
/** Whether CodeMirror would fall back from the typed character to the
 *  physical key for this modifier set: not for Option alone on macOS (that is
 *  typing) and not for Ctrl+Alt on Windows (that is AltGr). */
function usesCodeFallback(e: KeyLike, os: string): boolean {
  if (os === 'macos') {
    return !(e.altKey && !e.ctrlKey && !e.metaKey);
  }
  return !(e.ctrlKey && e.altKey);
}
/** Whether `e` is exactly the shortcut `accel` (canonical text) on `os`. The
 *  modifiers must match exactly; the key is the typed Latin letter, else the
 *  US letter of the physical key when Option or a non-Latin layout replaced it
 *  (so Option+Command+G still matches), with digits from the number row. */
export function matchWindowShortcut(
  e: KeyLike,
  accel: string,
  os: string,
): boolean {
  const { mods, key } = splitAccelerator(accel);
  const wanted = new Set(mods);
  const meta = wanted.has('Cmd') || wanted.has('Win');
  if (
    wanted.has('Ctrl') !== e.ctrlKey ||
    wanted.has('Alt') !== e.altKey ||
    wanted.has('Shift') !== e.shiftKey ||
    meta !== e.metaKey
  ) {
    return false;
  }
  return eventKeyName(e, usesCodeFallback(e, os)) === key;
}
