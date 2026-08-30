// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { type Theme } from './themes';
import { getColor, setColor } from './themeColor';

function cloneInk(): Theme {
  return {
    id: 'ink',
    name: '墨 Ink',
    variant: 'dark',
    editorBg: '#17181c',
    editorFg: '#d4d6dc',
    uiBg: '#1c1e24',
    uiFg: '#9aa0ac',
    uiAccent: '#6f9bd8',
    uiBorder: '#2b2e36',
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

describe('getColor', () => {
  it('reads a top-level field', () => {
    const theme = cloneInk();
    expect(getColor(theme, 'editorBg')).toBe(theme.editorBg);
  });

  it('reads a nested syntax field', () => {
    const theme = cloneInk();
    expect(getColor(theme, 'syntax.keyword')).toBe(theme.syntax.keyword);
  });
});

describe('setColor', () => {
  it('writes a top-level field in place', () => {
    const theme = cloneInk();
    setColor(theme, 'editorBg', '#123456');
    expect(theme.editorBg).toBe('#123456');
  });

  it('writes a nested syntax field in place', () => {
    const theme = cloneInk();
    setColor(theme, 'syntax.keyword', '#abcdef');
    expect(theme.syntax.keyword).toBe('#abcdef');
  });
});
