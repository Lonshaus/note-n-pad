// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// A Select All that waits for the editor to settle. It cannot run inside a
// transaction filter or while input is queued or a window swap runs, so it sets
// a flag and runs once everything in flight is over, checking on a timer.
// Free of the DOM and Tauri, so it unit-tests in isolation.

export interface SelectAllGate {
  /** Ask for a Select All; does nothing while one is already waiting. */
  request: () => void;
  /** Whether a Select All is waiting or running. */
  pending: () => boolean;
  /** Forget a waiting Select All and stop checking. */
  cancel: () => void;
}

export function createSelectAllGate(opts: {
  /** Whether nothing is in flight any more. */
  settled: () => boolean;
  /** The Select All itself. */
  run: () => Promise<void>;
  /** Milliseconds between checks. */
  interval: number;
}): SelectAllGate {
  let flag = false;
  let running = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  function stop(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  async function check(): Promise<void> {
    if (!flag || running || !opts.settled()) {
      return;
    }
    running = true;
    try {
      await opts.run();
    } catch {
      // A failed Select All leaves the selection as it was.
    } finally {
      running = false;
      flag = false;
      stop();
    }
  }

  return {
    request(): void {
      if (flag) {
        return;
      }
      flag = true;
      timer = setInterval(() => void check(), opts.interval);
      void check();
    },
    pending(): boolean {
      return flag;
    },
    cancel(): void {
      flag = false;
      stop();
    },
  };
}
