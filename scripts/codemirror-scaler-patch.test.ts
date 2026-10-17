// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { patchViewScaler } from './codemirror-scaler-patch.ts';

const VIEW_SOURCE = fs.readFileSync(
  path.join(
    import.meta.dirname,
    '..',
    'node_modules',
    '@codemirror',
    'view',
    'dist',
    'index.js',
  ),
  'utf8',
);

describe('patchViewScaler', () => {
  it('patches the installed file once and rebuilds the scaler before the viewport branch', () => {
    const patched = patchViewScaler(VIEW_SOURCE);
    expect(patched).not.toBe(VIEW_SOURCE);
    expect(patched).toContain(
      `        if (result & 2 /* UpdateFlag.Height */)
            result |= this.updateScaler();
        if (viewportChange) {
            this.viewport = this.getViewport(bias, this.scrollTarget);`,
    );
    expect(patched.split('result |= this.updateScaler();').length).toBe(
      VIEW_SOURCE.split('result |= this.updateScaler();').length,
    );
  });

  it('throws when the block is absent', () => {
    expect(() => patchViewScaler('let a = 1;\n')).toThrow('found 0');
  });

  it('throws when the block occurs twice', () => {
    expect(() => patchViewScaler(VIEW_SOURCE + VIEW_SOURCE)).toThrow('found 2');
  });

  it('throws on an already patched file', () => {
    expect(() => patchViewScaler(patchViewScaler(VIEW_SOURCE))).toThrow(
      'found 0',
    );
  });
});
