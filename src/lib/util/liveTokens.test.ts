// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KEEPALIVE_MS,
  LiveTokens,
  startKeepalive,
  withReservation,
} from './liveTokens';
import { ReplayQueue } from './replayQueue';
import { RedispatchWaiter, resolveClip } from './pasteRouting';

describe('LiveTokens', () => {
  it('lists what is registered and forgets what is removed', () => {
    const live = new LiveTokens();
    const forgetA = live.hold('reservation', 3);
    live.hold('gate', 9);
    expect(live.tokens().sort((a, b) => a - b)).toEqual([3, 9]);
    forgetA();
    expect(live.tokens()).toEqual([9]);
  });

  it('reads a source when asked, not when registered', () => {
    const live = new LiveTokens();
    const mine = [1];
    live.add('reservation', () => mine);
    mine.push(2);
    expect(live.tokens()).toEqual([1, 2]);
  });

  it('counts one kind apart from the other', () => {
    const live = new LiveTokens();
    live.hold('reservation', 1);
    live.hold('gate', 2);
    expect(live.tokens('reservation')).toEqual([1]);
    expect(live.tokens('gate')).toEqual([2]);
  });
});

describe('startKeepalive', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends every held token each interval, the open gate and the queue among them', async () => {
    const live = new LiveTokens();
    const queue = new ReplayQueue<{ kind: string }>({
      reserve: () => Promise.resolve({ token: 7, seq: 7 }),
      release: () => {},
    });
    queue.enqueue({ kind: 'copy' });
    await Promise.resolve();
    live.add('reservation', () => queue.liveTokens());
    live.hold('gate', 11);
    const send = vi.fn<(tokens: number[]) => void>();
    const stop = startKeepalive(send, live);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].sort((a, b) => a - b)).toEqual([7, 11]);
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
    expect(send).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS * 3);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('sends no token for the pin of a clip: a pin has no deadline to keep', async () => {
    const live = new LiveTokens();
    const clip = await resolveClip(
      {
        platform: 'macos',
        clipStatus: () =>
          Promise.resolve({
            id: 'a',
            bytes: 5,
            lines: 1,
            utf16_len: 5,
            crlf: 0,
            linewise: false,
          }),
        textBegin: () => Promise.resolve({ kind: 'busy' as const }),
        textEnd: () => Promise.resolve(true),
        onGateRevoked: () => () => {},
        pin: () => Promise.resolve(21),
        unpin: () => {},
        redispatchPaste: () => Promise.resolve('send' as const),
        readText: () => Promise.resolve(''),
        focusStill: () => true,
        waiter: new RedispatchWaiter(),
        userInput: () => () => {},
        tokens: live,
        sleep: () => Promise.resolve(),
      },
      1,
      'web',
    );
    expect(clip).toMatchObject({ kind: 'clip', pin: 21 });
    live.hold('gate', 11);
    const send = vi.fn<(tokens: number[]) => void>();
    const stop = startKeepalive(send, live);
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
    expect(send).toHaveBeenCalledWith([11]);
    stop();
  });

  it('sends nothing while no token is held', async () => {
    const send = vi.fn<(tokens: number[]) => void>();
    const stop = startKeepalive(send, new LiveTokens());
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS * 4);
    expect(send).not.toHaveBeenCalled();
    stop();
  });

  it('keeps a token alive past the core lease while its owner lives', async () => {
    const live = new LiveTokens();
    live.hold('gate', 5);
    const send = vi.fn<(tokens: number[]) => void>();
    const stop = startKeepalive(send, live);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(send.mock.calls.length).toBeGreaterThanOrEqual(7);
    stop();
  });
});

describe('withReservation', () => {
  it('registers the token while the copy runs, then forgets it', async () => {
    const live = new LiveTokens();
    let seen: number[] = [];
    const result = await withReservation(
      () => Promise.resolve({ token: 4 }),
      (token) => {
        seen = live.tokens('reservation');
        return Promise.resolve((token ?? 0) * 2);
      },
      live,
    );
    expect(result).toBe(8);
    expect(seen).toEqual([4]);
    expect(live.tokens()).toEqual([]);
  });

  it('forgets the token when the copy fails', async () => {
    const live = new LiveTokens();
    await expect(
      withReservation(
        () => Promise.resolve({ token: 4 }),
        () => Promise.reject(new Error('x')),
        live,
      ),
    ).rejects.toThrow('x');
    expect(live.tokens()).toEqual([]);
  });

  it('runs the copy without a token when the core refuses one', async () => {
    const live = new LiveTokens();
    const result = await withReservation(
      () => Promise.reject(new Error('no')),
      (token) => Promise.resolve(token),
      live,
    );
    expect(result).toBeNull();
    expect(live.tokens()).toEqual([]);
  });
});
