// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMPOSITION_END_TIMEOUT_MS,
  settleComposition,
  settleThenDrain,
  type CompositionHost,
} from './composition';

function fakeHost(composing: boolean): {
  host: CompositionHost;
  calls: string[];
  end: () => void;
} {
  const calls: string[] = [];
  let done: (() => void) | null = null;
  return {
    calls,
    end: () => {
      calls.push('compositionend');
      done?.();
    },
    host: {
      composing: () => composing,
      blur: () => calls.push('blur'),
      onEnd: (cb) => {
        done = cb;
        return () => {
          done = null;
        };
      },
    },
  };
}

describe('settleComposition', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves at once when nothing is composing', async () => {
    const { host, calls } = fakeHost(false);
    await settleComposition(host);
    expect(calls).toEqual([]);
  });

  it('blurs, then waits for compositionend and the editor flush', async () => {
    const { host, calls, end } = fakeHost(true);
    let settled = false;
    const pending = settleComposition(host).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(calls).toEqual(['blur']);
    expect(settled).toBe(false);
    // The editor queues its own flush while handling compositionend.
    void Promise.resolve().then(() => calls.push('flush'));
    end();
    await pending;
    expect(calls).toEqual(['blur', 'compositionend', 'flush']);
  });

  it('also waits for a flush queued by a listener that runs after its own', async () => {
    let done: () => void = () => {};
    const host: CompositionHost = {
      composing: () => true,
      blur: () => {},
      onEnd: (cb) => {
        done = cb;
        return () => {};
      },
    };
    const order: string[] = [];
    const pending = settleComposition(host).then(() => {
      order.push('resolved');
    });
    done();
    // The editor's own compositionend listener comes next and queues its flush.
    void Promise.resolve().then(() => order.push('flush'));
    await pending;
    expect(order).toEqual(['flush', 'resolved']);
  });

  it('gives up after the timeout when compositionend never comes', async () => {
    vi.useFakeTimers();
    const { host } = fakeHost(true);
    let settled = false;
    const pending = settleComposition(host).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(COMPOSITION_END_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
  });
});

describe('settleThenDrain', () => {
  it('waits for the pending work only after the composition has settled', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const settle = (): Promise<void> =>
      new Promise<void>((resolve) => {
        release = () => {
          order.push('settled');
          resolve();
        };
      });
    const drain = async (): Promise<void> => {
      order.push('drain-start');
      await Promise.resolve();
      order.push('drain-end');
    };
    const done = settleThenDrain(settle, drain).then(() => {
      order.push('resolved');
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    release();
    await done;
    expect(order).toEqual(['settled', 'drain-start', 'drain-end', 'resolved']);
  });
});
