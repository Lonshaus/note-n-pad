// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  modalActsOnEscape,
  popupClosesOnEscape,
  type EscapeKey,
} from './popupEscape';

function esc(extra: Partial<EscapeKey> = {}): EscapeKey {
  return {
    key: 'Escape',
    isComposing: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...extra,
  };
}

describe('popupClosesOnEscape', () => {
  it('closes on a plain Esc when no dialog is open', () => {
    expect(popupClosesOnEscape(esc(), false)).toBe(true);
  });

  it('yields to a dialog that acts on a plain Esc', () => {
    expect(popupClosesOnEscape(esc(), true)).toBe(false);
  });

  it('closes on an Esc the dialog ignores', () => {
    for (const extra of [
      { shiftKey: true },
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
      { isComposing: true },
    ]) {
      expect(popupClosesOnEscape(esc(extra), true)).toBe(true);
    }
  });

  it('ignores other keys', () => {
    expect(popupClosesOnEscape(esc({ key: 'a' }), false)).toBe(false);
    expect(popupClosesOnEscape(esc({ key: 'a' }), true)).toBe(false);
  });
});

describe('modalActsOnEscape', () => {
  it('acts only on a plain Esc outside a composition', () => {
    expect(modalActsOnEscape(esc())).toBe(true);
    expect(modalActsOnEscape(esc({ shiftKey: true }))).toBe(false);
    expect(modalActsOnEscape(esc({ isComposing: true }))).toBe(false);
    expect(modalActsOnEscape(esc({ key: 'Enter' }))).toBe(false);
  });
});
