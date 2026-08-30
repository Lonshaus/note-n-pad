// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
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
