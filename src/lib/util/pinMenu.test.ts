// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { effectivePinMode, pinMenuHasApps } from './pinMenu';

describe('effectivePinMode', () => {
  it('shows a stored app pin as unpinned while Lite', () => {
    expect(effectivePinMode('app', true)).toBe('none');
  });

  it('keeps the app pin in the full edition', () => {
    expect(effectivePinMode('app', false)).toBe('app');
  });

  it('leaves top and none alone in both editions', () => {
    for (const lite of [true, false]) {
      expect(effectivePinMode('top', lite)).toBe('top');
      expect(effectivePinMode('none', lite)).toBe('none');
    }
  });
});

describe('pinMenuHasApps', () => {
  it('offers the app list only in the full edition', () => {
    expect(pinMenuHasApps(true)).toBe(false);
    expect(pinMenuHasApps(false)).toBe(true);
  });
});
