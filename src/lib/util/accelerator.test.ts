// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  eventKeyName,
  formatAccelerator,
  formatAcceleratorSymbols,
  recordAccelerator,
  type KeyLike,
  type RecordResult,
  type ShortcutScope,
} from './accelerator';
import { matchWindowShortcut } from './windowShortcut';
/** A keydown-like object; the recorder only reads these fields. */
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
/** Mark `e` as part of an IME composition. */
function composing(e: KeyLike): KeyLike {
  return { ...e, isComposing: true };
}
/** Record `e` and count how often the layout was asked. */
async function record(
  e: KeyLike,
  os: string,
  scope: ShortcutScope,
  layout: Record<string, string | null> = {},
): Promise<{ result: RecordResult; asked: string[] }> {
  const asked: string[] = [];
  const result = await recordAccelerator(e, {
    os,
    scope,
    layoutChar: (code) => {
      asked.push(code);
      return Promise.resolve(layout[code] ?? null);
    },
  });
  return { result, asked };
}

async function accelOf(
  e: KeyLike,
  os: string,
  scope: ShortcutScope,
  layout: Record<string, string | null> = {},
): Promise<string | null> {
  const { result } = await record(e, os, scope, layout);
  return result.status === 'ok' ? result.accel : null;
}

async function reasonOf(
  e: KeyLike,
  os: string,
  scope: ShortcutScope,
  layout: Record<string, string | null> = {},
): Promise<string | null> {
  const { result } = await record(e, os, scope, layout);
  return result.status === 'rejected' ? result.reason : null;
}

