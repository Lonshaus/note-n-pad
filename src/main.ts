// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { mount } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import './app.css';
import StickyApp from './StickyApp.svelte';
import DocumentApp from './DocumentApp.svelte';
import WorkspaceApp from './WorkspaceApp.svelte';
import SettingsApp from './SettingsApp.svelte';
import AboutApp from './AboutApp.svelte';
import AcknowledgementsApp from './AcknowledgementsApp.svelte';
import LoadProblemsApp from './LoadProblemsApp.svelte';
import PrivacyApp from './PrivacyApp.svelte';
import { platform } from './lib/state/platform.svelte';
import { shortcutsState } from './lib/state/shortcuts.svelte';
import { matchMenuAccelerator } from './lib/util/menuAccelerator';

const mode = new URLSearchParams(window.location.search).get('mode');
const Component =
  mode === 'document'
    ? DocumentApp
    : mode === 'workspace'
      ? WorkspaceApp
      : mode === 'settings'
        ? SettingsApp
        : mode === 'about'
          ? AboutApp
          : mode === 'acknowledgements'
            ? AcknowledgementsApp
            : mode === 'loadProblems'
              ? LoadProblemsApp
              : mode === 'privacy'
                ? PrivacyApp
                : StickyApp;

// Sticky and workspace windows render on an OS-transparent surface; flag the
// root so the page chrome behind the rounded card stays transparent.
if (Component === StickyApp) {
  document.documentElement.classList.add('transparent-window');
}

const app = mount(Component, {
  target: document.getElementById('app')!,
});
// The effective shortcuts, for the editors and the window-scoped handlers; they
// follow `settings-changed` from here on.
void shortcutsState.init();

// Windows only: WebView2 keyboard input never reaches Tauri's native
// accelerator table, so every window mode needs one bubble-phase listener
// that runs a menu command directly instead. Bubble phase plus the
// `defaultPrevented` check in `matchMenuAccelerator` means a combo CodeMirror
// (or another handler) already claimed, such as Ctrl+F or Ctrl+G, is left
// alone. `get_menu_accelerators` (not `get_shortcuts`) is used deliberately:
// it lists only the native menu items, so the frontend-only shortcuts (tab
// switching, go to line) are never intercepted here. The list is fetched
// again whenever the settings change, since the user can move a menu key.
void (async (): Promise<void> => {
  await platform.init();
  if (!platform.isWindows) {
    return;
  }
  let table = await invoke<string[]>('get_menu_accelerators');
  void listen('settings-changed', () => {
    void invoke<string[]>('get_menu_accelerators').then((next) => {
      table = next;
    });
  });
  window.addEventListener('keydown', (event) => {
    const accelerator = matchMenuAccelerator(event, platform.os, table);
    if (accelerator === null) {
      return;
    }
    event.preventDefault();
    void invoke('trigger_menu_accelerator', { accelerator });
  });
})();

export default app;
