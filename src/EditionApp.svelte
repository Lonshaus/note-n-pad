<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import { onMount } from 'svelte';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { settingsState } from './lib/state/settings.svelte';
  import { platform } from './lib/state/platform.svelte';
  import { revealWhenThemed } from './lib/util/reveal';
  import { applyTheme, applyChrome } from './lib/theme/applyTheme';
  import { themeRegistry } from './lib/theme/themeRegistry.svelte';
  import { localeRegistry } from './lib/i18n/localeRegistry.svelte';
  import { nativeSelectAll } from './lib/util/menuBar';
  import { featureRows } from './lib/util/editionFeatures';
  import { t } from './lib/i18n';

  // Reflect the resolved theme onto the document root.
  $effect(() => {
    applyTheme(settingsState.themeId);
    applyChrome(settingsState.interfaceMode, settingsState.prefersDark);
  });
  // Dock menu or Jump List, whichever this platform has.
  const rows = $derived(featureRows(platform.os));

  onMount(() => {
    const unlistenTheme = settingsState.listen();
    const unlistenChanges = settingsState.listenChanges();
    const unlistenThemes = themeRegistry.listen();
    const unlistenLocales = localeRegistry.listen();
    // Edit > Select All reaches the focused window as a menu action (the macOS
    // item is no longer native); this page's text is selectable.
    const unlistenMenuAction = getCurrentWindow().listen<string>(
      'menu-action',
      (event) => {
        if (event.payload === 'select-all') {
          nativeSelectAll();
        }
      },
    );
    void platform.init();
    // Reveal the window only after the theme is loaded and applied, so a
    // dark-theme window never flashes its default white background.
    void revealWhenThemed();
    return () => {
      unlistenTheme();
      void unlistenChanges.then((u) => u());
      void unlistenThemes.then((u) => u());
      void unlistenLocales.then((u) => u());
      void unlistenMenuAction.then((u) => u());
    };
  });
</script>

<main class="edition">
  <table>
    <thead>
      <tr>
        <th class="feature" scope="col">{t('edition.col.feature')}</th>
        <th class="mark" scope="col">{t('edition.col.lite')}</th>
        <th class="mark" scope="col">{t('edition.col.full')}</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as row (row.label)}
        <tr>
          <th class="feature" scope="row">
            {t(row.label)}
            {#if row.note !== undefined}
              <span class="note">{t(row.note)}</span>
            {/if}
          </th>
          <td class="mark">
            {#if row.lite}
              <span aria-label={t('edition.mark.yes')}>✓</span>
            {:else}
              <span class="no" aria-label={t('edition.mark.no')}>—</span>
            {/if}
          </td>
          <td class="mark">
            <span aria-label={t('edition.mark.yes')}>✓</span>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</main>

<style>
  .edition {
    box-sizing: border-box;
    height: 100vh;
    overflow-y: auto;
    padding: 1rem 1.2rem;
    background: var(--bg);
    color: var(--fg);
    font-family: system-ui, sans-serif;
    font-size: 0.9rem;
    user-select: text;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th,
  td {
    padding: 0.5rem 0.6rem;
    border-bottom: 1px solid var(--topbar-border);
    vertical-align: top;
  }
  thead th {
    font-size: 0.8rem;
    opacity: 0.7;
  }
  .feature {
    text-align: left;
    font-weight: 400;
  }
  thead .feature {
    font-weight: 600;
  }
  .mark {
    width: 6.5rem;
    text-align: center;
  }
  .no {
    opacity: 0.45;
  }
  .note {
    display: block;
    margin-top: 0.2rem;
    font-size: 0.78rem;
    opacity: 0.65;
  }
</style>
