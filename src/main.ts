// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { mount } from 'svelte';
import { invoke } from '@tauri-apps/api/core';
import './app.css';
import StickyApp from './StickyApp.svelte';
import DocumentApp from './DocumentApp.svelte';
import WorkspaceApp from './WorkspaceApp.svelte';
import SettingsApp from './SettingsApp.svelte';
import AboutApp from './AboutApp.svelte';
import ShortcutsApp from './ShortcutsApp.svelte';
import AcknowledgementsApp from './AcknowledgementsApp.svelte';
import LoadProblemsApp from './LoadProblemsApp.svelte';
import PrivacyApp from './PrivacyApp.svelte';
import { platform } from './lib/state/platform.svelte';
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
          : mode === 'shortcuts'
            ? ShortcutsApp
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

// Windows only: WebView2 keyboard input never reaches Tauri's native
// accelerator table, so every window mode needs one bubble-phase listener
// that runs a menu command directly instead. Bubble phase plus the
// `defaultPrevented` check in `matchMenuAccelerator` means a combo CodeMirror
// (or another handler) already claimed, such as Ctrl+F or Ctrl+G, is left
// alone. `get_menu_accelerators` (not `get_shortcuts`) is used deliberately:
// it excludes the frontend-only NON_MENU_SHORTCUTS bindings (e.g. Ctrl+L),
// which must never be intercepted here.
void (async (): Promise<void> => {
  await platform.init();
  if (!platform.isWindows) {
    return;
  }
  const table = await invoke<string[]>('get_menu_accelerators');
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
