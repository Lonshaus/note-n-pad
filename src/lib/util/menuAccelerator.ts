// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Windows-only: WebView2 keyboard input never reaches Tauri's native
// accelerator table, so a menu accelerator has to be matched here and run
// through the `trigger_menu_accelerator` command instead. See `main.ts`.

import { keyEventToAccelerator } from './accelerator';

/** The subset of `KeyboardEvent` this matcher needs, kept minimal so it is
 *  trivial to call with a plain object in tests. */
interface KeyLike {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  defaultPrevented: boolean;
  key: string;
  code: string;
}

// Physical key names for the table's non-letter keys.
const CODE_KEYS: Record<string, string> = { Comma: ',' };

/** The US-layout key at `code`'s position, or null. A native accelerator
 *  matches the virtual-key code, so on a non-Latin layout Ctrl+S still means
 *  save even though `key` reports a local letter. */
function keyFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter !== null) {
    return letter[1] ?? null;
  }
  return CODE_KEYS[code] ?? null;
}

/** Match a keydown against `table` (a list of `CmdOrCtrl+…` accelerator
 *  strings, as `ACCELERATOR_TABLE` spells them), returning the matching table
 *  entry or null. Only active on Windows (`os === 'windows'`): macOS and
 *  Linux menu accelerators already fire through the platform's own
 *  mechanism, so this must never intercept a keydown there. Requires Ctrl
 *  (not Cmd/Meta) and an event CodeMirror or another handler hasn't already
 *  claimed via `preventDefault`. */
export function matchMenuAccelerator(
  event: KeyLike,
  os: string,
  table: readonly string[],
): string | null {
  if (os !== 'windows' || event.defaultPrevented) {
    return null;
  }
  if (!event.ctrlKey || event.metaKey) {
    return null;
  }
  let candidate = keyEventToAccelerator(event as KeyboardEvent);
  if (candidate === null) {
    const fromCode = keyFromCode(event.code);
    if (fromCode !== null) {
      // Copy fields explicitly: a DOM event's properties are prototype
      // getters, which object spread would drop.
      candidate = keyEventToAccelerator({
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        key: fromCode,
      } as KeyboardEvent);
    }
  }
  if (candidate === null || !table.includes(candidate)) {
    return null;
  }
  return candidate;
}