describe('recordAccelerator on macOS', () => {
  it('names a menu or editor shortcut by the typed letter (AZERTY)', async () => {
    const azertyA = ev('a', 'KeyQ', { metaKey: true });
    expect(await accelOf(azertyA, 'macos', 'menu')).toBe('Cmd+A');
    expect(await accelOf(azertyA, 'macos', 'editor')).toBe('Cmd+A');
    expect(await accelOf(azertyA, 'macos', 'window')).toBe('Cmd+A');
  });

  it('names a global shortcut by the physical key', async () => {
    const azertyA = ev('a', 'KeyQ', { metaKey: true });
    expect(await accelOf(azertyA, 'macos', 'global')).toBe('Cmd+Q');
  });

  it('asks the layout for the letter when Option replaced it', async () => {
    const { result, asked } = await record(
      ev('∆', 'KeyJ', { metaKey: true, altKey: true }),
      'macos',
      'menu',
      { KeyJ: 'j' },
    );
    expect(result).toEqual({ status: 'ok', accel: 'Alt+Cmd+J' });
    expect(asked).toEqual(['KeyJ']);
  });

  it('records the letter on the key, not the position, when asking (AZERTY)', async () => {
    // The key labelled A sits at the Q position on AZERTY.
    expect(
      await accelOf(
        ev('œ', 'KeyQ', { metaKey: true, altKey: true }),
        'macos',
        'editor',
        { KeyQ: 'a' },
      ),
    ).toBe('Alt+Cmd+A');
  });

  it('treats a dead key like a replaced character', async () => {
    expect(
      await accelOf(
        ev('Dead', 'KeyE', { ctrlKey: true, altKey: true }),
        'macos',
        'menu',
        { KeyE: 'e' },
      ),
    ).toBe('Ctrl+Alt+E');
  });

  it('refuses the recording when the layout has no letter there', async () => {
    const e = ev('ы', 'KeyS', { metaKey: true, altKey: true });
    expect(await reasonOf(e, 'macos', 'menu', { KeyS: null })).toBe(
      'no-layout-char',
    );
    expect(await reasonOf(e, 'macos', 'menu')).toBe('no-layout-char');
  });

  it('refuses the recording when the lookup itself fails', async () => {
    const result = await recordAccelerator(
      ev('∆', 'KeyJ', { metaKey: true, altKey: true }),
      {
        os: 'macos',
        scope: 'menu',
        layoutChar: () => Promise.reject(new Error('no ipc')),
      },
    );
    expect(result).toEqual({ status: 'rejected', reason: 'no-layout-char' });
  });

  it('does not ask the layout when the key already typed a letter', async () => {
    const { asked } = await record(
      ev('k', 'KeyK', { metaKey: true }),
      'macos',
      'menu',
    );
    expect(asked).toEqual([]);
    const global = await record(
      ev('∆', 'KeyJ', { metaKey: true, altKey: true }),
      'macos',
      'global',
    );
    expect(global.asked).toEqual([]);
    expect(global.result).toEqual({ status: 'ok', accel: 'Alt+Cmd+J' });
  });

  it('keeps Control apart from Command and orders modifiers fixedly', async () => {
    expect(
      await accelOf(
        ev('j', 'KeyJ', { ctrlKey: true, altKey: true }),
        'macos',
        'menu',
      ),
    ).toBe('Ctrl+Alt+J');
    expect(
      await accelOf(
        ev('J', 'KeyJ', {
          metaKey: true,
          shiftKey: true,
          altKey: true,
          ctrlKey: true,
        }),
        'macos',
        'menu',
      ),
    ).toBe('Ctrl+Alt+Shift+Cmd+J');
    expect(
      await accelOf(
        ev('Tab', 'Tab', { ctrlKey: true, shiftKey: true }),
        'macos',
        'window',
      ),
    ).toBe('Ctrl+Shift+Tab');
  });

  it('refuses Option(+Shift)+character in the editor scope only', async () => {
    const optionJ = ev('∆', 'KeyJ', { altKey: true });
    const layout = { KeyJ: 'j' };
    expect(await reasonOf(optionJ, 'macos', 'editor', layout)).toBe(
      'mac-option',
    );
    expect(
      await reasonOf(
        ev('Ô', 'KeyJ', { altKey: true, shiftKey: true }),
        'macos',
        'editor',
        layout,
      ),
    ).toBe('mac-option');
    expect(
      await reasonOf(ev(' ', 'Space', { altKey: true }), 'macos', 'editor'),
    ).toBe('mac-option');
    expect(await accelOf(optionJ, 'macos', 'menu', layout)).toBe('Alt+J');
    expect(await accelOf(optionJ, 'macos', 'global', layout)).toBe('Alt+J');
    expect(await accelOf(optionJ, 'windows', 'editor', layout)).toBe('Alt+J');
  });

  it('refuses Ctrl+Alt+Shift+digit in the editor scope off macOS', async () => {
    const e = ev('!', 'Digit1', {
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
    });
    for (const os of ['windows', 'linux']) {
      expect(await reasonOf(e, os, 'editor'), os).toBe('unreachable');
      expect(await accelOf(e, os, 'menu'), os).toBe('Ctrl+Alt+Shift+1');
      expect(await accelOf(e, os, 'window'), os).toBe('Ctrl+Alt+Shift+1');
      expect(await accelOf(e, os, 'global'), os).toBe('Ctrl+Alt+Shift+1');
    }
    expect(await accelOf(e, 'macos', 'editor')).toBe('Ctrl+Alt+Shift+1');
    expect(
      await accelOf(
        ev('1', 'Digit1', { ctrlKey: true, altKey: true }),
        'windows',
        'editor',
      ),
    ).toBe('Ctrl+Alt+1');
    expect(
      await accelOf(
        ev('F5', 'F5', { ctrlKey: true, altKey: true, shiftKey: true }),
        'windows',
        'editor',
      ),
    ).toBe('Ctrl+Alt+Shift+F5');
  });

  it('lets Option through with a non-character key or another modifier', async () => {
    expect(
      await accelOf(
        ev('ArrowUp', 'ArrowUp', { altKey: true }),
        'macos',
        'editor',
      ),
    ).toBe('Alt+ArrowUp');
    expect(
      await accelOf(ev('F5', 'F5', { altKey: true }), 'macos', 'editor'),
    ).toBe('Alt+F5');
    expect(
      await accelOf(
        ev('©', 'KeyG', { altKey: true, metaKey: true }),
        'macos',
        'editor',
        { KeyG: 'g' },
      ),
    ).toBe('Alt+Cmd+G');
  });

  it('takes digits from the number row', async () => {
    expect(
      await accelOf(ev('¡', 'Digit1', { altKey: true }), 'macos', 'menu'),
    ).toBe('Alt+1');
    expect(
      await accelOf(
        ev('!', 'Digit1', { metaKey: true, shiftKey: true }),
        'macos',
        'editor',
      ),
    ).toBe('Shift+Cmd+1');
  });
});

