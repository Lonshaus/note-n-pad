// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { rememberStep } from './documentSize';

describe('rememberStep', () => {
  const k800 = { width: 800, height: 600 };
  const k1000 = { width: 1000, height: 700 };

  it('writes a changed size and makes it known', () => {
    expect(rememberStep(k800, k1000, false)).toEqual({
      known: k1000,
      write: true,
    });
  });

  it('does not write an unchanged size', () => {
    expect(rememberStep(k800, { width: 800, height: 600 }, false)).toEqual({
      known: k800,
      write: false,
    });
  });

  it('ignores a report while maximized or full screen', () => {
    expect(rememberStep(k800, { width: 1920, height: 1080 }, true)).toEqual({
      known: k800,
      write: false,
    });
  });

  it('ignores a minimized report and the unchanged size after restore', () => {
    const minimized = rememberStep(k1000, { width: 0, height: 0 }, true);
    expect(minimized).toEqual({ known: k1000, write: false });
    expect(rememberStep(minimized.known, k1000, false)).toEqual({
      known: k1000,
      write: false,
    });
  });
});
