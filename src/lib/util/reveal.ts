// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { tick } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import { settingsState } from '../state/settings.svelte';
import { themeRegistry } from '../theme/themeRegistry.svelte';
import { localeRegistry } from '../i18n/localeRegistry.svelte';

/** Reveal the current window once its theme is resolved and applied to the
 *  document root, so a dark-theme window never flashes its default white
 *  background. Windows are created hidden (`.visible(false)`) in the Rust core;
 *  call this from onMount after registering the OS color-scheme listener.
 *  Awaits the saved theme load, flushes the reactive effect that stamps
 *  data-theme onto the root, then reveals. Goes through the `reveal_self` command
 *  (not a bare show()) because on macOS show() alone leaves the WKWebView off the
 *  responder chain, so real keystrokes are dropped until a click; the command
 *  pairs show() with set_focus(). Both are idempotent. */
export async function revealWhenThemed(): Promise<void> {
  // Load custom themes and data locales before settings, so a stored custom
  // theme id or data-locale language resolves instead of falling back — the
  // settings derivations (resolvedLocale, theme) read both registries.
  await themeRegistry.load();
  await localeRegistry.load();
  await settingsState.init();
  await tick();
  repaintNativeSelects();
  await invoke('reveal_self');
}

/** A native `<select>`'s closed box can keep showing the text its selected
 *  `<option>` was first painted with even after `tick()` above has updated
 *  the option's textContent — WKWebView caches the drawn label separately
 *  from the DOM and only re-draws it on a style/layout change, which a plain
 *  text update does not trigger when the selected value itself is unchanged
 *  (e.g. the language resolves from the OS default to a stored setting
 *  before this window is ever shown, but the select's value stays the same
 *  either way). Toggling `display` forces WKWebView to rebuild the control
 *  from the current DOM text. No-op where there is no `<select>` on the page. */
function repaintNativeSelects(): void {
  for (const select of document.querySelectorAll('select')) {
    const el = select as HTMLSelectElement;
    el.style.display = 'none';
    void el.offsetHeight;
    el.style.removeProperty('display');
  }
}
