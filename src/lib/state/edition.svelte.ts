// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** Whether this is the Lite edition (the Store build while its license
 *  is a trial). The Rust core owns the answer
 *  (`edition::is_lite`); this mirrors it: read once through `edition_info`,
 *  then following `edition-changed`. Starts lite (fail-safe), but `ready()`
 *  settles it, so anything that restores or opens documents awaits that first. */
export class EditionState {
  lite = $state(true);
  #ready: Promise<void> | null = null;
  // An event is newer than any read still in flight, so it must win.
  #changedByEvent = false;
  #listeners = new Set<(lite: boolean) => void>();

  /** Run `callback` with the new value each time `edition-changed` arrives.
   *  For work a `$derived` cannot do (loading tabs a lite session kept).
   *  Returns the unsubscribe. */
  onChanged(callback: (lite: boolean) => void): () => void {
    this.#listeners.add(callback);
    return () => {
      this.#listeners.delete(callback);
    };
  }

  /** Resolves once the value is settled and the change listener is up.
   *  Idempotent: every window and every caller shares one load. */
  ready(): Promise<void> {
    this.#ready ??= this.#load();
    return this.#ready;
  }

  async #load(): Promise<void> {
    try {
      await listen<boolean>('edition-changed', (event) => {
        this.#changedByEvent = true;
        this.lite = event.payload;
        for (const callback of this.#listeners) {
          callback(event.payload);
        }
      });
      const lite = await invoke<boolean>('edition_info');
      if (!this.#changedByEvent) {
        this.lite = lite;
      }
    } catch (e) {
      // Stays lite: the fail-safe value.
      console.error('edition: could not read the edition', e);
    }
  }
}

export const editionState = new EditionState();

/** Whether the Lite edition's cuts apply right now: the runtime value, which a
 *  license change can flip without a restart. Reactive through
 *  `editionState.lite` when read inside `$derived`, `$effect` or a template. */
export function isLite(): boolean {
  return editionState.lite;
}
