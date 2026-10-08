// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  isValidRecordedShortcut,
  keyEventToAccelerator,
  formatAccelerator,
  formatAcceleratorSymbols,
} from './accelerator';

/** Build a minimal keydown-like object; the helper only reads these fields. */
function mk(
  key: string,
  mods: Partial<
    Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>
  > = {},
): KeyboardEvent {
  return {
    key,
    metaKey: mods.metaKey ?? false,
    ctrlKey: mods.ctrlKey ?? false,
    altKey: mods.altKey ?? false,
    shiftKey: mods.shiftKey ?? false,
  } as KeyboardEvent;
}

describe('keyEventToAccelerator', () => {
  it('emits modifiers in a fixed order regardless of press order', () => {
    expect(
      keyEventToAccelerator(
        mk('a', { shiftKey: true, altKey: true, ctrlKey: true }),
      ),
    ).toBe('CmdOrCtrl+Alt+Shift+A');
  });

  it('folds meta and ctrl into a single CmdOrCtrl token', () => {
    expect(keyEventToAccelerator(mk('n', { metaKey: true }))).toBe(
      'CmdOrCtrl+N',
    );
    expect(keyEventToAccelerator(mk('n', { ctrlKey: true }))).toBe(
      'CmdOrCtrl+N',
    );
  });

  it('uppercases letters and passes digits through', () => {
    expect(keyEventToAccelerator(mk('k', { metaKey: true }))).toBe(
      'CmdOrCtrl+K',
    );
    expect(keyEventToAccelerator(mk('5', { metaKey: true }))).toBe(
      'CmdOrCtrl+5',
    );
  });

  it('keeps function keys and normalizes arrows', () => {
    expect(keyEventToAccelerator(mk('F4', { altKey: true }))).toBe('Alt+F4');
    expect(keyEventToAccelerator(mk('ArrowUp', { metaKey: true }))).toBe(
      'CmdOrCtrl+Up',
    );
    expect(keyEventToAccelerator(mk('ArrowRight', { ctrlKey: true }))).toBe(
      'CmdOrCtrl+Right',
    );
  });

  it('handles space and comma tokens', () => {
    expect(keyEventToAccelerator(mk(' ', { ctrlKey: true }))).toBe(
      'CmdOrCtrl+Space',
    );
    expect(keyEventToAccelerator(mk(',', { metaKey: true }))).toBe(
      'CmdOrCtrl+,',
    );
  });

  it('rejects bare modifier presses', () => {
    expect(keyEventToAccelerator(mk('Shift', { shiftKey: true }))).toBeNull();
    expect(keyEventToAccelerator(mk('Meta', { metaKey: true }))).toBeNull();
    expect(keyEventToAccelerator(mk('Control', { ctrlKey: true }))).toBeNull();
    expect(keyEventToAccelerator(mk('Alt', { altKey: true }))).toBeNull();
  });

  it('rejects unknown keys', () => {
    expect(keyEventToAccelerator(mk('Dead', { metaKey: true }))).toBeNull();
  });
});
/** A keydown with a physical `code`, for the platform-aware paths. */
function mkCode(
  key: string,
  code: string,
  mods: Partial<
    Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>
  > = {},
): KeyboardEvent {
  return { ...mk(key, mods), code } as KeyboardEvent;
}

describe('keyEventToAccelerator platform paths', () => {
  it('macOS reads the key from code when Option substitutes the character', () => {
    expect(
      keyEventToAccelerator(mkCode('∆', 'KeyJ', { altKey: true }), 'macos'),
    ).toBe('Alt+J');
  });

  it('macOS records a dead key from code', () => {
    expect(
      keyEventToAccelerator(mkCode('Dead', 'KeyE', { altKey: true }), 'macos'),
    ).toBe('Alt+E');
  });

  it('macOS keeps Control distinct from Command', () => {
    expect(
      keyEventToAccelerator(
        mkCode('j', 'KeyJ', { ctrlKey: true, altKey: true }),
        'macos',
      ),
    ).toBe('Ctrl+Alt+J');
    expect(
      keyEventToAccelerator(
        mkCode('j', 'KeyJ', { metaKey: true, altKey: true }),
        'macos',
      ),
    ).toBe('CmdOrCtrl+Alt+J');
    expect(
      keyEventToAccelerator(
        mkCode('j', 'KeyJ', { metaKey: true, ctrlKey: true }),
        'macos',
      ),
    ).toBe('CmdOrCtrl+Ctrl+J');
  });

  it('macOS maps digit and punctuation codes', () => {
    expect(
      keyEventToAccelerator(mkCode('¡', 'Digit1', { altKey: true }), 'macos'),
    ).toBe('Alt+1');
    expect(
      keyEventToAccelerator(mkCode('≤', 'Comma', { altKey: true }), 'macos'),
    ).toBe('Alt+,');
  });

  it('macOS still takes non-character keys from key', () => {
    expect(
      keyEventToAccelerator(mkCode('F5', 'F5', { metaKey: true }), 'macos'),
    ).toBe('CmdOrCtrl+F5');
  });

  it('macOS ignores a bare modifier press', () => {
    expect(
      keyEventToAccelerator(
        mkCode('Alt', 'AltLeft', { altKey: true }),
        'macos',
      ),
    ).toBeNull();
  });

  it('Windows serializes Ctrl as CmdOrCtrl', () => {
    expect(
      keyEventToAccelerator(
        mkCode('j', 'KeyJ', { ctrlKey: true, altKey: true }),
        'windows',
      ),
    ).toBe('CmdOrCtrl+Alt+J');
  });

  it('Windows takes the key from key, not code (AZERTY)', () => {
    expect(
      keyEventToAccelerator(
        mkCode('a', 'KeyQ', { ctrlKey: true, altKey: true }),
        'windows',
      ),
    ).toBe('CmdOrCtrl+Alt+A');
  });
});

