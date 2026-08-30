// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { pickDefaultTheme, themeCssVars, type Theme } from './themes';

function theme(id: string, variant: 'light' | 'dark'): Theme {
  return {
    id,
    name: id,
    variant,
    editorBg: '#111111',
    editorFg: '#eeeeee',
    uiBg: '#1c1e24',
    uiFg: '#999999',
    uiAccent: '#6f9bd8',
    uiBorder: '#333333',
    danger: '#e2635c',
    syntax: {
      keyword: '#b48ead',
      string: '#9cc09a',
      number: '#d3a15c',
      comment: '#656b78',
      function: '#6f9bd8',
      type: '#6fb3ad',
      variable: '#d4d6dc',
      operator: '#b09aa8',
      const: '#d3a15c',
    },
  };
}

describe('pickDefaultTheme', () => {
  const themes = [theme('paper', 'light'), theme('ink', 'dark')];

  it('picks the first dark theme when the OS prefers dark', () => {
    expect(pickDefaultTheme(true, themes)).toBe('ink');
  });

  it('picks the first light theme when the OS prefers light', () => {
    expect(pickDefaultTheme(false, themes)).toBe('paper');
  });

  it('falls back to the first theme when no variant matches', () => {
    expect(pickDefaultTheme(true, [theme('paper', 'light')])).toBe('paper');
  });

  it('returns undefined for an empty list', () => {
    expect(pickDefaultTheme(true, [])).toBeUndefined();
  });
});

describe('themeCssVars', () => {
  it('exposes only the 2 editor vars + 9 tok vars (chrome is separate)', () => {
    const vars = themeCssVars(theme('ink', 'dark'));
    expect(Object.keys(vars)).toHaveLength(11);
    expect(vars['e-bg']).toBe('#111111');
    expect(vars['tok-keyword']).toBe('#b48ead');
    // Chrome vars are the interface mode's job now, not the theme's.
    expect(vars.bg).toBeUndefined();
  });
});