describe('recordAccelerator on Windows', () => {
  it('takes the letter from key, not from the position (AZERTY)', async () => {
    const e = ev('a', 'KeyQ', { ctrlKey: true, altKey: true });
    for (const scope of ['global', 'menu', 'window', 'editor'] as const) {
      expect(await accelOf(e, 'windows', scope), scope).toBe('Ctrl+Alt+A');
    }
  });

  it('takes digits from code: AZERTY number row without Shift', async () => {
    expect(
      await accelOf(ev('&', 'Digit1', { ctrlKey: true }), 'windows', 'menu'),
    ).toBe('Ctrl+1');
  });

  it('takes digits from code: Shift turns key into a symbol', async () => {
    expect(
      await accelOf(
        ev('!', 'Digit1', { ctrlKey: true, shiftKey: true }),
        'windows',
        'menu',
      ),
    ).toBe('Ctrl+Shift+1');
  });

  it('falls back to the physical letter on a non-Latin layout', async () => {
    expect(
      await accelOf(ev('ы', 'KeyS', { ctrlKey: true }), 'windows', 'menu'),
    ).toBe('Ctrl+S');
  });

  it('writes the Windows key as Win', async () => {
    expect(
      await accelOf(ev('e', 'KeyE', { metaKey: true }), 'windows', 'global'),
    ).toBe('Win+E');
  });

  it('never asks the layout', async () => {
    const { asked } = await record(
      ev('ы', 'KeyS', { ctrlKey: true }),
      'windows',
      'menu',
    );
    expect(asked).toEqual([]);
  });
});

describe('recordAccelerator on any platform', () => {
  it('refuses punctuation keys, whatever they type', async () => {
    // JIS: the key at BracketLeft types '@'.
    for (const os of ['macos', 'windows']) {
      for (const scope of ['global', 'menu', 'editor'] as const) {
        const e = ev('@', 'BracketLeft', { ctrlKey: true });
        expect(await reasonOf(e, os, scope), `${os} ${scope}`).toBe(
          'punctuation',
        );
      }
    }
    expect(
      await reasonOf(ev(',', 'Comma', { metaKey: true }), 'macos', 'menu'),
    ).toBe('punctuation');
    expect(
      await reasonOf(ev('¥', 'IntlYen', { ctrlKey: true }), 'windows', 'menu'),
    ).toBe('punctuation');
    // A character the format has no name for is punctuation too, even from a
    // key that is not on the US punctuation list.
    expect(
      await reasonOf(
        ev('+', 'NumpadAdd', { ctrlKey: true }),
        'windows',
        'menu',
      ),
    ).toBe('punctuation');
  });

  it('refuses keys it has no name for', async () => {
    expect(
      await reasonOf(ev('1', 'Numpad1', { ctrlKey: true }), 'windows', 'menu'),
    ).toBe('unsupported-key');
    expect(
      await reasonOf(
        ev('Insert', 'Insert', { ctrlKey: true }),
        'windows',
        'menu',
      ),
    ).toBe('unsupported-key');
  });

  it('waits through a bare modifier press', async () => {
    for (const key of ['Shift', 'Control', 'Alt', 'Meta']) {
      expect(
        (await record(ev(key, `${key}Left`), 'macos', 'menu')).result,
      ).toEqual({ status: 'ignore' });
    }
  });

  it('needs Command, Control or Option, except for a bare F key', async () => {
    expect(await reasonOf(ev('n', 'KeyN'), 'windows', 'menu')).toBe(
      'needs-modifier',
    );
    expect(
      await reasonOf(ev('N', 'KeyN', { shiftKey: true }), 'windows', 'menu'),
    ).toBe('needs-modifier');
    expect(
      await reasonOf(ev('F5', 'F5', { shiftKey: true }), 'windows', 'menu'),
    ).toBe('needs-modifier');
    expect(await reasonOf(ev('Enter', 'Enter'), 'macos', 'menu')).toBe(
      'needs-modifier',
    );
    expect(await accelOf(ev('F5', 'F5'), 'windows', 'menu')).toBe('F5');
    expect(await accelOf(ev('F24', 'F24'), 'macos', 'global')).toBe('F24');
  });

  it('names arrows, space and the named keys the way the registry does', async () => {
    expect(
      await accelOf(
        ev('ArrowRight', 'ArrowRight', { ctrlKey: true }),
        'windows',
        'menu',
      ),
    ).toBe('Ctrl+ArrowRight');
    expect(
      await accelOf(ev(' ', 'Space', { ctrlKey: true }), 'windows', 'editor'),
    ).toBe('Ctrl+Space');
    expect(
      await accelOf(ev('Enter', 'Enter', { metaKey: true }), 'macos', 'editor'),
    ).toBe('Cmd+Enter');
    expect(
      await accelOf(
        ev('Delete', 'Delete', { ctrlKey: true }),
        'windows',
        'menu',
      ),
    ).toBe('Ctrl+Delete');
  });
});

