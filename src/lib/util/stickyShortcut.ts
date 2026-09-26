// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

export type StickyShortcut = 'quit' | 'close' | 'save';

/** The subset of `KeyboardEvent` this matcher needs, kept minimal so it is
 *  trivial to call with a plain object in tests. */
interface KeyLike {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  key: string;
}

/** Matches a keydown against this app's sticky shortcuts (see
 *  `StickyApp.svelte`'s keydown handler), or null when it isn't one. Ctrl
 *  must be the *only* modifier held:
 *  - Ctrl+Shift+S is this app's own save-as accelerator and must pass
 *    through untouched, not be swallowed as a plain save.
 *  - Ctrl+Alt is also how AltGr is reported on Linux/Windows browsers, so a
 *    bare "Ctrl+Alt+<letter>" here would misfire on any AltGr keypress.
 *    CodeMirror excludes the same combo for the same reason.
 *
 *  The platform policy lives here (not in the caller) so it stays covered by
 *  this function's own tests: a sticky has no menu bar on Linux at all
 *  (`detach_menu_unless_document` in windows.rs removes the inherited bar
 *  outright), so this handler is the only source of all three shortcuts
 *  there. On Windows every menu accelerator (Quit included) is now covered by
 *  the global keydown listener in `main.ts` (`trigger_menu_accelerator`), so
 *  this returns null there for every key — keeping it around would
 *  double-fire. macOS gets everything from the real system menu bar, so this
 *  returns null there too. */
export function matchStickyShortcut(
  event: KeyLike,
  os: string,
): StickyShortcut | null {
  if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) {
    return null;
  }
  let action: StickyShortcut | null;
  switch (event.key.toLowerCase()) {
    case 'q':
      action = 'quit';
      break;
    case 'w':
      action = 'close';
      break;
    case 's':
      action = 'save';
      break;
    default:
      action = null;
  }
  if (action === null) {
    return null;
  }
  if (os === 'linux') {
    return action;
  }
  return null;
}
