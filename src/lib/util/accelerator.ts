// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// The canonical shortcut text (`Ctrl+Alt+Shift+Cmd|Win+<Key>`, as the Rust
// registry writes it) and the code that turns a keydown into it.
/** Where a shortcut is handled; the scope decides which part of a keydown
 *  names the key. */
export type ShortcutScope = 'global' | 'menu' | 'window' | 'editor';
/** The subset of `KeyboardEvent` the recorder and matchers read. */
export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
}
/** Whether a keydown belongs to an IME composition; such a key must not be
 *  named by its physical code (the IME reports key 'Process'). */
export function isComposingKey(e: KeyLike): boolean {
  return e.isComposing === true || e.key === 'Process';
}

const NAMED_KEYS: Record<string, string> = {
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Tab: 'Tab',
  Enter: 'Enter',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Escape: 'Escape',
  ' ': 'Space',
};
// US-layout punctuation by physical key, for the keys the format allows.
const CODE_PUNCTUATION: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
};
// Physical punctuation keys that carry no US counterpart (JIS yen and ro,
// ISO extra key). They are never recordable.
const OTHER_PUNCTUATION_CODES = new Set(['IntlBackslash', 'IntlYen', 'IntlRo']);

const CODE_NAMED_KEYS = new Set(
  Object.keys(NAMED_KEYS).filter((name) => name !== ' '),
);
const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Alt', 'Shift', 'AltGraph']);
/** `F1`..`F24`, else null. */
export function functionKey(key: string): string | null {
  return /^F([1-9]|1[0-9]|2[0-4])$/.test(key) ? key : null;
}
/** The canonical name of a non-character key from `KeyboardEvent.key`. */
export function namedKey(key: string): string | null {
  return NAMED_KEYS[key] ?? functionKey(key);
}
/** The canonical name of a non-character key from its physical `code`. Some
 *  macOS layouts (Zhuyin) turn Option+Esc into an invisible character in
 *  `key`; the code still names the key. */
export function namedKeyFromCode(code: string): string | null {
  return CODE_NAMED_KEYS.has(code) ? code : functionKey(code);
}
/** The letter on the physical key `code` names on a US layout, else null. */
export function letterFromCode(code: string): string | null {
  const m = /^Key([A-Z])$/.exec(code);
  return m === null ? null : (m[1] ?? null);
}
/** The digit on a number-row physical key, else null. */
export function digitFromCode(code: string): string | null {
  const m = /^Digit([0-9])$/.exec(code);
  return m === null ? null : (m[1] ?? null);
}
/** The US-layout punctuation character on a physical key, else null. */
export function punctuationFromCode(code: string): string | null {
  return CODE_PUNCTUATION[code] ?? null;
}

function isLatinLetter(key: string): boolean {
  return /^[a-zA-Z]$/.test(key);
}
/** The key part of a canonical shortcut: whatever follows the last `+`. */
export function splitAccelerator(accel: string): {
  mods: string[];
  key: string;
} {
  const tokens = accel.split('+');
  return { mods: tokens.slice(0, -1), key: tokens.at(-1) ?? '' };
}

export type RecordRejection =
  | 'punctuation'
  | 'unsupported-key'
  | 'needs-modifier'
  | 'mac-option'
  | 'unreachable'
  | 'no-layout-char';

export type RecordResult =
  | { status: 'ok'; accel: string }
  /** A bare modifier press: keep waiting for the rest of the combo. */
  | { status: 'ignore' }
  | { status: 'rejected'; reason: RecordRejection };

export interface RecordOptions {
  os: string;
  scope: ShortcutScope;
  /** The letter the current keyboard layout types on the physical key `code`
   *  (the `layout_char_for_code` command), or null when it has none. Only
   *  asked for on macOS, outside the global scope, when Option has replaced
   *  the key's character. */
  layoutChar: (code: string) => Promise<string | null>;
}

type KeyChoice =
  | { kind: 'key'; key: string }
  | { kind: 'ask'; code: string }
  | { kind: 'rejected'; reason: RecordRejection };
/** Pick the main key of a recording, by platform and scope (see the plan's
 *  key-source table). Characters are never recorded from punctuation keys:
 *  the same physical key types different characters on different layouts. */
