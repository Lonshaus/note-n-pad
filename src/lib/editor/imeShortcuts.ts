// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// The effective Undo and Save keys as the macOS composition handlers see them.

import { shortcutsState } from '../state/shortcuts.svelte';
import { platform } from '../state/platform.svelte';
import { matchWindowShortcut } from '../util/windowShortcut';
/** Whether `event` is the key currently bound to registry item `id`. */
function matchesEffective(id: string, event: KeyboardEvent): boolean {
  const accel = shortcutsState.accel(id);
  return accel !== null && matchWindowShortcut(event, accel, platform.os);
}
export function isUndoKey(event: KeyboardEvent): boolean {
  return matchesEffective('menu.undo', event);
}
export function isSaveKey(event: KeyboardEvent): boolean {
  return matchesEffective('menu.save', event);
}
