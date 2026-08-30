<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import { onMount } from 'svelte';
  import { getVersion } from '@tauri-apps/api/app';
  import { settingsState } from './lib/state/settings.svelte';
  import { revealWhenThemed } from './lib/util/reveal';
  import { applyTheme, applyChrome } from './lib/theme/applyTheme';
  import { themeRegistry } from './lib/theme/themeRegistry.svelte';
  import { localeRegistry } from './lib/i18n/localeRegistry.svelte';
  import { t } from './lib/i18n';

  let version = $state('');

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
    // Reveal the window only after the theme is loaded and applied, so a
    // dark-theme window never flashes its default white background.
    void revealWhenThemed();
    void getVersion().then((v) => {
      version = v;
    });
    return () => {
      unlistenTheme();
      void unlistenChanges.then((u) => u());
      void unlistenThemes.then((u) => u());
      void unlistenLocales.then((u) => u());
    };
  });
</script>

<main class="about">
  <h1 class="name">Note&amp;Pad</h1>
  <p class="version">{t('about.version', { version })}</p>
  <p class="desc">{t('about.desc')}</p>
  <p class="license">
    {t('about.license')}<br />
    <span class="spdx">SPDX-License-Identifier: GPL-3.0-only</span>
  </p>
</main>

<style>
  .about {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    height: 100vh;
    padding: 1.2rem;
    box-sizing: border-box;
    text-align: center;
    background: var(--bg);
    color: var(--fg);
    font-family: system-ui, sans-serif;
  }
  .name {
    margin: 0;
    font-size: 1.4rem;
    font-weight: 600;
  }
  .version {
    margin: 0;
    font-size: 0.85rem;
    opacity: 0.6;
  }
  .desc {
    margin: 0.3rem 0 0;
    font-size: 0.9rem;
  }
  .license {
    margin: 0.4rem 0 0;
    font-size: 0.78rem;
    line-height: 1.5;
    opacity: 0.7;
  }
  .spdx {
    font-family: ui-monospace, monospace;
    font-size: 0.72rem;
    opacity: 0.85;
  }
</style>