function chooseKey(e: KeyLike, mac: boolean, scope: ShortcutScope): KeyChoice {
  const named = namedKey(e.key);
  if (named !== null) {
    return { kind: 'key', key: named };
  }
  const codeNamed = isComposingKey(e) ? null : namedKeyFromCode(e.code);
  if (codeNamed !== null) {
    return { kind: 'key', key: codeNamed };
  }
  const digit = digitFromCode(e.code);
  if (digit !== null) {
    return { kind: 'key', key: digit };
  }
  const letterCode = letterFromCode(e.code);
  if (mac && scope === 'global') {
    // Carbon registers a global hotkey by physical key.
    return letterCode === null
      ? punctuationOrUnsupported(e)
      : { kind: 'key', key: letterCode };
  }
  if (isLatinLetter(e.key)) {
    return { kind: 'key', key: e.key.toUpperCase() };
  }
  if (letterCode === null) {
    return punctuationOrUnsupported(e);
  }
  // Option replaced the character, or a non-Latin layout is active.
  return mac ? { kind: 'ask', code: e.code } : { kind: 'key', key: letterCode };
}

function punctuationOrUnsupported(e: KeyLike): KeyChoice {
  const punctuation =
    punctuationFromCode(e.code) !== null ||
    OTHER_PUNCTUATION_CODES.has(e.code) ||
    /^[\p{P}\p{S}]$/u.test(e.key);
  return {
    kind: 'rejected',
    reason: punctuation ? 'punctuation' : 'unsupported-key',
  };
}
/** Whether a canonical key, with Option as its only modifier (Shift aside),
 *  would be typed text on macOS. */
function isCharacterKey(key: string): boolean {
  return key.length === 1 || key === 'Space';
}
/** Turn a keydown into a canonical shortcut for `scope`. Read everything off
 *  the event before the first `await`: the caller `preventDefault`s
 *  synchronously and the event is not safe to read afterwards. */
export async function recordAccelerator(
  e: KeyLike,
  options: RecordOptions,
): Promise<RecordResult> {
  const { os, scope, layoutChar } = options;
  const mac = os === 'macos';
  const { key: rawKey, ctrlKey, altKey, shiftKey, metaKey } = e;
  if (MODIFIER_KEYS.has(rawKey)) {
    return { status: 'ignore' };
  }
  const choice = chooseKey(e, mac, scope);
  if (choice.kind === 'rejected') {
    return { status: 'rejected', reason: choice.reason };
  }
  let key: string;
  if (choice.kind === 'ask') {
    let letter: string | null;
    try {
      letter = await layoutChar(choice.code);
    } catch {
      letter = null;
    }
    if (letter === null || !/^[a-z]$/.test(letter)) {
      return { status: 'rejected', reason: 'no-layout-char' };
    }
    key = letter.toUpperCase();
  } else {
    key = choice.key;
  }
  // Command, Control or Option is required; Shift alone does not count. Only a
  // bare F1-F24 may go without.
  const hasModifier = ctrlKey || altKey || metaKey;
  if (!hasModifier && !(functionKey(key) !== null && !shiftKey)) {
    return { status: 'rejected', reason: 'needs-modifier' };
  }
  if (
    mac &&
    scope === 'editor' &&
    altKey &&
    !ctrlKey &&
    !metaKey &&
    isCharacterKey(key)
  ) {
    return { status: 'rejected', reason: 'mac-option' };
  }
  // CodeMirror reads Ctrl+Alt as AltGr on Windows and Linux and never falls
  // back to the physical key, so the shifted character (`!`) misses the digit.
  if (
    !mac &&
    scope === 'editor' &&
    ctrlKey &&
    altKey &&
    shiftKey &&
    /^[0-9]$/.test(key)
  ) {
    return { status: 'rejected', reason: 'unreachable' };
  }
  const parts: string[] = [];
  if (ctrlKey) {
    parts.push('Ctrl');
  }
  if (altKey) {
    parts.push('Alt');
  }
  if (shiftKey) {
    parts.push('Shift');
  }
  if (metaKey) {
    parts.push(mac ? 'Cmd' : 'Win');
  }
  parts.push(key);
  return { status: 'ok', accel: parts.join('+') };
}

