// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Convert a browser keydown into a Tauri/global-hotkey accelerator string. The
// token grammar matches the plugin's own parser (CmdOrCtrl / Ctrl / Alt / Shift,
// then a single key), so anything this produces round-trips through registration.

const ARROWS: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
};

// Named editing keys the plugin accepts verbatim.
const NAMED = new Set([
  'Enter',
  'Tab',
  'Backspace',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Insert',
  'Escape',
]);

// Punctuation the plugin accepts as a literal token (e.g. the CmdOrCtrl+, combo).
const PUNCT = new Set([',', '.', '/', '\\', '`', '-', '=', ';', "'", '[', ']']);
// Physical-key names for the punctuation set above (macOS code path).
const CODE_PUNCT: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
};
/** The key at a physical `code`, or null if unsupported. */
function keyFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter !== null) {
    return letter[1] ?? null;
  }
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit !== null) {
    return digit[1] ?? null;
  }
  return CODE_PUNCT[code] ?? null;
}

/** Normalize the event's main key, or null when it carries no real key (a bare
 *  modifier press). */
function normalizeKey(e: KeyboardEvent): string | null {
  const k = e.key;
  if (k === 'Control' || k === 'Meta' || k === 'Alt' || k === 'Shift') {
    return null;
  }
  const arrow = ARROWS[k];
  if (arrow !== undefined) {
    return arrow;
  }
  if (k === ' ' || k === 'Spacebar') {
    return 'Space';
  }
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(k)) {
    return k;
  }
  if (/^[a-zA-Z]$/.test(k)) {
    return k.toUpperCase();
  }
  if (/^[0-9]$/.test(k)) {
    return k;
  }
  if (NAMED.has(k)) {
    return k;
  }
  if (PUNCT.has(k)) {
    return k;
  }
  return null;
}

/** Serialize a keydown to an accelerator, or null if unusable. On macOS with a
 *  modifier held the key comes from `e.code`, and Control stays apart from Command. */
export function keyEventToAccelerator(
  e: KeyboardEvent,
  os: string = '',
): string | null {
  const mac = os === 'macos';
  const anyModifier = e.metaKey || e.ctrlKey || e.altKey || e.shiftKey;
  const key =
    (mac && anyModifier ? keyFromCode(e.code ?? '') : null) ?? normalizeKey(e);
  if (key === null) {
    return null;
  }
  const parts: string[] = [];
  if (mac) {
    if (e.metaKey) {
      parts.push('CmdOrCtrl');
    }
    if (e.ctrlKey) {
      parts.push('Ctrl');
    }
  } else if (e.metaKey || e.ctrlKey) {
    parts.push('CmdOrCtrl');
  }
  if (e.altKey) {
    parts.push('Alt');
  }
  if (e.shiftKey) {
    parts.push('Shift');
  }
  parts.push(key);
  return parts.join('+');
}
/** A global shortcut needs Command/Control/Alt, or must be a bare F1-F24. */
export function isValidRecordedShortcut(accel: string): boolean {
  const { mods, key } = tokenize(accel);
  if (mods.length === 0) {
    return /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
  }
  return mods.some((m) => m === 'CmdOrCtrl' || m === 'Ctrl' || m === 'Alt');
}

/** Format an accelerator string for display, resolving the platform-agnostic
 *  `CmdOrCtrl` token into the concrete modifier the host uses: `Cmd` on macOS,
 *  `Ctrl` elsewhere. Other tokens pass through unchanged. Never leaks the raw
 *  `CmdOrCtrl` token to the user. */
export function formatAccelerator(accel: string, isMacOS: boolean): string {
  return accel
    .split('+')
    .map((token) => {
      if (token === 'CmdOrCtrl') {
        return isMacOS ? 'Cmd' : 'Ctrl';
      }
      return token;
    })
    .join('+');
}

// macOS renders these modifiers as glyphs with no separator, in this fixed
// display order (Control, Option, Shift, Command) regardless of the
// accelerator string's own token order.
const MAC_SYMBOLS: Record<string, string> = {
  Ctrl: '⌃', // ⌃
  Alt: '⌥', // ⌥
  Shift: '⇧', // ⇧
  CmdOrCtrl: '⌘', // ⌘
};
const MAC_MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'CmdOrCtrl'];

/** Split an accelerator into its modifier tokens and final key token. `+` is
 *  both the token separator and (rarely) a literal key, so a trailing `++`
 *  (a `+`-key accelerator, e.g. `CmdOrCtrl++`) is special-cased rather than
 *  swallowed by a plain `split('+')`. */
function tokenize(accel: string): { mods: string[]; key: string } {
  if (accel.endsWith('++')) {
    return { mods: accel.slice(0, -2).split('+').filter(Boolean), key: '+' };
  }
  const tokens = accel.split('+');
  return { mods: tokens.slice(0, -1), key: tokens.at(-1) ?? '' };
}

/** Format an accelerator string as the platform's native symbols for the
 *  Keyboard Shortcuts window: glyphs with no separator on macOS (`⌘⇧S`),
 *  `Ctrl+`/`Alt+`/`Shift+` chained with `+` elsewhere (`Ctrl+Shift+S`). The
 *  final key token is never translated. A modifier this app doesn't itself
 *  emit (anything but `CmdOrCtrl`/`Alt`/`Shift`/`Ctrl`) is preserved verbatim
 *  rather than silently dropped — it just isn't placed in the fixed mac
 *  ordering, since that ordering has no rule for it. */
export function formatAcceleratorSymbols(
  accel: string,
  isMacOS: boolean,
): string {
  const { mods, key } = tokenize(accel);
  if (!isMacOS) {
    return mods
      .map((m) => (m === 'CmdOrCtrl' ? 'Ctrl' : m))
      .concat(key)
      .join('+');
  }
  const known = MAC_MODIFIER_ORDER.filter((m) => mods.includes(m)).map(
    (m) => MAC_SYMBOLS[m] ?? m,
  );
  const unknown = mods.filter((m) => !MAC_MODIFIER_ORDER.includes(m));
  return [...unknown, ...known, key].join('');
}
