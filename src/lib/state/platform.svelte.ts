// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { invoke } from '@tauri-apps/api/core';
import { guessOsFromUserAgent } from '../util/guessOs';

/** Host platform facts from the Rust core, resolved once at window startup. */
interface PlatformInfo {
  os: string;
  session: string;
}

/** Shared, reactive host-platform info. `os` is `std::env::consts::OS`
 *  (`macos` / `windows` / `linux`); `session` is the lowercased
 *  `XDG_SESSION_TYPE` on Linux (`wayland` / `x11`), empty elsewhere. */
class PlatformState {
  // Seeded synchronously from the webview's UA so `isMacOS`/`isLinux` are
  // already correct on the very first render, closing the race window before
  // `init()`'s async IPC round-trip resolves (see StickyApp's Linux-only
  // keyboard handler, which needs `isLinux` right from mount). `init()`
  // below always overwrites this guess with the authoritative Rust value.
  // An unrecognized UA guesses `null`, seeded here as '' — a value none of
  // isMacOS/isLinux/isWindows match, so it fails closed (no shortcuts) rather
  // than falling open onto the most permissive branch.
  os = $state<string>(guessOsFromUserAgent(navigator.userAgent) ?? '');
  session = $state('');

  async init(): Promise<void> {
    const info = await invoke<PlatformInfo>('platform_info');
    this.os = info.os;
    this.session = info.session;
  }

  get isMacOS(): boolean {
    return this.os === 'macos';
  }

  get isLinux(): boolean {
    return this.os === 'linux';
  }

  get isWindows(): boolean {
    return this.os === 'windows';
  }

  /** True on a Linux Wayland session, where per-app pin follow-along is not
   *  available and app-pinned stickies stay permanently on top. */
  get isLinuxWayland(): boolean {
    return this.os === 'linux' && this.session === 'wayland';
  }
}

export const platform = new PlatformState();
