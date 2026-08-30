// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { Lru } from './lru';

describe('Lru', () => {
  it('stores and retrieves values', () => {
    const cache = new Lru<number, string>(3);
    cache.set(1, 'a');
    expect(cache.get(1)).toBe('a');
    expect(cache.has(1)).toBe(true);
    expect(cache.get(2)).toBeUndefined();
  });

  it('evicts the least-recently-used entry past capacity', () => {
    const cache = new Lru<number, string>(2);
    cache.set(1, 'a');
    cache.set(2, 'b');
    cache.set(3, 'c');
    expect(cache.has(1)).toBe(false);
    expect(cache.has(2)).toBe(true);
    expect(cache.has(3)).toBe(true);
    expect(cache.size).toBe(2);
  });

  it('a get marks an entry as recently used', () => {
    const cache = new Lru<number, string>(2);
    cache.set(1, 'a');
    cache.set(2, 'b');
    // Touch 1 so 2 becomes the eviction target.
    expect(cache.get(1)).toBe('a');
    cache.set(3, 'c');
    expect(cache.has(1)).toBe(true);
    expect(cache.has(2)).toBe(false);
  });

  it('re-setting an existing key updates value and recency', () => {
    const cache = new Lru<number, string>(2);
    cache.set(1, 'a');
    cache.set(2, 'b');
    cache.set(1, 'z');
    expect(cache.get(1)).toBe('z');
    cache.set(3, 'c');
    // 2 was least-recently used, so it is evicted, not the refreshed 1.
    expect(cache.has(1)).toBe(true);
    expect(cache.has(2)).toBe(false);
  });
});
