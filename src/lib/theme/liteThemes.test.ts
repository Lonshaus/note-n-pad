// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import liteConfSource from '../../../src-tauri/tauri.lite.conf.json?raw';
import { pickDefaultTheme, type Theme } from './themes';

const seeds = import.meta.glob<Theme & { order: number }>(
  '../../../src-tauri/resources/themes/*.json',
  { eager: true, import: 'default' },
);

const liteResources: Record<string, string | null> =
  JSON.parse(liteConfSource).bundle.resources;

// The Rust core lists themes by `order`, then name; Lite shows the bundled ones.
const listed = Object.values(seeds)
  .slice()
  .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

describe('the themes the Lite bundle ships', () => {
  it('are the ones Lite resolves: the default of each appearance', () => {
    const wanted = [true, false]
      .map((dark) => pickDefaultTheme(dark, listed))
      .sort();
    const shipped = Object.entries(liteResources)
      .filter(([key, dest]) => key.startsWith('resources/themes/') && dest)
      .map(([key]) => key.slice('resources/themes/'.length, -'.json'.length))
      .sort();
    expect(shipped).toEqual(wanted);
  });

  it('replace the whole themes folder of the full bundle', () => {
    expect(liteResources['resources/themes/*']).toBeNull();
    for (const [key, dest] of Object.entries(liteResources)) {
      if (key.startsWith('resources/themes/') && dest) {
        expect(dest).toBe(key.replace('resources/', ''));
      }
    }
  });
});
