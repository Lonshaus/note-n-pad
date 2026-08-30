// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { invoke } from '@tauri-apps/api/core';
import type { SkippedFile } from '../util/protocol';

/** The snapshot files the core could not load at startup, claimed by whichever
 *  window takes focus first.
 *
 *  Snapshots are read inside Tauri's `setup`, before a single window exists, so
 *  the core holds the list until something asks. It hands the list over once,
 *  which is what keeps the report from appearing in every window that is later
 *  clicked. */
class StartupSkips {
  items = $state<SkippedFile[]>([]);
  /** True while a request is in flight, so two focus events cannot both ask. */
  private asking = false;
  /** Ask the core, unless this window already holds the list or is mid-request.
   *  Only the report window asks, and it asks once when it mounts — the core is
   *  what decides there is anything to report, by opening that window at all. */
  async claim(): Promise<void> {
    if (this.asking || this.items.length > 0) {
      return;
    }
    this.asking = true;
    try {
      const taken = await invoke<SkippedFile[] | null>('take_startup_skips');
      if (taken !== null) {
        this.items = taken;
      }
    } finally {
      this.asking = false;
    }
  }

  /** Drop one row after its file has been deleted. The list cannot be reloaded
   *  from the core — it was handed over once — so it is edited in place. */
  forget(name: string): void {
    this.items = this.items.filter((f) => f.name !== name);
  }
}

export const startupSkips = new StartupSkips();
