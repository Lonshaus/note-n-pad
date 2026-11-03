// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// DEV-only: lets the E2E harness park a windowed editor's apply result, or the
// result of a window read, until it releases it, so a result can land after
// another tab became active or a swap can be held half way.

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

let holdingReads = false;
let parkedReads: (() => void)[] = [];
/** Park the result of every window read a swap makes from now on. */
export function holdWindowedReads(on: boolean): void {
  holdingReads = on;
}
/** How many window reads are parked. */
export function heldWindowedReads(): number {
  return parkedReads.length;
}
/** Let every parked window read continue. */
export function releaseWindowedReads(): void {
  const waiting = parkedReads;
  parkedReads = [];
  for (const resume of waiting) {
    resume();
  }
}
/** A promise to await before using a window read, or null when none is held. */
export function parkWindowedRead(): Promise<void> | null {
  if (!holdingReads) {
    return null;
  }
  return new Promise((resolve) => {
    parkedReads.push(resolve);
  });
}

let holdingGlobalOps = false;
let parkedGlobalOps: (() => void)[] = [];
/** Park the result of every global command (a replace of the selection, Enter,
 *  an indent) from now on. */
export function holdGlobalOps(on: boolean): void {
  holdingGlobalOps = on;
}
/** How many global command results are parked. */
export function heldGlobalOps(): number {
  return parkedGlobalOps.length;
}
/** Let every parked global command result continue. */
export function releaseGlobalOps(): void {
  const waiting = parkedGlobalOps;
  parkedGlobalOps = [];
  for (const resume of waiting) {
    resume();
  }
}
/** A promise to await before using a global command's result, or null when
 *  none is held. */
export function parkGlobalOp(): Promise<void> | null {
  if (!holdingGlobalOps) {
    return null;
  }
  return new Promise((resolve) => {
    parkedGlobalOps.push(resolve);
  });
}

let holdingClipStatus = false;
let parkedClipStatus: (() => void)[] = [];
/** Park the result of every `clip_status` a paste asks for from now on. */
export function holdClipStatus(on: boolean): void {
  holdingClipStatus = on;
}
/** Let every parked `clip_status` result continue, and stop parking. */
export function releaseClipStatus(): void {
  holdingClipStatus = false;
  const waiting = parkedClipStatus;
  parkedClipStatus = [];
  for (const resume of waiting) {
    resume();
  }
}
/** A promise to await before using a `clip_status` result, or null when none
 *  is held. */
export function parkClipStatus(): Promise<void> | null {
  if (!holdingClipStatus) {
    return null;
  }
  return new Promise((resolve) => {
    parkedClipStatus.push(resolve);
  });
}
