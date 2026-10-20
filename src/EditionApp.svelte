<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { settingsState } from './lib/state/settings.svelte';
  import { platform } from './lib/state/platform.svelte';
  import { revealWhenThemed } from './lib/util/reveal';
  import { applyTheme, applyChrome } from './lib/theme/applyTheme';
  import { themeRegistry } from './lib/theme/themeRegistry.svelte';
  import { localeRegistry } from './lib/i18n/localeRegistry.svelte';
  import { nativeSelectAll } from './lib/util/menuBar';
  import {
    editionStatus,
    featureRows,
    storeControls,
    storeMessage,
    type StoreInfo,
    type StoreResult,
  } from './lib/util/editionFeatures';
  import { isLite } from './lib/state/edition.svelte';
  import { t, type I18nKey } from './lib/i18n';
  // Reflect the resolved theme onto the document root.
  $effect(() => {
    applyTheme(settingsState.themeId);
    applyChrome(settingsState.interfaceMode, settingsState.prefersDark);
  });
  // Dock menu or Jump List, whichever this platform has.
  const rows = $derived(featureRows(platform.os));
  // `null` until `store_info` answers, which shows no controls.
  let info = $state<StoreInfo | null>(null);
  let busy = $state(false);
  let message = $state<I18nKey | null>(null);
  const controls = $derived(storeControls(info, isLite()));

  async function loadInfo(): Promise<void> {
    try {
      info = await invoke<StoreInfo>('store_info');
    } catch (e) {
      console.error('edition: could not read the store', e);
    }
  }
  /** Run a purchase or restore; on success the edition turns full and the
   *  controls go with it. */
  async function run(
    command: 'store_purchase' | 'store_restore',
  ): Promise<void> {
    busy = true;
    message = null;
    try {
      message = storeMessage(await invoke<StoreResult>(command));
    } catch (e) {
      console.error(`edition: ${command} failed`, e);
      message = 'edition.store.failed';
    } finally {
      busy = false;
    }
  }

  async function retry(): Promise<void> {
    busy = true;
    try {
      await invoke<string>('store_refresh_original');
      await loadInfo();
    } catch (e) {
      console.error('edition: store_refresh_original failed', e);
    } finally {
      busy = false;
    }
  }

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
    void loadInfo();
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
  <p class="status">{t(editionStatus(isLite()))}</p>
  {#if controls === 'retry'}
    <div class="store">
      <p class="message">{t('edition.store.unreachable')}</p>
      <button class="action" disabled={busy} onclick={() => void retry()}>
        {t('edition.store.retry')}
      </button>
    </div>
  {:else if controls === 'buy'}
    <div class="store">
      <button
        class="action"
        disabled={busy}
        onclick={() => void run('store_purchase')}
      >
        {info === null || info.price === null
          ? t('edition.store.buy')
          : t('edition.store.buyPrice', { price: info.price })}
      </button>
      <button
        class="action"
        disabled={busy}
        onclick={() => void run('store_restore')}
      >
        {t('edition.store.restore')}
      </button>
      {#if message !== null}
        <p class="message">{t(message)}</p>
      {/if}
    </div>
  {/if}
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
    margin-top: 0.9rem;
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
  .status {
    margin: 0.2rem 0.6rem 0;
    font-weight: 600;
  }
  .store {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin: 0.6rem 0.6rem 0;
  }
  .action {
    padding: 0.28rem 1.1rem;
    border: 1px solid color-mix(in srgb, CanvasText 22%, transparent);
    border-radius: 6px;
    background: color-mix(in srgb, CanvasText 6%, Canvas);
    cursor: pointer;
    font: inherit;
    font-size: 0.8rem;
    color: inherit;
  }
  .action:hover:not(:disabled) {
    background: color-mix(in srgb, CanvasText 12%, Canvas);
  }
  .action:disabled {
    cursor: default;
    opacity: 0.5;
  }
  .message {
    flex-basis: 100%;
    margin: 0;
    font-size: 0.78rem;
    opacity: 0.8;
  }
</style>
