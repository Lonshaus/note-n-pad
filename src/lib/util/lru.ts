// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Bounded least-recently-used cache backed by a Map (which keeps insertion
 *  order). `get` marks an entry as most-recently used; `set` evicts the oldest
 *  entry once the size passes `max`. */
export class Lru<K, V> {
  private readonly max: number;
  private readonly map = new Map<K, V>();

  constructor(max: number) {
    this.max = Math.max(1, max);
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      // Re-insert to move the key to the most-recently-used end.
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }
  }

  get size(): number {
    return this.map.size;
  }
}
