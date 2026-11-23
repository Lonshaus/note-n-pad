// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { composingGotoSurface, gotoLineSurface } from './gotoLineSurface';

describe('the surface Go to Line opens on', () => {
  it('is the range edit box whenever it is open', () => {
    expect(
      gotoLineSurface({ boxOpen: true, windowed: false, large: false }),
    ).toBe('box');
    expect(
      gotoLineSurface({ boxOpen: true, windowed: true, large: true }),
    ).toBe('box');
  });

  it('is the large-file editor for a windowed tab', () => {
    expect(
      gotoLineSurface({ boxOpen: false, windowed: true, large: false }),
    ).toBe('windowed');
    expect(
      gotoLineSurface({ boxOpen: false, windowed: true, large: true }),
    ).toBe('windowed');
  });

  it('is the viewer for a large-file tab that is not windowed', () => {
    expect(
      gotoLineSurface({ boxOpen: false, windowed: false, large: true }),
    ).toBe('large');
  });

  it('is the ordinary editor otherwise', () => {
    expect(
      gotoLineSurface({ boxOpen: false, windowed: false, large: false }),
    ).toBe('editor');
  });
});

describe('whether Go to Line is taken from a composing keydown', () => {
  const on = {
    mac: true,
    composing: true,
    matches: true,
    surface: 'windowed',
  } as const;

  it('is true on macOS, composing, matching, on a large-file surface', () => {
    expect(composingGotoSurface(on)).toBe(true);
    expect(composingGotoSurface({ ...on, surface: 'large' })).toBe(true);
  });

  it('is false off macOS', () => {
    expect(composingGotoSurface({ ...on, mac: false })).toBe(false);
  });

  it('is false when no composition is running', () => {
    expect(composingGotoSurface({ ...on, composing: false })).toBe(false);
  });

  it('is false when the key does not match', () => {
    expect(composingGotoSurface({ ...on, matches: false })).toBe(false);
  });

  it('is false on the ordinary editor and the range edit box', () => {
    expect(composingGotoSurface({ ...on, surface: 'editor' })).toBe(false);
    expect(composingGotoSurface({ ...on, surface: 'box' })).toBe(false);
  });
});
