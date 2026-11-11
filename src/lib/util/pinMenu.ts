// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import type { PinMode } from '../state/stickyNote.svelte';

/** The pin mode a sticky shows and acts on. Pin to app is a full-edition
 *  feature, so a stored app pin reads as unpinned while Lite; the stored mode
 *  itself is left alone and applies again once the edition is full. */
export function effectivePinMode(mode: PinMode, lite: boolean): PinMode {
  return lite && mode === 'app' ? 'none' : mode;
}

/** Whether the pin menu lists running apps (the "Pin to app" section). */
export function pinMenuHasApps(lite: boolean): boolean {
  return !lite;
}
