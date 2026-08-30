// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Live-activeness signal for worker-based syntax highlighting of oversized
 *  documents.
 *
 *  The enable flag itself lives in `settingsState.workerHighlight`; this module
 *  only reads it, so it still imports no editor engine and can be read reactively
 *  from Svelte components. Off by default, so large files stay uncolored unless
 *  the user opts in. */
import { settingsState } from '../state/settings.svelte';

/** Number of live views currently running a worker-highlight session. With one
 *  editor view per window this is 0 or 1, so it doubles as "the active tab is
 *  highlighting via the worker". Deliberately NOT reactive ($state): it is only
 *  polled by the DEV automation surface, and its writers run synchronously
 *  inside the worker-compartment $effect's dispatch (plugin ctor/destroy) — a
 *  reactive write there trips Svelte's effect_update_depth loop guard and gets
 *  the effect torn down, killing live enable/disable. */
let activeCount = 0;

export function isWorkerHighlightEnabled(): boolean {
  return settingsState.workerHighlight;
}

/** True while at least one editor view is highlighting through the worker. */
export function isWorkerHighlightActive(): boolean {
  return activeCount > 0;
}

/** Called by the CM plugin when it starts driving a view. */
export function markWorkerActive(): void {
  activeCount += 1;
}

/** Called by the CM plugin when its view is torn down. */
export function markWorkerInactive(): void {
  activeCount -= 1;
}
