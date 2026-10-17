// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { matchMenuAccelerator } from './menuAccelerator';
// The canonical accelerators of the native menu items on Windows.
const TABLE = [
  'Ctrl+Q',
  'Ctrl+,',
  'Ctrl+N',
  'Ctrl+T',
  'Ctrl+O',
  'Ctrl+S',
  'Ctrl+Shift+S',
  'Ctrl+W',
  'Ctrl+F',
  'Ctrl+Alt+F',
  'Ctrl+G',
  'Ctrl+Shift+G',
  'Ctrl+Shift+E',
  'Ctrl+Z',
];

type Mods = Partial<{
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  defaultPrevented: boolean;
  code: string;
  isComposing: boolean;
}>;

function key(
  k: string,
  mods: Mods = {},
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
    ).toBe('Ctrl+S');
    expect(
      matchMenuAccelerator(
        key('б', { ctrlKey: true, code: 'Comma' }),
        'windows',
        TABLE,
      ),
    ).toBe('Ctrl+,');
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
    expect(matchMenuAccelerator(event, 'windows', TABLE)).toBe('Ctrl+S');
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
    ).toBe('Ctrl+S');
  });

  it('distinguishes Ctrl+S from Ctrl+Shift+S', () => {
    expect(
      matchMenuAccelerator(
        key('S', { ctrlKey: true, shiftKey: true }),
        'windows',
        TABLE,
      ),
    ).toBe('Ctrl+Shift+S');
  });

  it('distinguishes Ctrl+F from Ctrl+Alt+F', () => {
    expect(
      matchMenuAccelerator(key('f', { ctrlKey: true }), 'windows', TABLE),
    ).toBe('Ctrl+F');
    expect(
      matchMenuAccelerator(
        key('f', { ctrlKey: true, altKey: true }),
        'windows',
        TABLE,
      ),
    ).toBe('Ctrl+Alt+F');
  });

  it('returns null for a combo not in the table', () => {
    expect(
      matchMenuAccelerator(key('x', { ctrlKey: true }), 'windows', TABLE),
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

  it('does not match when Meta is held alongside Ctrl', () => {
    expect(
      matchMenuAccelerator(
        key('s', { ctrlKey: true, metaKey: true }),
        'windows',
        TABLE,
      ),
    ).toBeNull();
  });

  it('returns null with no modifier held', () => {
    expect(matchMenuAccelerator(key('s'), 'windows', TABLE)).toBeNull();
  });

  it('matches a function key on its own, and a modifier-less key never', () => {
    expect(matchMenuAccelerator(key('F6'), 'windows', ['F6', 'Ctrl+S'])).toBe(
      'F6',
    );
    expect(
      matchMenuAccelerator(key('F6', { shiftKey: true }), 'windows', ['F6']),
    ).toBeNull();
    expect(matchMenuAccelerator(key('Enter'), 'windows', ['Enter'])).toBeNull();
  });

  it('accepts a modifier other than Ctrl, since the key moved', () => {
    expect(
      matchMenuAccelerator(key('j', { altKey: true }), 'windows', ['Alt+J']),
    ).toBe('Alt+J');
    expect(
      matchMenuAccelerator(key('e', { metaKey: true }), 'windows', ['Win+E']),
    ).toBe('Win+E');
  });
});

describe('matchMenuAccelerator key source', () => {
  it('reads the key from key, not code, on a non-US layout', () => {
    expect(
      matchMenuAccelerator(
        key('z', { ctrlKey: true, code: 'KeyW' }),
        'windows',
        ['Ctrl+Z', 'Ctrl+W'],
      ),
    ).toBe('Ctrl+Z');
  });

  it('matches Ctrl+Shift+digit although Shift turns key into a symbol', () => {
    expect(
      matchMenuAccelerator(
        key('!', { ctrlKey: true, shiftKey: true, code: 'Digit1' }),
        'windows',
        ['Ctrl+Shift+1', 'Ctrl+Shift+E'],
      ),
    ).toBe('Ctrl+Shift+1');
  });

  it('matches Ctrl+digit on an AZERTY number row', () => {
    expect(
      matchMenuAccelerator(
        key('&', { ctrlKey: true, code: 'Digit1' }),
        'windows',
        ['Ctrl+1'],
      ),
    ).toBe('Ctrl+1');
  });

  it('takes a typed comma although AZERTY puts it on the M key', () => {
    expect(
      matchMenuAccelerator(
        key(',', { ctrlKey: true, code: 'KeyM' }),
        'windows',
        TABLE,
      ),
    ).toBe('Ctrl+,');
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

describe('matchMenuAccelerator while an IME composes', () => {
  // WebView2 names a composing keydown `Process` and keeps the physical code.
  const composingSave = key('Process', {
    ctrlKey: true,
    code: 'KeyS',
    isComposing: true,
  });

  it('leaves the Save key alone', () => {
    expect(
      matchMenuAccelerator(composingSave, 'windows', TABLE, 'Ctrl+S'),
    ).toBeNull();
  });

  it('still matches the other menu keys', () => {
    expect(
      matchMenuAccelerator(
        key('Process', { ctrlKey: true, code: 'KeyO', isComposing: true }),
        'windows',
        TABLE,
        'Ctrl+S',
      ),
    ).toBe('Ctrl+O');
  });

  it('still saves once the composition is over', () => {
    expect(
      matchMenuAccelerator(
        key('s', { ctrlKey: true }),
        'windows',
        TABLE,
        'Ctrl+S',
      ),
    ).toBe('Ctrl+S');
  });

  it('follows a rebound Save key', () => {
    expect(
      matchMenuAccelerator(composingSave, 'windows', TABLE, 'Ctrl+Alt+S'),
    ).toBe('Ctrl+S');
  });
});
