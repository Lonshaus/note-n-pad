// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { guessOsFromUserAgent } from './guessOs';

describe('guessOsFromUserAgent', () => {
  it('detects Windows', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    expect(guessOsFromUserAgent(ua)).toBe('windows');
  });

  it('detects macOS', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
    expect(guessOsFromUserAgent(ua)).toBe('macos');
  });

  it('defaults to linux for a GTK/WebKitGTK UA', () => {
    const ua =
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)';
    expect(guessOsFromUserAgent(ua)).toBe('linux');
  });

  it('fails closed (null) for an unrecognized UA rather than guessing linux', () => {
    expect(guessOsFromUserAgent('')).toBeNull();
    expect(guessOsFromUserAgent('Mozilla/5.0 (compatible)')).toBeNull();
  });
});
