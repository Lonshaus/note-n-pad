// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  /** Cancel a pending call without running it. */
  cancel(): void;
  /** Run any pending call immediately. */
  flush(): void;
}

/**
 * Debounce `fn` by `delay` ms. The latest arguments win; `flush` runs a
 * pending call now, `cancel` drops it.
 */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  delay: number,
): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: A | undefined;

  const run = (): void => {
    timer = undefined;
    if (pending !== undefined) {
      const args = pending;
      pending = undefined;
      fn(...args);
    }
  };

  const debounced = ((...args: A): void => {
    pending = args;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(run, delay);
  }) as Debounced<A>;

  debounced.cancel = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    pending = undefined;
  };

  debounced.flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      run();
    }
  };

  return debounced;
}
