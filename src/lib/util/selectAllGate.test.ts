// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSelectAllGate } from './selectAllGate';

describe('selectAllGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs once, at the first check after things settle, then stops polling', async () => {
    let settled = false;
    const run = vi.fn(() => Promise.resolve());
    const gate = createSelectAllGate({
      settled: () => settled,
      run,
      interval: 20,
    });
    gate.request();
    expect(gate.pending()).toBe(true);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).not.toHaveBeenCalled();
    expect(gate.pending()).toBe(true);
    settled = true;
    await vi.advanceTimersByTimeAsync(20);
    expect(run).toHaveBeenCalledTimes(1);
    expect(gate.pending()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('checks at once when the request comes already settled', async () => {
    const run = vi.fn(() => Promise.resolve());
    const gate = createSelectAllGate({
      settled: () => true,
      run,
      interval: 20,
    });
    gate.request();
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(gate.pending()).toBe(false);
  });

  it('does not run again for a request made while one waits', async () => {
    let settled = false;
    const run = vi.fn(() => Promise.resolve());
    const gate = createSelectAllGate({
      settled: () => settled,
      run,
      interval: 20,
    });
    gate.request();
    gate.request();
    await vi.advanceTimersByTimeAsync(40);
    gate.request();
    settled = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not run again for a request made while it runs', async () => {
    let finish: () => void = () => {};
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const gate = createSelectAllGate({
      settled: () => true,
      run,
      interval: 20,
    });
    gate.request();
    await vi.advanceTimersByTimeAsync(100);
    gate.request();
    expect(run).toHaveBeenCalledTimes(1);
    expect(gate.pending()).toBe(true);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(gate.pending()).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('clears the flag when the run throws', async () => {
    const run = vi.fn(() => Promise.reject(new Error('no core')));
    const gate = createSelectAllGate({
      settled: () => true,
      run,
      interval: 20,
    });
    gate.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(gate.pending()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    // A later request runs again.
    gate.request();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('forgets a waiting request when cancelled', async () => {
    const run = vi.fn(() => Promise.resolve());
    const gate = createSelectAllGate({
      settled: () => false,
      run,
      interval: 20,
    });
    gate.request();
    gate.cancel();
    expect(gate.pending()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(run).not.toHaveBeenCalled();
  });
});
