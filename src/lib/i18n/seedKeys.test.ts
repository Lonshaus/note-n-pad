// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { zhTW } from './zh-TW';

const seeds = import.meta.glob<{ strings: Record<string, string> }>(
  '../../../src-tauri/resources/locales/*.json',
  { eager: true, import: 'default' },
);

describe('seed locale files', () => {
  it('finds the seed files', () => {
    expect(Object.keys(seeds).length).toBeGreaterThan(0);
  });

  it('carry exactly the built-in key set', () => {
    const expected = Object.keys(zhTW).sort();
    for (const [path, seed] of Object.entries(seeds)) {
      expect(Object.keys(seed.strings).sort(), path).toEqual(expected);
    }
  });
});
