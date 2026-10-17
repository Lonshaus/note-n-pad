// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  availableFonts,
  cssFontFamily,
  DEFAULT_FONT_STACK,
  dropdownFontFamilies,
  filterInstalledFonts,
  pickableFontFamilies,
  withAddedFont,
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

describe('dropdownFontFamilies', () => {
  it('lists detected faces first, then added families in stored order', () => {
    expect(
      dropdownFontFamilies(['Menlo', 'Monaco'], ['Zapfino', 'Arial'], ''),
    ).toEqual(['Menlo', 'Monaco', 'Zapfino', 'Arial']);
  });

  it('does not repeat an added family that is also a detected face', () => {
    expect(dropdownFontFamilies(['Menlo'], ['Menlo', 'Zapfino'], '')).toEqual([
      'Menlo',
      'Zapfino',
    ]);
  });

  it('does not repeat a family added twice', () => {
    expect(dropdownFontFamilies([], ['Zapfino', 'Zapfino'], '')).toEqual([
      'Zapfino',
    ]);
  });

  it('adds a stored font this host did not detect after the other rows', () => {
    const rows = dropdownFontFamilies(['Menlo'], ['Zapfino'], 'Consolas');
    expect(rows).toEqual(['Menlo', 'Zapfino', 'Consolas']);
    expect(rows).toContain('Consolas');
  });

  it('does not repeat a current font that is already a row', () => {
    expect(dropdownFontFamilies(['Menlo'], ['Zapfino'], 'Menlo')).toEqual([
      'Menlo',
      'Zapfino',
    ]);
    expect(dropdownFontFamilies(['Menlo'], ['Zapfino'], 'Zapfino')).toEqual([
      'Menlo',
      'Zapfino',
    ]);
  });

  it('adds no row for the built-in default (empty current font)', () => {
    expect(dropdownFontFamilies(['Menlo'], [], '')).toEqual(['Menlo']);
  });

  it('is empty when nothing is detected or added', () => {
    expect(dropdownFontFamilies([], [], '')).toEqual([]);
  });
});

describe('pickableFontFamilies', () => {
  it('keeps the host order', () => {
    expect(
      pickableFontFamilies(['Arial', 'Apple Symbols', 'Zapfino'], []),
    ).toEqual(['Arial', 'Apple Symbols', 'Zapfino']);
  });

  it('leaves out the current font row an undetected face gets', () => {
    const rows = dropdownFontFamilies([], [], 'Consolas');
    expect(pickableFontFamilies(['Consolas', 'Arial'], rows)).toEqual([
      'Arial',
    ]);
  });

  it('leaves out families the dropdown already lists', () => {
    expect(
      pickableFontFamilies(['Arial', 'Menlo', 'Zapfino'], ['Menlo', 'Zapfino']),
    ).toEqual(['Arial']);
  });

  it('compares case-insensitively', () => {
    expect(pickableFontFamilies(['menlo', 'Arial'], ['Menlo'])).toEqual([
      'Arial',
    ]);
  });

  it('lists each family once', () => {
    expect(pickableFontFamilies(['Arial', 'Arial', 'arial'], [])).toEqual([
      'Arial',
    ]);
  });

  it('is empty when the host list is empty', () => {
    expect(pickableFontFamilies([], ['Menlo'])).toEqual([]);
  });
});

describe('withAddedFont', () => {
  it('appends a new family after the existing ones', () => {
    expect(withAddedFont(['Arial'], 'Zapfino')).toEqual(['Arial', 'Zapfino']);
  });

  it('does not repeat a family already added', () => {
    expect(withAddedFont(['Arial'], 'Arial')).toEqual(['Arial']);
  });

  it('ignores an empty family and trims the name', () => {
    expect(withAddedFont(['Arial'], '  ')).toEqual(['Arial']);
    expect(withAddedFont([], ' Zapfino ')).toEqual(['Zapfino']);
  });
});
