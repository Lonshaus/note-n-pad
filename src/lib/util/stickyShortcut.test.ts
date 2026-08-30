// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { matchStickyShortcut } from './stickyShortcut';
import { guessOsFromUserAgent } from './guessOs';

function key(
  k: string,
  mods: Partial<{
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    metaKey: boolean;
  }> = {},
): {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  key: string;
} {
  return {
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    key: k,
    ...mods,
  };
}

describe('matchStickyShortcut on Linux', () => {
  it('matches bare Ctrl+Q/W/S/F', () => {
    expect(matchStickyShortcut(key('q', { ctrlKey: true }), 'linux')).toBe(
      'quit',
    );
    expect(matchStickyShortcut(key('w', { ctrlKey: true }), 'linux')).toBe(
      'close',
    );
    expect(matchStickyShortcut(key('s', { ctrlKey: true }), 'linux')).toBe(
      'save',
    );
    expect(matchStickyShortcut(key('f', { ctrlKey: true }), 'linux')).toBe(
      'find',
    );
  });

  it('ignores keys with no Ctrl held', () => {
    expect(matchStickyShortcut(key('s'), 'linux')).toBeNull();
  });

  it('does not swallow Ctrl+Shift+S (save-as accelerator)', () => {
    expect(
      matchStickyShortcut(key('S', { ctrlKey: true, shiftKey: true }), 'linux'),
    ).toBeNull();
  });

  it('does not swallow Ctrl+Alt+F (find-replace accelerator)', () => {
    expect(
      matchStickyShortcut(key('f', { ctrlKey: true, altKey: true }), 'linux'),
    ).toBeNull();
  });

  it('does not misfire on AltGr (reported as ctrlKey+altKey)', () => {
    expect(
      matchStickyShortcut(key('w', { ctrlKey: true, altKey: true }), 'linux'),
    ).toBeNull();
  });

  it('ignores Ctrl+Meta combos', () => {
    expect(
      matchStickyShortcut(key('q', { ctrlKey: true, metaKey: true }), 'linux'),
    ).toBeNull();
  });

  it('returns null for an unmapped bare-Ctrl key', () => {
    expect(
      matchStickyShortcut(key('x', { ctrlKey: true }), 'linux'),
    ).toBeNull();
  });
});

describe('matchStickyShortcut on Windows', () => {
  it('matches Ctrl+Q as quit', () => {
    expect(matchStickyShortcut(key('q', { ctrlKey: true }), 'windows')).toBe(
      'quit',
    );
  });

  it('does not match close/save/find (menu accelerators already handle these)', () => {
    expect(
      matchStickyShortcut(key('w', { ctrlKey: true }), 'windows'),
    ).toBeNull();
    expect(
      matchStickyShortcut(key('s', { ctrlKey: true }), 'windows'),
    ).toBeNull();
    expect(
      matchStickyShortcut(key('f', { ctrlKey: true }), 'windows'),
    ).toBeNull();
  });
});

describe('matchStickyShortcut on macOS', () => {
  it('never matches; the system menu bar owns these shortcuts', () => {
    expect(
      matchStickyShortcut(key('q', { ctrlKey: true }), 'macos'),
    ).toBeNull();
    expect(
      matchStickyShortcut(key('w', { ctrlKey: true }), 'macos'),
    ).toBeNull();
  });
});

describe('matchStickyShortcut with an unrecognized/empty os guess', () => {
  it('fails closed: no shortcut fires for any of Ctrl+Q/W/S/F', () => {
    expect(matchStickyShortcut(key('q', { ctrlKey: true }), '')).toBeNull();
    expect(matchStickyShortcut(key('w', { ctrlKey: true }), '')).toBeNull();
    expect(matchStickyShortcut(key('s', { ctrlKey: true }), '')).toBeNull();
    expect(matchStickyShortcut(key('f', { ctrlKey: true }), '')).toBeNull();
  });

  it('end-to-end: an unrecognized UA guesses no shortcuts, not every shortcut', () => {
    // Before the fix, guessOsFromUserAgent fell back to 'linux' for any
    // unrecognized UA — the branch matchStickyShortcut fires all four
    // shortcuts on. This reproduces the real pipeline (guess -> match) to
    // prove the fallback fails closed instead of open.
    const guessedOs = guessOsFromUserAgent('') ?? '';
    expect(
      matchStickyShortcut(key('q', { ctrlKey: true }), guessedOs),
    ).toBeNull();
    expect(
      matchStickyShortcut(key('w', { ctrlKey: true }), guessedOs),
    ).toBeNull();
    expect(
      matchStickyShortcut(key('s', { ctrlKey: true }), guessedOs),
    ).toBeNull();
    expect(
      matchStickyShortcut(key('f', { ctrlKey: true }), guessedOs),
    ).toBeNull();
  });
});
