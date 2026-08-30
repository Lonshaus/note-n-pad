// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import type { PinMode } from '../state/stickyNote.svelte';

/** Whether a sticky should float always-on-top the moment a pin is applied.
 *  `top` always floats. `app` floats immediately only when foreground-app
 *  follow tracking is unavailable (e.g. Wayland), where it degrades to
 *  permanent on-top; when tracking works the 500 ms poller decides per
 *  frontmost app, so the sticky starts un-floated. Mirrors the Rust
 *  `create_sticky_window` on_top rule (available → follow, unavailable → true). */
export function shouldFloatOnTop(
  mode: PinMode,
  followUnavailable: boolean,
): boolean {
  return mode === 'top' || (mode === 'app' && followUnavailable);
}
