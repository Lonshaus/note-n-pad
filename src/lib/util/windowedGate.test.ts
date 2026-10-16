// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { createOpGate } from './windowedGate';

function deferred(): {
  promise: Promise<string>;
  resolve: () => void;
  reject: () => void;
} {
  let resolve: () => void = () => {};
  let reject: () => void = () => {};
  const promise = new Promise<string>((res, rej) => {
    resolve = () => res('done');
    reject = () => rej(new Error('boom'));
  });
  return { promise, resolve, reject };
}

describe('windowedGate', () => {
  it('is open when nothing is pending', async () => {
    const gate = createOpGate(null);
    expect(gate.pending()).toBe(false);
    expect(gate.readOnly()).toBe(false);
    expect(gate.canApply()).toBe(true);
    const read = vi.fn(() => Promise.resolve('window'));
    await expect(gate.whenIdle(read)).resolves.toBe('window');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reports read-only and refuses an apply while an operation is pending', async () => {
    const gate = createOpGate(null);
    const op = deferred();
    gate.begin(op.promise);
    expect(gate.pending()).toBe(true);
    expect(gate.readOnly()).toBe(true);
    expect(gate.canApply()).toBe(false);
    op.resolve();
    await gate.whenIdle(() => Promise.resolve());
    expect(gate.readOnly()).toBe(false);
    expect(gate.canApply()).toBe(true);
  });

  it('defers the first window read until the operation resolves', async () => {
    const gate = createOpGate(null);
    const op = deferred();
    gate.begin(op.promise);
    const read = vi.fn(() => Promise.resolve('replaced content'));
    const first = gate.whenIdle(read);
    await Promise.resolve();
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
    op.resolve();
    await expect(first).resolves.toBe('replaced content');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('gates an editor mounted while the operation is already pending', async () => {
    // The tab switched away and back: the new editor gets a gate that already
    // holds the operation's promise.
    const op = deferred();
    const gate = createOpGate(op.promise);
    expect(gate.canApply()).toBe(false);
    expect(gate.readOnly()).toBe(true);
    const read = vi.fn(() => Promise.resolve('window'));
    const first = gate.whenIdle(read);
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
    op.resolve();
    await first;
    expect(read).toHaveBeenCalledTimes(1);
    expect(gate.canApply()).toBe(true);
  });

  it('opens again when the operation fails', async () => {
    const gate = createOpGate(null);
    const op = deferred();
    gate.begin(op.promise);
    op.reject();
    await gate.whenIdle(() => Promise.resolve());
    expect(gate.canApply()).toBe(true);
  });

  it('waits for an operation that begins while it waits for another', async () => {
    const gate = createOpGate(null);
    const first = deferred();
    const second = deferred();
    gate.begin(first.promise);
    const read = vi.fn(() => Promise.resolve('x'));
    const pending = gate.whenIdle(read);
    first.resolve();
    await Promise.resolve();
    gate.begin(second.promise);
    await Promise.resolve();
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
    second.resolve();
    await pending;
    expect(read).toHaveBeenCalledTimes(1);
  });
});