const TYPED_PUNCTUATION = ",./\\;'[]-=`";
/** The canonical main key of a keydown as a menu or window shortcut sees it:
 *  the typed Latin letter or punctuation character, digits from the number
 *  row, named keys by name. With `codeFallback`, a key that typed something
 *  else (a non-Latin layout, Option's replacement character) is named by its
 *  US-layout physical position instead. Null when it has no canonical name. */
export function eventKeyName(e: KeyLike, codeFallback = true): string | null {
  const named = namedKey(e.key);
  if (named !== null) {
    return named;
  }
  const codeNamed = isComposingKey(e) ? null : namedKeyFromCode(e.code);
  if (codeNamed !== null) {
    return codeNamed;
  }
  const digit = digitFromCode(e.code);
  if (digit !== null) {
    return digit;
  }
  if (isLatinLetter(e.key)) {
    return e.key.toUpperCase();
  }
  if (e.key.length === 1 && TYPED_PUNCTUATION.includes(e.key)) {
    return e.key;
  }
  if (!codeFallback) {
    return null;
  }
  return letterFromCode(e.code) ?? punctuationFromCode(e.code);
}

/** Format an accelerator string for display, resolving the platform-agnostic
 *  legacy `CmdOrCtrl` token into the concrete modifier the host uses: `Cmd` on
 *  macOS, `Ctrl` elsewhere. Other tokens pass through unchanged. */
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
  Cmd: '⌘', // ⌘
};
const MAC_MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Cmd'];

/** Split an accelerator into its modifier tokens and final key token. `+` is
 *  both the token separator and (rarely) a literal key, so a trailing `++`
 *  (a `+`-key accelerator, e.g. `Cmd++`) is special-cased rather than
 *  swallowed by a plain `split('+')`. */
function tokenize(accel: string): { mods: string[]; key: string } {
  if (accel.endsWith('++')) {
    return { mods: accel.slice(0, -2).split('+').filter(Boolean), key: '+' };
  }
  return splitAccelerator(accel);
}
/** Format an accelerator string as the platform's native symbols: glyphs with
 *  no separator on macOS (`⌘⇧S`), `Ctrl+`/`Alt+`/`Shift+` chained with `+`
 *  elsewhere (`Ctrl+Shift+S`). Reads the canonical `Ctrl`/`Alt`/`Shift`/`Cmd`/
 *  `Win` spelling and the legacy `CmdOrCtrl`. The final key token is never
 *  translated. A modifier this app doesn't itself emit is preserved verbatim
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
  const resolved = mods.map((m) => (m === 'CmdOrCtrl' ? 'Cmd' : m));
  const known = MAC_MODIFIER_ORDER.filter((m) => resolved.includes(m)).map(
    (m) => MAC_SYMBOLS[m] ?? m,
  );
  const unknown = resolved.filter((m) => !MAC_MODIFIER_ORDER.includes(m));
  return [...unknown, ...known, key].join('');
}

const KEY_GLYPHS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Escape: 'Esc',
};
// What the native macOS menus draw; wins over KEY_GLYPHS.
const MAC_KEY_GLYPHS: Record<string, string> = {
  Backspace: '⌫',
  Delete: '⌦',
  Shift: '⇧',
  Enter: '↩',
  Escape: '⎋',
  Tab: '⇥',
  PageUp: '⇞',
  PageDown: '⇟',
  Home: '↖',
  End: '↘',
};
/** Like `formatAcceleratorSymbols`, but the final key is shown the way a
 *  keycap reads: arrows as arrows, `Escape` as `Esc`, and on macOS the glyphs
 *  the native menus draw (Enter, Escape, Tab, PageUp, PageDown, Home, End,
 *  Backspace, Delete and a bare Shift). */
export function formatKeyDisplay(accel: string, isMacOS: boolean): string {
  const { mods, key } = tokenize(accel);
  const shown = (isMacOS ? MAC_KEY_GLYPHS[key] : undefined) ?? KEY_GLYPHS[key];
  return formatAcceleratorSymbols([...mods, shown ?? key].join('+'), isMacOS);
}
