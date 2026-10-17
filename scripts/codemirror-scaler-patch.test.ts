// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  patchViewScaler,
  REPLACEMENTS,
  wrappedGapHeight,
} from './codemirror-scaler-patch.ts';

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

  it('applies every replacement exactly once', () => {
    const patched = patchViewScaler(VIEW_SOURCE);
    for (const r of REPLACEMENTS) {
      expect(VIEW_SOURCE.split(r.old).length - 1, r.name).toBe(1);
      expect(patched.split(r.new).length - 1, r.name).toBe(1);
      expect(patched.split(r.old).length - 1, r.name).toBe(
        r.new.split(r.old).length - 1,
      );
    }
    expect(
      patched.split(
        'scrollOffset = scrollOffset + diff;\n                        scroll.scrollTop += diff;',
      ).length - 1,
    ).toBe(1);
  });

  it('uses the fixed viewport constants', () => {
    const patched = patchViewScaler(VIEW_SOURCE);
    expect(patched).toContain('top <= visibleTop - 600');
    expect(patched).toContain('bottom >= visibleBottom + 600');
    expect(patched).toContain(
      'top > visibleTop - 4000 && bottom < visibleBottom + 4000',
    );
    expect(patched).toContain(
      'map.lineAt(visibleTop - 1200, QueryType.ByHeight',
    );
    expect(patched).toContain(
      'map.lineAt(visibleBottom + 1200, QueryType.ByHeight',
    );
    expect(patched).toContain(
      'return lines * this.heightForLine(Math.max(0, (to - from - (lines - 1)) / lines));',
    );
  });

  it.each(REPLACEMENTS.map((r) => [r.name, r] as const))(
    'throws naming "%s" when its block is absent',
    (name, r) => {
      expect(() => patchViewScaler(VIEW_SOURCE.split(r.old).join(''))).toThrow(
        name,
      );
      expect(() => patchViewScaler(VIEW_SOURCE.split(r.old).join(''))).toThrow(
        'found 0',
      );
    },
  );

  it.each(REPLACEMENTS.map((r) => [r.name, r] as const))(
    'throws naming "%s" when its block occurs twice',
    (name, r) => {
      expect(() => patchViewScaler(VIEW_SOURCE + r.old)).toThrow(name);
      expect(() => patchViewScaler(VIEW_SOURCE + r.old)).toThrow('found 2');
    },
  );
});

describe('wrappedGapHeight', () => {
  const lineHeight = 18;
  const lineLength = 88.3;
  const heightForLine = (len: number) =>
    (1 +
      Math.max(
        0,
        Math.ceil((len - lineLength) / Math.max(1, lineLength - 5)),
      )) *
    lineHeight;

  it.each([1, 2, 10, 1000, 1000123])(
    'returns 36 * n for %i uniform 99-char lines',
    (n) => {
      expect(wrappedGapHeight(n, 100 * n - 1, heightForLine)).toBe(36 * n);
    },
  );

  it.each([
    [88, 18],
    [89, 36],
  ])('prices uniform %i-char lines at %i px each', (chars, px) => {
    for (const n of [1, 3]) {
      expect(wrappedGapHeight(n, (chars + 1) * n - 1, heightForLine)).toBe(
        px * n,
      );
    }
  });
});
