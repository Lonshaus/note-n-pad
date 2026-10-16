// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  canReuseIndex,
  remountTopLine,
  type LargeIndexRef,
} from './largeIndex';

const kept: LargeIndexRef = { id: 'i', size: 100, mtimeMs: 5 };
const same = { size: 100, mtimeMs: 5 };

describe('canReuseIndex', () => {
  it('reuses a running or finished index of an unchanged file', () => {
    expect(canReuseIndex(kept, same, 'running')).toBe(true);
    expect(canReuseIndex(kept, same, 'done')).toBe(true);
  });

  it('rebuilds when the size or the mtime changed', () => {
    expect(canReuseIndex(kept, { size: 101, mtimeMs: 5 }, 'done')).toBe(false);
    expect(canReuseIndex(kept, { size: 100, mtimeMs: 6 }, 'done')).toBe(false);
  });

  it('rebuilds when the index id is unknown or the scan failed', () => {
    expect(canReuseIndex(kept, same, 'unknown')).toBe(false);
    expect(canReuseIndex(kept, same, 'failed')).toBe(false);
  });

  it('rebuilds without a kept index or without a readable file', () => {
    expect(canReuseIndex(undefined, same, 'done')).toBe(false);
    expect(canReuseIndex(kept, null, 'done')).toBe(false);
  });
});

describe('remountTopLine', () => {
  it('prefers the scrolled-to line over the opening line', () => {
    expect(remountTopLine(165, 3)).toBe(165);
    expect(remountTopLine(0, 3)).toBe(0);
  });

  it('falls back to the opening line, then to the first line', () => {
    expect(remountTopLine(undefined, 42)).toBe(42);
    expect(remountTopLine(undefined, undefined)).toBe(0);
  });
});
