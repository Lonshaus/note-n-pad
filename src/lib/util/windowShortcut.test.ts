// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { KeyLike } from './accelerator';
import { matchWindowShortcut } from './windowShortcut';

function ev(
  key: string,
  code: string,
  mods: Partial<
    Pick<KeyLike, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>
  > = {},
): KeyLike {
  return {
    key,
    code,
    metaKey: mods.metaKey ?? false,
    ctrlKey: mods.ctrlKey ?? false,
    altKey: mods.altKey ?? false,
    shiftKey: mods.shiftKey ?? false,
  };
}

describe('matchWindowShortcut on macOS', () => {
  it('matches Option+Command+G although Option changed the key', () => {
    const e = ev('©', 'KeyG', { altKey: true, metaKey: true });
    expect(matchWindowShortcut(e, 'Alt+Cmd+G', 'macos')).toBe(true);
  });

  it('matches Control+Tab and Control+Shift+Tab as two shortcuts', () => {
    const next = ev('Tab', 'Tab', { ctrlKey: true });
    const prev = ev('Tab', 'Tab', { ctrlKey: true, shiftKey: true });
    expect(matchWindowShortcut(next, 'Ctrl+Tab', 'macos')).toBe(true);
    expect(matchWindowShortcut(next, 'Ctrl+Shift+Tab', 'macos')).toBe(false);
    expect(matchWindowShortcut(prev, 'Ctrl+Shift+Tab', 'macos')).toBe(true);
    expect(matchWindowShortcut(prev, 'Ctrl+Tab', 'macos')).toBe(false);
  });

  it('matches the typed letter on AZERTY, as the editor does', () => {
    // The key labelled A sits at the Q position.
    const a = ev('a', 'KeyQ', { metaKey: true, altKey: true });
    expect(matchWindowShortcut(a, 'Alt+Cmd+A', 'macos')).toBe(true);
    expect(matchWindowShortcut(a, 'Alt+Cmd+Q', 'macos')).toBe(false);
  });

  it('matches an AZERTY Option letter by the position US letter, like the editor', () => {
    // With Option+Command the typed character is replaced; CodeMirror then
    // falls back to the US letter of the key code, and so does this.
    const replaced = ev('œ', 'KeyQ', { metaKey: true, altKey: true });
    expect(matchWindowShortcut(replaced, 'Alt+Cmd+Q', 'macos')).toBe(true);
  });

  it('needs exactly the shortcut modifiers', () => {
    const e = ev('©', 'KeyG', { altKey: true, metaKey: true });
    expect(matchWindowShortcut(e, 'Cmd+G', 'macos')).toBe(false);
    expect(matchWindowShortcut(e, 'Shift+Alt+Cmd+G', 'macos')).toBe(false);
    const withShift = ev('G', 'KeyG', {
      altKey: true,
      metaKey: true,
      shiftKey: true,
    });
    expect(matchWindowShortcut(withShift, 'Alt+Cmd+G', 'macos')).toBe(false);
    expect(matchWindowShortcut(withShift, 'Alt+Shift+Cmd+G', 'macos')).toBe(
      true,
    );
  });

  it('does not use the key code for Option alone, which is typing', () => {
    const typing = ev('©', 'KeyG', { altKey: true });
    expect(matchWindowShortcut(typing, 'Alt+G', 'macos')).toBe(false);
  });

  it('keeps Command apart from Control', () => {
    const cmd = ev('Tab', 'Tab', { metaKey: true });
    expect(matchWindowShortcut(cmd, 'Ctrl+Tab', 'macos')).toBe(false);
    expect(matchWindowShortcut(cmd, 'Cmd+Tab', 'macos')).toBe(true);
  });
});

describe('matchWindowShortcut on Windows', () => {
  it('matches Ctrl+Alt+G by the typed letter', () => {
    const e = ev('g', 'KeyG', { ctrlKey: true, altKey: true });
    expect(matchWindowShortcut(e, 'Ctrl+Alt+G', 'windows')).toBe(true);
    expect(matchWindowShortcut(e, 'Ctrl+G', 'windows')).toBe(false);
  });

  it('takes the typed letter over the position on AZERTY', () => {
    const e = ev('a', 'KeyQ', { ctrlKey: true });
    expect(matchWindowShortcut(e, 'Ctrl+A', 'windows')).toBe(true);
    expect(matchWindowShortcut(e, 'Ctrl+Q', 'windows')).toBe(false);
  });

  it('does not fall back to the key code under Ctrl+Alt, which is AltGr', () => {
    const altGr = ev('æ', 'KeyA', { ctrlKey: true, altKey: true });
    expect(matchWindowShortcut(altGr, 'Ctrl+Alt+A', 'windows')).toBe(false);
  });

  it('matches digits by the number row', () => {
    const e = ev('&', 'Digit1', { ctrlKey: true });
    expect(matchWindowShortcut(e, 'Ctrl+1', 'windows')).toBe(true);
    const shifted = ev('!', 'Digit1', { ctrlKey: true, shiftKey: true });
    expect(matchWindowShortcut(shifted, 'Ctrl+Shift+1', 'windows')).toBe(true);
  });

  it('reads Win as the meta key', () => {
    const e = ev('k', 'KeyK', { metaKey: true });
    expect(matchWindowShortcut(e, 'Win+K', 'windows')).toBe(true);
    expect(matchWindowShortcut(e, 'Ctrl+K', 'windows')).toBe(false);
  });

  it('matches tab switching', () => {
    const next = ev('Tab', 'Tab', { ctrlKey: true });
    const prev = ev('Tab', 'Tab', { ctrlKey: true, shiftKey: true });
    expect(matchWindowShortcut(next, 'Ctrl+Tab', 'windows')).toBe(true);
    expect(matchWindowShortcut(prev, 'Ctrl+Tab', 'windows')).toBe(false);
    expect(matchWindowShortcut(prev, 'Ctrl+Shift+Tab', 'windows')).toBe(true);
  });
});
