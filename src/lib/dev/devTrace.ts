// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// DEV-only: one line from the page into the app log, so a page that stops
// answering leaves the place it stopped at.

import { invoke } from '@tauri-apps/api/core';
/** Writes `msg` to the app log; does nothing outside DEV or without the core. */
export function devTrace(msg: string): void {
  if (
    import.meta.env.DEV &&
    typeof window !== 'undefined' &&
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !==
      undefined
  ) {
    invoke('dev_trace', { msg }).catch(() => {});
  }
}
