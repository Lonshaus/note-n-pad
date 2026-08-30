// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { mount } from 'svelte';
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

export default app;
