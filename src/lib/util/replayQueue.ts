// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// The windowed editor's replay queue. It is the only holder of the queue and so
// of the clip reservations of the copies and cuts waiting in it: each one is
// reserved when it is queued and released once, however it leaves. Free of the
// DOM and Tauri, so it unit-tests in isolation.

import { pushSelect } from './replayKeys';
/** What `clip_copy_reserve` answers. */
export interface Reservation {
  token: number;
  seq: number;
}
export interface QueueDeps {
  /** Reserves a clip copy at the core, at the moment the copy is queued. */
  reserve: () => Promise<Reservation>;
  /** Gives a reservation back. */
  release: (token: number) => void;
}
/** How a copy or cut taken out of the queue ended: 'clip' went through a
 *  clip copy, which the core releases itself; the others never made one. */
export type FinishOutcome = 'clip' | 'web' | 'drop';

interface Entry {
  /** The token, null until the core has answered or when it failed. */
  token: number | null;
  ready: Promise<number | null>;
  /** 'queued' in the queue, 'taken' out of it but not finished. */
  state: 'queued' | 'taken';
  released: boolean;
}

const reserves = (kind: string): boolean => kind === 'copy' || kind === 'cut';

export class ReplayQueue<T extends { kind: string }> {
  private list: T[] = [];
  private entries = new Map<T, Entry>();

  constructor(private deps: QueueDeps) {}

  get length(): number {
    return this.list.length;
  }
  get head(): T | undefined {
    return this.list[0];
  }
  /** The items in order, to read. */
  get items(): readonly T[] {
    return this.list;
  }
  findIndex(test: (item: T) => boolean): number {
    return this.list.findIndex(test);
  }
  includes(item: T): boolean {
    return this.list.includes(item);
  }
  some(test: (item: T) => boolean): boolean {
    return this.list.some(test);
  }
  /** Adds an item at the end. A copy or cut is reserved at once; a paste
   *  keeps the mark it was given at the event. */
  enqueue(item: T): void {
    this.list.push(item);
    if (reserves(item.kind)) {
      this.reserve(item);
    }
  }
  /** Adds a pointer selection; one directly behind another replaces it. */
  enqueueSelect(item: T): void {
    pushSelect(this.list, item);
  }
  /** Puts `item` in place of the one at `index`. */
  replaceAt(index: number, item: T): void {
    const old = this.list[index];
    if (old === undefined) {
      return;
    }
    this.list[index] = item;
    this.drop(old);
    if (reserves(item.kind)) {
      this.reserve(item);
    }
  }
  removeAt(index: number): void {
    const [old] = this.list.splice(index, 1);
    if (old !== undefined) {
      this.drop(old);
    }
  }
  /** Takes the first item out. A copy or cut stays owed a `finish`. */
  take(): T | undefined {
    const item = this.list.shift();
    if (item !== undefined) {
      const entry = this.entries.get(item);
      if (entry !== undefined) {
        entry.state = 'taken';
      }
    }
    return item;
  }
  /** Takes `item` out when it is the first one. */
  takeIf(item: T): boolean {
    if (this.list[0] !== item) {
      return false;
    }
    this.take();
    return true;
  }
  /** The item taken out is done: a copy that did not go through a clip gives
   *  its reservation back. */
  finish(item: T, outcome: FinishOutcome): void {
    const entry = this.entries.get(item);
    if (entry === undefined) {
      return;
    }
    this.entries.delete(item);
    if (outcome !== 'clip') {
      this.give(entry);
    }
  }
  /** Empties the queue; the copies and cuts left give their reservations back. */
  dropAll(): void {
    const left = this.list;
    this.list = [];
    for (const item of left) {
      this.drop(item);
    }
  }
  /** The reservation of a copy or cut, for the clip copy it makes. */
  reservationOf(item: T): Promise<number | null> | undefined {
    return this.entries.get(item)?.ready;
  }
  /** The reservations held: those of the items in the queue and of the ones
   *  taken out and not finished. */
  liveTokens(): number[] {
    const out: number[] = [];
    for (const entry of this.entries.values()) {
      if (entry.token !== null && !entry.released) {
        out.push(entry.token);
      }
    }
    return out;
  }

  private reserve(item: T): void {
    const entry: Entry = {
      token: null,
      ready: Promise.resolve(null),
      state: 'queued',
      released: false,
    };
    entry.ready = this.deps.reserve().then(
      (r) => {
        entry.token = r.token;
        return r.token;
      },
      () => null,
    );
    this.entries.set(item, entry);
  }
  /** An item leaves without being taken. */
  private drop(item: T): void {
    const entry = this.entries.get(item);
    if (entry !== undefined) {
      this.entries.delete(item);
      this.give(entry);
    }
  }
  /** Gives the reservation back once, waiting for the token if it is not here. */
  private give(entry: Entry): void {
    if (entry.released) {
      return;
    }
    entry.released = true;
    void entry.ready.then((token) => {
      if (token !== null) {
        this.deps.release(token);
      }
    });
  }
}
