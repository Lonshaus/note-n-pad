// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  availableFonts,
  cssFontFamily,
  DEFAULT_FONT_STACK,
  filterInstalledFonts,
} from './font';

describe('availableFonts', () => {
  const MONO_BASE = 100;
  const SANS_BASE = 120;
  // Width table keyed by the CSS font-family value availableFonts measures. An
  // absent face falls back to the generic and matches its baseline on both
  // stacks; an installed face shifts at least one width away from its baseline.
  const WIDTHS: Record<string, number> = {
    monospace: MONO_BASE,
    'sans-serif': SANS_BASE,
    // Installed, distinct from both generics.
    "'SF Mono', monospace": 88,
    "'SF Mono', sans-serif": 88,
    // Menlo-type: equals the monospace baseline (macOS generic mono IS Menlo)
    // but differs from the sans-serif baseline, so it must be judged installed.
    "'Menlo', monospace": MONO_BASE,
    "'Menlo', sans-serif": 105,
    // Absent: both stacks fall back to the generic and match its baseline.
    "'NoSuchFont', monospace": MONO_BASE,
    "'NoSuchFont', sans-serif": SANS_BASE,
  };
  const measure = (family: string): number => WIDTHS[family] ?? 0;

  it('keeps distinct-width faces and drops fallback-only ones', () => {
    expect(availableFonts(['SF Mono', 'NoSuchFont'], measure)).toEqual([
      'SF Mono',
    ]);
  });

  it('detects a face equal to the monospace baseline via the sans baseline', () => {
    // The core lesson: Menlo == generic monospace on macOS, so a monospace-only
    // check would wrongly drop it. The sans-serif baseline keeps it.
    expect(availableFonts(['Menlo'], measure)).toEqual(['Menlo']);
  });

  it('preserves candidate order', () => {
    expect(availableFonts(['SF Mono', 'NoSuchFont', 'Menlo'], measure)).toEqual(
      ['SF Mono', 'Menlo'],
    );
  });

  it('returns an empty list when every candidate only falls back', () => {
    expect(availableFonts(['NoSuchFont'], measure)).toEqual([]);
  });
});

describe('filterInstalledFonts', () => {
  it('keeps only candidates present in the installed list', () => {
    expect(
      filterInstalledFonts(
        ['Courier New', 'Liberation Mono', 'DejaVu Sans Mono'],
        ['Liberation Mono', 'DejaVu Sans Mono'],
      ),
    ).toEqual(['Liberation Mono', 'DejaVu Sans Mono']);
  });

  it('matches case-insensitively', () => {
    expect(
      filterInstalledFonts(['liberation mono'], ['Liberation Mono']),
    ).toEqual(['liberation mono']);
  });

  it('drops a candidate the fontconfig list does not have, even if the browser would substitute it', () => {
    expect(filterInstalledFonts(['Courier New'], ['Courier 10 Pitch'])).toEqual(
      [],
    );
  });

  it('returns an empty list when nothing is installed', () => {
    expect(filterInstalledFonts(['Consolas'], [])).toEqual([]);
  });
});

describe('cssFontFamily', () => {
  it('falls back to the built-in stack for an empty name', () => {
    expect(cssFontFamily('')).toBe(DEFAULT_FONT_STACK);
    expect(cssFontFamily('   ')).toBe(DEFAULT_FONT_STACK);
  });

  it('quotes a multi-word family and layers it in front of the stack', () => {
    expect(cssFontFamily('Cascadia Mono')).toBe(
      `'Cascadia Mono', ${DEFAULT_FONT_STACK}`,
    );
  });

  it('leaves a single-token family unquoted', () => {
    expect(cssFontFamily('Consolas')).toBe(`Consolas, ${DEFAULT_FONT_STACK}`);
  });
});