describe('eventKeyName', () => {
  it('prefers the typed letter and falls back to the physical key', () => {
    expect(eventKeyName(ev('z', 'KeyW'))).toBe('Z');
    expect(eventKeyName(ev('ы', 'KeyS'))).toBe('S');
    expect(eventKeyName(ev('ы', 'KeyS'), false)).toBeNull();
  });

  it('takes digits from the number row and typed punctuation as typed', () => {
    expect(eventKeyName(ev('&', 'Digit1'))).toBe('1');
    expect(eventKeyName(ev('!', 'Digit1'))).toBe('1');
    // AZERTY types a comma on the M key.
    expect(eventKeyName(ev(',', 'KeyM'))).toBe(',');
    expect(eventKeyName(ev('б', 'Comma'))).toBe(',');
  });
});

describe('named keys under a layout that rewrites Option+Esc', () => {
  // macOS Zhuyin types U+200D for Option+Esc and U+200C for Option+Shift+Esc.
  it('names the key by its physical code', () => {
    expect(eventKeyName(ev('\u200D', 'Escape', { altKey: true }))).toBe(
      'Escape',
    );
    expect(
      eventKeyName(ev('\u200C', 'Escape', { altKey: true, shiftKey: true })),
    ).toBe('Escape');
    expect(eventKeyName(ev('\u200D', 'Escape', { altKey: true }), false)).toBe(
      'Escape',
    );
    expect(eventKeyName(ev('Escape', 'Escape'))).toBe('Escape');
    expect(eventKeyName(ev('\u200D', 'F5'), false)).toBe('F5');
  });

  it('records Option+Esc as Alt+Escape', async () => {
    const e = ev('\u200D', 'Escape', { altKey: true });
    for (const scope of ['menu', 'editor'] as const) {
      expect(await accelOf(e, 'macos', scope), scope).toBe('Alt+Escape');
    }
    expect(
      await accelOf(
        ev('\u200C', 'Escape', { altKey: true, shiftKey: true }),
        'macos',
        'editor',
      ),
    ).toBe('Alt+Shift+Escape');
    expect(
      await accelOf(
        ev('Escape', 'Escape', { altKey: true }),
        'macos',
        'editor',
      ),
    ).toBe('Alt+Escape');
  });

  it('leaves the letter-key rules alone', async () => {
    expect(
      await reasonOf(ev('ы', 'KeyS', { metaKey: true }), 'macos', 'menu'),
    ).toBe('no-layout-char');
    expect(
      await accelOf(ev('ы', 'KeyS', { ctrlKey: true }), 'windows', 'editor'),
    ).toBe('Ctrl+S');
    expect(
      await reasonOf(ev('\u200D', 'Comma', { altKey: true }), 'macos', 'menu'),
    ).toBe('punctuation');
  });
});

describe('keys during an IME composition', () => {
  it('does not name a Process key by its physical code', () => {
    expect(eventKeyName(ev('Process', 'Tab', { ctrlKey: true }))).toBeNull();
    expect(
      eventKeyName(composing(ev('\u200D', 'Escape', { altKey: true }))),
    ).toBeNull();
  });

  it('still names a real named key and keeps the older fallbacks', () => {
    expect(eventKeyName(composing(ev('Tab', 'Tab', { ctrlKey: true })))).toBe(
      'Tab',
    );
    expect(eventKeyName(ev('Process', 'KeyS', { ctrlKey: true }))).toBe('S');
  });

  it('keeps the Option+Esc fix outside a composition', () => {
    expect(eventKeyName(ev('\u200D', 'Escape', { altKey: true }))).toBe(
      'Escape',
    );
  });

  it('does not record a Process key as a named key', async () => {
    const e = ev('Process', 'Escape', { altKey: true });
    expect(await accelOf(e, 'macos', 'editor')).toBeNull();
    expect(await accelOf(e, 'windows', 'editor')).toBeNull();
    expect(
      await accelOf(
        composing(ev('\u200D', 'Escape', { altKey: true })),
        'macos',
        'editor',
      ),
    ).toBeNull();
  });
});

describe('next-tab shortcut during an IME composition', () => {
  it('does not match next-tab on a Process key', () => {
    const e = ev('Process', 'Tab', { ctrlKey: true });
    expect(matchWindowShortcut(e, 'Ctrl+Tab', 'windows')).toBe(false);
  });
});