describe('isValidRecordedShortcut', () => {
  it('accepts Command, Control or Alt combos', () => {
    for (const a of [
      'CmdOrCtrl+N',
      'Ctrl+Alt+J',
      'Alt+J',
      'CmdOrCtrl+Shift+N',
    ]) {
      expect(isValidRecordedShortcut(a), a).toBe(true);
    }
  });

  it('accepts a bare F1-F24 only', () => {
    expect(isValidRecordedShortcut('F1')).toBe(true);
    expect(isValidRecordedShortcut('F24')).toBe(true);
    expect(isValidRecordedShortcut('F25')).toBe(false);
    expect(isValidRecordedShortcut('Shift+F5')).toBe(false);
  });

  it('rejects Shift-only and unmodified keys', () => {
    for (const a of ['Shift+N', 'N', 'Enter', 'Shift+Enter', 'Space']) {
      expect(isValidRecordedShortcut(a), a).toBe(false);
    }
  });
});

describe('formatAccelerator', () => {
  it('renders CmdOrCtrl as Cmd on macOS', () => {
    expect(formatAccelerator('CmdOrCtrl+Shift+N', true)).toBe('Cmd+Shift+N');
  });

  it('renders CmdOrCtrl as Ctrl off macOS', () => {
    expect(formatAccelerator('CmdOrCtrl+Shift+N', false)).toBe('Ctrl+Shift+N');
  });

  it('never leaks the raw CmdOrCtrl token', () => {
    expect(formatAccelerator('CmdOrCtrl+,', true)).not.toContain('CmdOrCtrl');
    expect(formatAccelerator('CmdOrCtrl+,', false)).not.toContain('CmdOrCtrl');
  });

  it('passes other modifiers and the key through unchanged', () => {
    expect(formatAccelerator('Alt+F4', false)).toBe('Alt+F4');
    expect(formatAccelerator('CmdOrCtrl+Alt+Up', false)).toBe('Ctrl+Alt+Up');
  });
});

describe('formatAcceleratorSymbols', () => {
  it('renders macOS glyphs with no separator', () => {
    expect(formatAcceleratorSymbols('CmdOrCtrl+Q', true)).toBe('⌘Q');
    expect(formatAcceleratorSymbols('CmdOrCtrl+Shift+S', true)).toBe('⇧⌘S');
    expect(formatAcceleratorSymbols('CmdOrCtrl+Alt+F', true)).toBe('⌥⌘F');
  });

  it('renders modifiers in fixed mac order regardless of input order', () => {
    // The accelerator itself always lists CmdOrCtrl before Alt/Shift, but the
    // mac-native display order is Option, Shift, then Command.
    expect(formatAcceleratorSymbols('CmdOrCtrl+Shift+G', true)).toBe('⇧⌘G');
  });

  it('renders Ctrl/Alt/Shift chained with + off macOS', () => {
    expect(formatAcceleratorSymbols('CmdOrCtrl+Q', false)).toBe('Ctrl+Q');
    expect(formatAcceleratorSymbols('CmdOrCtrl+Shift+S', false)).toBe(
      'Ctrl+Shift+S',
    );
    expect(formatAcceleratorSymbols('CmdOrCtrl+Alt+F', false)).toBe(
      'Ctrl+Alt+F',
    );
  });

  it('passes a punctuation key through unchanged on both platforms', () => {
    expect(formatAcceleratorSymbols('CmdOrCtrl+,', true)).toBe('⌘,');
    expect(formatAcceleratorSymbols('CmdOrCtrl+,', false)).toBe('Ctrl+,');
  });

  it('never leaks the raw CmdOrCtrl token', () => {
    expect(formatAcceleratorSymbols('CmdOrCtrl+Q', true)).not.toContain(
      'CmdOrCtrl',
    );
    expect(formatAcceleratorSymbols('CmdOrCtrl+Q', false)).not.toContain(
      'CmdOrCtrl',
    );
  });

  it('renders a literal Ctrl modifier as its own mac glyph, not CmdOrCtrl’s', () => {
    expect(formatAcceleratorSymbols('Ctrl+X', true)).toBe('⌃X');
    expect(formatAcceleratorSymbols('Ctrl+X', false)).toBe('Ctrl+X');
  });

  it('renders the literal-Ctrl tab-cycling shortcuts (not CmdOrCtrl)', () => {
    expect(formatAcceleratorSymbols('Ctrl+Tab', true)).toBe('⌃Tab');
    expect(formatAcceleratorSymbols('Ctrl+Tab', false)).toBe('Ctrl+Tab');
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
    expect(formatAcceleratorSymbols('CmdOrCtrl++', true)).toBe('⌘+');
    expect(formatAcceleratorSymbols('CmdOrCtrl++', false)).toBe('Ctrl++');
  });
});
