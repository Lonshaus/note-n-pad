// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// DEV-only: lets the E2E harness park a windowed editor's apply result until it
// releases it, so a result can land after another tab became active.

let holding = false;
let parked: (() => void)[] = [];
/** Park the continuation of every windowed apply result from now on. */
export function holdWindowedResults(on: boolean): void {
  holding = on;
}
/** How many results are parked. */
export function heldWindowedResults(): number {
  return parked.length;
}
/** Let every parked result continue. */
export function releaseWindowedResults(): void {
  const waiting = parked;
  parked = [];
  for (const resume of waiting) {
    resume();
  }
}
/** A promise to await before reporting a result, or null when nothing is held. */
export function parkWindowedResult(): Promise<void> | null {
  if (!holding) {
    return null;
  }
  return new Promise((resolve) => {
    parked.push(resolve);
  });
}