describe('formatAccelerator', () => {
  it('renders the legacy CmdOrCtrl as Cmd on macOS', () => {
    expect(formatAccelerator('CmdOrCtrl+Shift+N', true)).toBe('Cmd+Shift+N');
  });

  it('renders the legacy CmdOrCtrl as Ctrl off macOS', () => {
    expect(formatAccelerator('CmdOrCtrl+Shift+N', false)).toBe('Ctrl+Shift+N');
  });

  it('never leaks the raw CmdOrCtrl token', () => {
    expect(formatAccelerator('CmdOrCtrl+,', true)).not.toContain('CmdOrCtrl');
    expect(formatAccelerator('CmdOrCtrl+,', false)).not.toContain('CmdOrCtrl');
  });

  it('passes canonical modifiers and the key through unchanged', () => {
    expect(formatAccelerator('Alt+F4', false)).toBe('Alt+F4');
    expect(formatAccelerator('Ctrl+Alt+ArrowUp', false)).toBe(
      'Ctrl+Alt+ArrowUp',
    );
    expect(formatAccelerator('Shift+Cmd+N', true)).toBe('Shift+Cmd+N');
  });
});

describe('formatAcceleratorSymbols', () => {
  it('renders canonical macOS shortcuts as glyphs with no separator', () => {
    expect(formatAcceleratorSymbols('Cmd+Q', true)).toBe('⌘Q');
    expect(formatAcceleratorSymbols('Shift+Cmd+S', true)).toBe('⇧⌘S');
    expect(formatAcceleratorSymbols('Alt+Cmd+F', true)).toBe('⌥⌘F');
  });

  it('renders modifiers in the fixed mac order whatever the input order', () => {
    expect(formatAcceleratorSymbols('Cmd+Shift+G', true)).toBe('⇧⌘G');
    expect(formatAcceleratorSymbols('Ctrl+Alt+Shift+Cmd+J', true)).toBe(
      '⌃⌥⇧⌘J',
    );
  });

  it('renders canonical Windows shortcuts chained with +', () => {
    expect(formatAcceleratorSymbols('Ctrl+Q', false)).toBe('Ctrl+Q');
    expect(formatAcceleratorSymbols('Ctrl+Shift+S', false)).toBe(
      'Ctrl+Shift+S',
    );
    expect(formatAcceleratorSymbols('Ctrl+Alt+Win+F', false)).toBe(
      'Ctrl+Alt+Win+F',
    );
  });

  it('still reads the legacy CmdOrCtrl spelling', () => {
    expect(formatAcceleratorSymbols('CmdOrCtrl+Q', true)).toBe('⌘Q');
    expect(formatAcceleratorSymbols('CmdOrCtrl+Shift+S', true)).toBe('⇧⌘S');
    expect(formatAcceleratorSymbols('CmdOrCtrl+Alt+F', false)).toBe(
      'Ctrl+Alt+F',
    );
    expect(formatAcceleratorSymbols('CmdOrCtrl+Q', true)).not.toContain(
      'CmdOrCtrl',
    );
    expect(formatAcceleratorSymbols('CmdOrCtrl+Q', false)).not.toContain(
      'CmdOrCtrl',
    );
  });

  it('passes a punctuation key through unchanged on both platforms', () => {
    expect(formatAcceleratorSymbols('Cmd+,', true)).toBe('⌘,');
    expect(formatAcceleratorSymbols('Ctrl+,', false)).toBe('Ctrl+,');
  });

  it('renders a literal Ctrl modifier as its own mac glyph', () => {
    expect(formatAcceleratorSymbols('Ctrl+X', true)).toBe('⌃X');
    expect(formatAcceleratorSymbols('Ctrl+Tab', true)).toBe('⌃Tab');
    expect(formatAcceleratorSymbols('Ctrl+Shift+Tab', true)).toBe('⌃⇧Tab');
    expect(formatAcceleratorSymbols('Ctrl+Shift+Tab', false)).toBe(
      'Ctrl+Shift+Tab',
    );
  });

  it('preserves a modifier this app does not itself emit, rather than dropping it', () => {
    expect(formatAcceleratorSymbols('Meta+X', true)).toBe('MetaX');
    expect(formatAcceleratorSymbols('Meta+X', false)).toBe('Meta+X');
  });

  it('keeps a literal + key token instead of losing it to the separator split', () => {
    expect(formatAcceleratorSymbols('Cmd++', true)).toBe('⌘+');
    expect(formatAcceleratorSymbols('Ctrl++', false)).toBe('Ctrl++');
  });
});
