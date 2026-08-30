// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { debounce } from './debounce';

describe('debounce', () => {
  it('runs once after the delay with the latest args', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 500);
    d(1);
    d(2);
    d(3);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(3);
    vi.useRealTimers();
  });

  it('flush runs a pending call immediately', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 500);
    d('x');
    d.flush();
    expect(fn).toHaveBeenCalledExactlyOnceWith('x');
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('flush is a no-op when nothing is pending', () => {
    const fn = vi.fn();
    const d = debounce(fn, 500);
    d.flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it('cancel drops a pending call', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 500);
    d('x');
    d.cancel();
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

// Regression: F5 (documentWindow.svelte.ts's `upsertTab`). `flush()` invokes
// its callback synchronously (see `run` above), so any code relying on
// "flush(); await someTrackedPromise" to wait for the just-flushed write must
// assign that tracked promise synchronously, in the same tick `flush()`
// returns in — not after an `await` inside the callback. These two tests pin
// that contract directly against `debounce`, independent of the Tauri/session
// plumbing `upsertTab` itself is entangled with.
describe('flush() then awaiting a tracked "last operation" promise (regression: F5)', () => {
  it('a synchronously assigned promise (built with .then(), not async/await) is the one flush() just triggered', async () => {
    let lastSave: Promise<void> = Promise.resolve();
    const writes: string[] = [];
    // Mirrors the fixed `upsertTab`: not `async`, builds the whole chain with
    // `.then()`, and assigns `lastSave` before returning — all synchronously.
    const upsert = (label: string): Promise<void> => {
      const promise = Promise.resolve()
        .then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
        .then(() => {
          writes.push(label);
        });
      lastSave = promise;
      return promise;
    };
    const persist = debounce((label: string) => {
      void upsert(label);
    }, 500);

    vi.useFakeTimers();
    persist('first');
    persist.flush();
    vi.useRealTimers();

    await lastSave;
    expect(writes).toEqual(['first']);
  });

  it('an async callback that assigns its tracked promise after its first await misses the race (the F5 bug)', async () => {
    let lastSave: Promise<void> = Promise.resolve();
    const writes: string[] = [];
    // Mirrors the pre-fix `upsertTab`: `async`, and its first line awaits
    // something (standing in for `await this.snapshot(tab)`) before
    // `lastSave` gets assigned.
    const upsertBuggy = async (label: string): Promise<void> => {
      await Promise.resolve();
      const promise = new Promise<void>((resolve) =>
        setTimeout(resolve, 0),
      ).then(() => {
        writes.push(label);
      });
      lastSave = promise;
      return promise;
    };
    const persist = debounce((label: string) => {
      void upsertBuggy(label);
    }, 500);

    vi.useFakeTimers();
    persist('first');
    persist.flush();
    // `flush()` has already returned control here, but `upsertBuggy` has not
    // reached its `await`-following assignment yet, so `lastSave` still holds
    // the *previous* value — exactly the stale-promise bug F5 fixes.
    const staleLastSave = lastSave;
    vi.useRealTimers();

    await staleLastSave;
    expect(writes).toEqual([]);
  });
});
