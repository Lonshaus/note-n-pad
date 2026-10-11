// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
/** One row of the Rust shortcut registry (`get_shortcuts`), localized. */
export interface ShortcutRow {
  id: string;
  section: string;
  label: string;
  /** The key in effect, canonical text; empty when unset. */
  accelerator: string;
  /** The default key; empty when the row has none. */
  default: string;
  customizable: boolean;
}
/** The effective shortcuts, mirrored from the Rust registry. The core owns the
 *  data; this only caches it and keeps it current across `settings-changed`. */
export class ShortcutsState {
  rows = $state<ShortcutRow[]>([]);
  /** Effective key by registry id, canonical text; missing or unset rows are
   *  absent. */
  accelerators: Record<string, string> = $derived(
    Object.fromEntries(
      this.rows
        .filter((row) => row.accelerator !== '')
        .map((row) => [row.id, row.accelerator]),
    ),
  );
  /** The key in effect for `id`, or null when it is unset (or not loaded yet). */
  accel(id: string): string | null {
    return this.accelerators[id] ?? null;
  }

  async load(): Promise<void> {
    this.rows = await invoke<ShortcutRow[]>('get_shortcuts');
  }
  /** Load once and stay current: a change from any window, or a language
   *  switch (the names are localized in the core), arrives as
   *  `settings-changed`. */
  async init(): Promise<UnlistenFn> {
    const unlisten = await listen('settings-changed', () => {
      void this.load();
    });
    await this.load();
    return unlisten;
  }
}

export const shortcutsState = new ShortcutsState();
