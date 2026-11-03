// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { ReplayQueue } from './replayQueue';

type Item =
  | { kind: 'copy' | 'cut'; clip: true }
  | { kind: 'copy' | 'cut'; supply: () => void }
  | { kind: 'clipPaste'; mark: Promise<number | null> }
  | { kind: 'text' | 'key' | 'slot' | 'select' | 'undo'; id?: number };

function setup() {
  let next = 0;
  const release = vi.fn<(token: number) => void>();
  const reserve = vi.fn(() => {
    next += 1;
    return Promise.resolve({ token: next, seq: next });
  });
  const queue = new ReplayQueue<Item>({ reserve, release });
  return { queue, reserve, release };
}
// A queue whose reservations are answered by hand, in the order they were asked.
function manual() {
  const answers: ((token: number) => void)[] = [];
  const release = vi.fn<(token: number) => void>();
  const reserve = vi.fn(
    () =>
      new Promise<{ token: number; seq: number }>((resolve) => {
        answers.push((token) => resolve({ token, seq: token }));
      }),
  );
  const queue = new ReplayQueue<Item>({ reserve, release });
  return { queue, reserve, release, answers };
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
};

describe('ReplayQueue reservations', () => {
  it('reserves a copy or cut of either queueing route', () => {
    const { queue, reserve } = setup();
    queue.enqueue({ kind: 'copy', clip: true });
    queue.enqueue({ kind: 'cut', supply: () => {} });
    queue.enqueue({ kind: 'copy', supply: () => {} });
    queue.enqueue({ kind: 'cut', clip: true });
    expect(reserve).toHaveBeenCalledTimes(4);
  });

  it('reserves nothing for a paste, a key, text or a selection', () => {
    const { queue, reserve } = setup();
    queue.enqueue({ kind: 'clipPaste', mark: Promise.resolve(1) });
    queue.enqueue({ kind: 'key' });
    queue.enqueue({ kind: 'text' });
    queue.enqueue({ kind: 'slot' });
    queue.enqueueSelect({ kind: 'select' });
    queue.enqueue({ kind: 'undo' });
    expect(reserve).not.toHaveBeenCalled();
  });

  it('does not give a reservation back for a copy that went through a clip', async () => {
    const { queue, release } = setup();
    const item: Item = { kind: 'copy', clip: true };
    queue.enqueue(item);
    expect(queue.take()).toBe(item);
    queue.finish(item, 'clip');
    await settle();
    expect(release).not.toHaveBeenCalled();
  });

  it.each(['web', 'drop'] as const)(
    'gives the reservation back once when the copy ended as %s',
    async (outcome) => {
      const { queue, release } = setup();
      const item: Item = { kind: 'cut', supply: () => {} };
      queue.enqueue(item);
      queue.take();
      queue.finish(item, outcome);
      queue.finish(item, outcome);
      await settle();
      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith(1);
    },
  );

  it('gives back the reservation of every copy and cut left when it is emptied', async () => {
    const { queue, release } = setup();
    queue.enqueue({ kind: 'copy', clip: true });
    queue.enqueue({ kind: 'key' });
    queue.enqueue({ kind: 'cut', supply: () => {} });
    queue.enqueue({ kind: 'clipPaste', mark: Promise.resolve(2) });
    queue.dropAll();
    await settle();
    expect(queue.length).toBe(0);
    expect(release.mock.calls.map((c) => c[0]).sort((a, b) => a - b)).toEqual([
      1, 2,
    ]);
  });

  it('leaves the copy a drain has taken out to its own finish when emptied', async () => {
    const { queue, release } = setup();
    const item: Item = { kind: 'copy', clip: true };
    queue.enqueue(item);
    queue.take();
    queue.dropAll();
    await settle();
    expect(release).not.toHaveBeenCalled();
    queue.finish(item, 'drop');
    await settle();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('waits for a token that has not come back before giving it back', async () => {
    const { queue, release, answers } = manual();
    const taken: Item = { kind: 'copy', clip: true };
    queue.enqueue(taken);
    queue.enqueue({ kind: 'cut', supply: () => {} });
    queue.take();
    queue.finish(taken, 'web');
    queue.dropAll();
    await settle();
    expect(release).not.toHaveBeenCalled();
    answers[0]?.(10);
    await settle();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(10);
    answers[1]?.(11);
    await settle();
    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenLastCalledWith(11);
  });

  it('treats a failed reservation as having nothing to give back', async () => {
    const release = vi.fn();
    const queue = new ReplayQueue<Item>({
      reserve: () => Promise.reject(new Error('gone')),
      release,
    });
    queue.enqueue({ kind: 'copy', clip: true });
    queue.dropAll();
    await settle();
    expect(release).not.toHaveBeenCalled();
    expect(queue.liveTokens()).toEqual([]);
  });

  it('gives back the reservation of an item that is replaced or removed', async () => {
    const { queue, release } = setup();
    queue.enqueue({ kind: 'copy', clip: true });
    queue.enqueue({ kind: 'cut', clip: true });
    queue.replaceAt(0, { kind: 'text' });
    queue.removeAt(1);
    await settle();
    expect(release.mock.calls.map((c) => c[0]).sort((a, b) => a - b)).toEqual([
      1, 2,
    ]);
  });

  it('hands the reservation of an item to the clip copy it makes', async () => {
    const { queue } = setup();
    const item: Item = { kind: 'copy', clip: true };
    queue.enqueue(item);
    expect(await queue.reservationOf(item)).toBe(1);
    expect(queue.reservationOf({ kind: 'copy', clip: true })).toBeUndefined();
  });
});

describe('ReplayQueue marks', () => {
  it('keeps the mark a paste was queued with, through take', async () => {
    const { queue } = setup();
    const mark = Promise.resolve(41);
    const item: Item = { kind: 'clipPaste', mark };
    queue.enqueue(item);
    queue.enqueue({ kind: 'key' });
    const out = queue.take();
    expect(out).toBe(item);
    expect(out !== undefined && 'mark' in out ? out.mark : null).toBe(mark);
  });
});

describe('ReplayQueue liveTokens', () => {
  it('lists the tokens of the items queued and of those taken out and not finished', async () => {
    const { queue } = setup();
    const a: Item = { kind: 'copy', clip: true };
    const b: Item = { kind: 'cut', supply: () => {} };
    queue.enqueue(a);
    queue.enqueue(b);
    await settle();
    expect(queue.liveTokens().sort((a, b) => a - b)).toEqual([1, 2]);
    queue.take();
    expect(queue.liveTokens().sort((a, b) => a - b)).toEqual([1, 2]);
    queue.finish(a, 'clip');
    expect(queue.liveTokens()).toEqual([2]);
    queue.dropAll();
    expect(queue.liveTokens()).toEqual([]);
  });

  it('leaves out a token the core has not answered yet', async () => {
    const { queue, answers } = manual();
    queue.enqueue({ kind: 'copy', clip: true });
    expect(queue.liveTokens()).toEqual([]);
    answers[0]?.(3);
    await settle();
    expect(queue.liveTokens()).toEqual([3]);
  });
});

describe('ReplayQueue order', () => {
  it('replaces a pointer selection directly behind another', () => {
    const { queue } = setup();
    const first: Item = { kind: 'select', id: 1 };
    const second: Item = { kind: 'select', id: 2 };
    queue.enqueueSelect(first);
    queue.enqueueSelect(second);
    expect(queue.items).toEqual([second]);
    queue.enqueue({ kind: 'slot' });
    queue.enqueueSelect({ kind: 'select', id: 3 });
    expect(queue.length).toBe(3);
  });

  it('takes an item out only when it is the first one', () => {
    const { queue } = setup();
    const a: Item = { kind: 'text' };
    const b: Item = { kind: 'key' };
    queue.enqueue(a);
    queue.enqueue(b);
    expect(queue.takeIf(b)).toBe(false);
    expect(queue.takeIf(a)).toBe(true);
    expect(queue.head).toBe(b);
  });
});
