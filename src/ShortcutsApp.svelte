<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import { settingsState } from './lib/state/settings.svelte';
  import { platform } from './lib/state/platform.svelte';
  import { revealWhenThemed } from './lib/util/reveal';
  import { applyTheme, applyChrome } from './lib/theme/applyTheme';
  import { themeRegistry } from './lib/theme/themeRegistry.svelte';
  import { localeRegistry } from './lib/i18n/localeRegistry.svelte';
  import { formatAcceleratorSymbols } from './lib/util/accelerator';

  /** One row from the Rust `get_shortcuts` command, already translated into
   *  the current locale. */
  interface ShortcutRow {
    section: string;
    label: string;
    accelerator: string;
  }

  let rows = $state<ShortcutRow[]>([]);

  /** Rows grouped by section, in the order sections first appear — the same
   *  order `ACCELERATOR_TABLE` lists them in on the Rust side. */
  let sections: { section: string; rows: ShortcutRow[] }[] = $derived.by(() => {
    const groups: { section: string; rows: ShortcutRow[] }[] = [];
    for (const row of rows) {
      const group = groups.find((g) => g.section === row.section);
      if (group === undefined) {
        groups.push({ section: row.section, rows: [row] });
      } else {
        group.rows.push(row);
      }
    }
    return groups;
  });

  async function loadShortcuts(): Promise<void> {
    rows = await invoke<ShortcutRow[]>('get_shortcuts');
  }

  // Reflect the resolved theme onto the document root.
  $effect(() => {
    applyTheme(settingsState.themeId);
    applyChrome(settingsState.interfaceMode, settingsState.prefersDark);
  });

  onMount(() => {
    const unlistenTheme = settingsState.listen();
    const unlistenChanges = settingsState.listenChanges();
    const unlistenThemes = themeRegistry.listen();
    const unlistenLocales = localeRegistry.listen();
    // `get_shortcuts` reads the Rust-side language setting directly (the
    // labels are Rust `i18n::Key` strings, not the frontend dictionary), so a
    // language change is caught the same way `save_settings` already keeps
    // every other fixed window current: it broadcasts `settings-changed`,
    // which here triggers a fresh fetch instead of a field assignment.
    const unlistenShortcuts = listen('settings-changed', () => {
      void loadShortcuts();
    });
    void platform.init();
    void loadShortcuts();
    // Reveal the window only after the theme is loaded and applied, so a
    // dark-theme window never flashes its default white background.
    void revealWhenThemed();
    return () => {
      unlistenTheme();
      void unlistenChanges.then((u) => u());
      void unlistenThemes.then((u) => u());
      void unlistenLocales.then((u) => u());
      void unlistenShortcuts.then((u) => u());
    };
  });
</script>

<main class="shortcuts">
  {#each sections as group (group.section)}
    <section>
      <h2>{group.section}</h2>
      <ul>
        {#each group.rows as row (row.label)}
          <li>
            <span class="label">{row.label}</span>
            <span class="accel"
              >{formatAcceleratorSymbols(
                row.accelerator,
                platform.isMacOS,
              )}</span
            >
          </li>
        {/each}
      </ul>
    </section>
  {/each}
</main>

<style>
  .shortcuts {
    height: 100vh;
    overflow-y: auto;
    box-sizing: border-box;
    padding: 1rem 1.2rem;
    background: var(--bg);
    color: var(--fg);
    font-family: system-ui, sans-serif;
  }
  section {
    margin-bottom: 1.1rem;
  }
  h2 {
    margin: 0 0 0.35rem;
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
    opacity: 0.55;
    letter-spacing: 0.04em;
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.3rem 0;
    font-size: 0.88rem;
  }
  .label {
    flex: 1;
  }
  .accel {
    opacity: 0.7;
    font-family: ui-monospace, monospace;
    white-space: nowrap;
  }
</style>
