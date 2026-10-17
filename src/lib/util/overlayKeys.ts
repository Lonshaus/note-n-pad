// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import type { KeyLike } from './accelerator';
/** What a keydown means to a view drawn over the source editor (table, JSON,
 *  XML, Markdown), where the editor itself takes no keys. */
export type OverlayKeyAction = 'undo' | 'redo' | 'select-all';
/** The undo, redo or select-all key on `os`, or null for any other key.
 *  Undo is Ctrl/Cmd+Z and redo adds Shift; Windows and Linux also redo with
 *  Ctrl+Y alone (CodeMirror's `Mod-y`, and the key muda's menu Redo sends).
 *  Select all is Cmd+A on macOS and Ctrl+A elsewhere, with no other modifier. */
export function overlayKeyAction(
  e: KeyLike,
  os: string,
): OverlayKeyAction | null {
  const key = e.key.toLowerCase();
  if (key === 'z' && (e.metaKey || e.ctrlKey)) {
    return e.shiftKey ? 'redo' : 'undo';
  }
  const mod = os === 'macos' ? e.metaKey : e.ctrlKey;
  const other = os === 'macos' ? e.ctrlKey : e.metaKey;
  if (!mod || other || e.altKey) {
    return null;
  }
  if (key === 'y' && os !== 'macos' && !e.shiftKey) {
    return 'redo';
  }
  if (key === 'a' && !e.shiftKey) {
    return 'select-all';
  }
  return null;
}
