// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, it, expect } from 'vitest';
import type { KeyLike } from './accelerator';
import { overlayKeyAction } from './overlayKeys';

function key(k: string, mods: Partial<KeyLike> = {}): KeyLike {
  return {
    key: k,
    code: '',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...mods,
  };
}

describe('overlayKeyAction undo and redo', () => {
  it('undoes on Cmd+Z (macOS) and Ctrl+Z (Windows)', () => {
    expect(overlayKeyAction(key('z', { metaKey: true }), 'macos')).toBe('undo');
    expect(overlayKeyAction(key('z', { ctrlKey: true }), 'windows')).toBe(
      'undo',
    );
  });

  it('redoes on Shift+Cmd+Z and on Ctrl+Shift+Z', () => {
    expect(
      overlayKeyAction(key('Z', { metaKey: true, shiftKey: true }), 'macos'),
    ).toBe('redo');
    expect(
      overlayKeyAction(key('Z', { ctrlKey: true, shiftKey: true }), 'windows'),
    ).toBe('redo');
  });

  it('redoes on Ctrl+Y on Windows and Linux', () => {
    expect(overlayKeyAction(key('y', { ctrlKey: true }), 'windows')).toBe(
      'redo',
    );
    expect(overlayKeyAction(key('y', { ctrlKey: true }), 'linux')).toBe('redo');
  });

  it('leaves Cmd+Y and Ctrl+Shift+Y alone', () => {
    expect(overlayKeyAction(key('y', { metaKey: true }), 'macos')).toBeNull();
    expect(
      overlayKeyAction(key('y', { ctrlKey: true, shiftKey: true }), 'windows'),
    ).toBeNull();
    expect(overlayKeyAction(key('y'), 'windows')).toBeNull();
  });
});

describe('overlayKeyAction select all', () => {
  it('selects all on Cmd+A (macOS) and Ctrl+A (Windows)', () => {
    expect(overlayKeyAction(key('a', { metaKey: true }), 'macos')).toBe(
      'select-all',
    );
    expect(overlayKeyAction(key('A', { ctrlKey: true }), 'windows')).toBe(
      'select-all',
    );
  });

  it('ignores the other platform modifier and extra modifiers', () => {
    expect(overlayKeyAction(key('a', { ctrlKey: true }), 'macos')).toBeNull();
    expect(overlayKeyAction(key('a', { metaKey: true }), 'windows')).toBeNull();
    expect(
      overlayKeyAction(key('a', { ctrlKey: true, shiftKey: true }), 'windows'),
    ).toBeNull();
    expect(
      overlayKeyAction(key('a', { ctrlKey: true, altKey: true }), 'windows'),
    ).toBeNull();
    expect(overlayKeyAction(key('a'), 'windows')).toBeNull();
  });
});
