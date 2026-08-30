// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

export type HostOs = 'macos' | 'windows' | 'linux';

/** Best-effort host OS guess from the webview's UA string, synchronously
 *  available at first render — before `platform.init()`'s async
 *  `platform_info` IPC round-trip resolves the authoritative value from the
 *  Rust core. This app only ships for these three desktops. An unrecognized
 *  UA (including an empty string) returns `null` rather than guessing —
 *  Linux is the branch `matchStickyShortcut` fires the most shortcuts on, so
 *  guessing it for an unknown UA would fail open instead of closed; `null`
 *  is treated the same as macOS (no shortcuts) until `platform.init()`
 *  resolves the authoritative value. */
export function guessOsFromUserAgent(userAgent: string): HostOs | null {
  if (userAgent.includes('Windows')) {
    return 'windows';
  }
  if (userAgent.includes('Macintosh') || userAgent.includes('Mac OS')) {
    return 'macos';
  }
  if (userAgent.includes('Linux')) {
    return 'linux';
  }
  return null;
}
