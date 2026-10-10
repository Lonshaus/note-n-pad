// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { matchMenuAccelerator } from './menuAccelerator';

const TABLE = [
  'CmdOrCtrl+Q',
  'CmdOrCtrl+,',
  'CmdOrCtrl+N',
  'CmdOrCtrl+T',
  'CmdOrCtrl+O',
  'CmdOrCtrl+S',
  'CmdOrCtrl+Shift+S',
  'CmdOrCtrl+W',
  'CmdOrCtrl+F',
  'CmdOrCtrl+Alt+F',
  'CmdOrCtrl+G',
  'CmdOrCtrl+Shift+G',
  'CmdOrCtrl+Shift+E',
];

function key(
  k: string,
  mods: Partial<{
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    metaKey: boolean;
    defaultPrevented: boolean;
    code: string;
  }> = {},
): {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  defaultPrevented: boolean;
  key: string;
  code: string;
} {
  return {
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    defaultPrevented: false,
    key: k,
    code: '',
    ...mods,
  };
}

describe('matchMenuAccelerator on Windows', () => {
  it('matches by physical key on a non-Latin layout', () => {
    expect(
      matchMenuAccelerator(
        key('ы', { ctrlKey: true, code: 'KeyS' }),
        'windows',
        TABLE,
      ),
    ).toBe('CmdOrCtrl+S');
    expect(
      matchMenuAccelerator(
        key('б', { ctrlKey: true, code: 'Comma' }),
        'windows',
        TABLE,
      ),
    ).toBe('CmdOrCtrl+,');
  });

  it('keeps the modifiers of an event whose fields are prototype getters', () => {
    // Real DOM events expose their fields as getters, not own properties.
    const proto = {
      get ctrlKey(): boolean {
        return true;
      },
      get shiftKey(): boolean {
        return false;
      },
      get altKey(): boolean {
        return false;
      },
      get metaKey(): boolean {
        return false;
      },
      get defaultPrevented(): boolean {
        return false;
      },
      get key(): string {
        return 'ы';
      },
      get code(): string {
        return 'KeyS';
      },
    };
    const event = Object.create(proto) as ReturnType<typeof key>;
    expect(matchMenuAccelerator(event, 'windows', TABLE)).toBe('CmdOrCtrl+S');
  });

  it('prefers the typed Latin letter over its physical position', () => {
    // AZERTY: the key at KeyQ types 'a'; Ctrl+A is not a table combo.
    expect(
      matchMenuAccelerator(
        key('a', { ctrlKey: true, code: 'KeyQ' }),
        'windows',
        TABLE,
      ),
    ).toBeNull();
  });

  it('matches a plain table combo', () => {
    expect(
      matchMenuAccelerator(key('s', { ctrlKey: true }), 'windows', TABLE),
    ).toBe('CmdOrCtrl+S');
  });

  it('distinguishes Ctrl+S from Ctrl+Shift+S', () => {
    expect(
      matchMenuAccelerator(
        key('S', { ctrlKey: true, shiftKey: true }),
        'windows',
        TABLE,
      ),
    ).toBe('CmdOrCtrl+Shift+S');
  });

  it('distinguishes Ctrl+F from Ctrl+Alt+F', () => {
    expect(
      matchMenuAccelerator(key('f', { ctrlKey: true }), 'windows', TABLE),
    ).toBe('CmdOrCtrl+F');
    expect(
      matchMenuAccelerator(
        key('f', { ctrlKey: true, altKey: true }),
        'windows',
        TABLE,
      ),
    ).toBe('CmdOrCtrl+Alt+F');
  });

  it('returns null for a combo not in the table', () => {
    expect(
      matchMenuAccelerator(key('z', { ctrlKey: true }), 'windows', TABLE),
    ).toBeNull();
  });

  it('returns null when the event was already handled', () => {
    expect(
      matchMenuAccelerator(
        key('s', { ctrlKey: true, defaultPrevented: true }),
        'windows',
        TABLE,
      ),
    ).toBeNull();
  });

  it('returns null when Meta is held instead of/alongside Ctrl', () => {
    expect(
      matchMenuAccelerator(
        key('s', { ctrlKey: true, metaKey: true }),
        'windows',
        TABLE,
      ),
    ).toBeNull();
  });

  it('returns null with no Ctrl held', () => {
    expect(matchMenuAccelerator(key('s'), 'windows', TABLE)).toBeNull();
  });
});

describe('matchMenuAccelerator key source', () => {
  it('reads the key from key, not code, on a non-US layout', () => {
    expect(
      matchMenuAccelerator(
        key('z', { ctrlKey: true, code: 'KeyW' }),
        'windows',
        ['CmdOrCtrl+Z', 'CmdOrCtrl+W'],
      ),
    ).toBe('CmdOrCtrl+Z');
  });
});

describe('matchMenuAccelerator off Windows', () => {
  it('never matches on macOS', () => {
    expect(
      matchMenuAccelerator(key('s', { ctrlKey: true }), 'macos', TABLE),
    ).toBeNull();
  });

  it('never matches on Linux', () => {
    expect(
      matchMenuAccelerator(key('s', { ctrlKey: true }), 'linux', TABLE),
    ).toBeNull();
  });

  it('never matches with an unrecognized os guess', () => {
    expect(
      matchMenuAccelerator(key('s', { ctrlKey: true }), '', TABLE),
    ).toBeNull();
  });
});
