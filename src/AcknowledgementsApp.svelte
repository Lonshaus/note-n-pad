<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { settingsState } from './lib/state/settings.svelte';
  import { revealWhenThemed } from './lib/util/reveal';
  import { applyTheme, applyChrome } from './lib/theme/applyTheme';
  import { themeRegistry } from './lib/theme/themeRegistry.svelte';
  import { localeRegistry } from './lib/i18n/localeRegistry.svelte';
  import { t } from './lib/i18n';

  /** One third-party package entry, mirroring the Rust `LicensedPackage`.
   *  `texts` holds indices into the sibling `texts` pool rather than the text
   *  itself, since many packages share an identical licence text. */
  interface LicensedPackage {
    name: string;
    version: string;
    ecosystem: string;
    license: string;
    repository: string;
    authors: string[];
    texts: number[];
  }

  /** The `list_acknowledgements` payload: a deduplicated text pool plus every
   *  shipped package pointing into it by index. */
  interface LicenseIndex {
    texts: string[];
    packages: LicensedPackage[];
  }

  let index = $state<LicenseIndex>({ texts: [], packages: [] });
  /** The raw failure detail from `list_acknowledgements`, or null while it has
   *  not failed. Kept untranslated so the message follows a language switch
   *  instead of freezing in whatever language was active when it failed. */
  let loadError = $state<string | null>(null);

  async function loadIndex(): Promise<void> {
    try {
      index = await invoke<LicenseIndex>('list_acknowledgements');
    } catch (e) {
      // Without this the window renders its intro above an empty list, which
      // is indistinguishable from a rendering bug.
      loadError = String(e);
    }
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
    void loadIndex();
    // Reveal the window only after the theme is loaded and applied, so a
    // dark-theme window never flashes its default white background.
    void revealWhenThemed();
    return () => {
      unlistenTheme();
      void unlistenChanges.then((u) => u());
      void unlistenThemes.then((u) => u());
      void unlistenLocales.then((u) => u());
    };
  });
</script>

<main class="acknowledgements">
  <p class="intro">{t('acknowledgements.intro')}</p>
  <p class="canonical-note">{t('acknowledgements.canonicalNote')}</p>
  {#if loadError !== null}
    <p class="error">
      {t('acknowledgements.loadError', { detail: loadError })}
    </p>
  {/if}
  <ul>
    {#each index.packages as pkg (pkg.name + pkg.version)}
      <li>
        <details>
          <summary>
            <span class="name">{pkg.name}</span>
            <span class="version">{pkg.version}</span>
            <span class="tag">{pkg.ecosystem}</span>
            <span class="license">{pkg.license}</span>
          </summary>
          <!-- Keyed by position, not by the pooled-text index. A dual-licensed
               package whose licences share one text points at that text twice,
               and duplicate keys throw at render time, taking the whole
               surrounding each down with them. -->
          {#each pkg.texts as textIndex, i (i)}
            {#if i > 0}
              <hr />
            {/if}
            <pre class="text">{index.texts[textIndex]}</pre>
          {/each}
        </details>
      </li>
    {/each}
  </ul>
</main>

<style>
  .acknowledgements {
    height: 100vh;
    overflow-y: auto;
    box-sizing: border-box;
    padding: 1rem 1.2rem;
    background: var(--bg);
    color: var(--fg);
    font-family: system-ui, sans-serif;
  }
  .intro,
  .canonical-note {
    margin: 0 0 0.7rem;
    font-size: 0.85rem;
    opacity: 0.75;
  }
  .error {
    margin: 0 0 0.7rem;
    color: var(--danger);
    font-size: 0.78rem;
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    border-bottom: 1px solid var(--border, rgba(128, 128, 128, 0.25));
  }
  summary {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    padding: 0.4rem 0;
    cursor: pointer;
    font-size: 0.88rem;
  }
  .name {
    font-weight: 600;
  }
  .version {
    opacity: 0.6;
    font-family: ui-monospace, monospace;
    font-size: 0.8rem;
  }
  .tag {
    padding: 0.05rem 0.4rem;
    border-radius: 0.6rem;
    background: rgba(128, 128, 128, 0.2);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .license {
    margin-left: auto;
    opacity: 0.7;
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
  }
  .text {
    margin: 0 0 0.6rem;
    padding: 0.6rem 0.8rem;
    background: rgba(128, 128, 128, 0.1);
    border-radius: 0.4rem;
    white-space: pre-wrap;
    font-family: ui-monospace, monospace;
    font-size: 0.76rem;
    line-height: 1.4;
  }
  hr {
    margin: 0.5rem 0;
    border: none;
    border-top: 1px dashed rgba(128, 128, 128, 0.3);
  }
</style>
