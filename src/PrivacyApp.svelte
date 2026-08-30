<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import { onMount } from 'svelte';
  import { settingsState } from './lib/state/settings.svelte';
  import { revealWhenThemed } from './lib/util/reveal';
  import { applyTheme, applyChrome } from './lib/theme/applyTheme';
  import { themeRegistry } from './lib/theme/themeRegistry.svelte';
  import { localeRegistry } from './lib/i18n/localeRegistry.svelte';
  import PrivacyDocument from './lib/PrivacyDocument.svelte';

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
    return () => {
      unlistenTheme();
      void unlistenChanges.then((u) => u());
      void unlistenThemes.then((u) => u());
      void unlistenLocales.then((u) => u());
    };
  });
</script>

<main class="privacy">
  <!-- Which of the three documents the core returns is decided by the
       interface language, so switching language has to fetch again. Keying the
       child on the resolved locale remounts it, which reloads without an
       effect writing state. -->
  {#key settingsState.resolvedLocale}
    <PrivacyDocument />
  {/key}
</main>

<style>
  .privacy {
    position: relative;
    height: 100vh;
    box-sizing: border-box;
    background: var(--bg);
    color: var(--fg);
  }
  /* The preview gives its first block a top margin, which separates it from
     whatever came before inside a document. Nothing comes before this one: the
     window opens on the policy's title and the margin is a gap under the title
     bar. Matched on the offset the preview writes when its window starts at the
     document's first block, because `:first-child` alone is the first block
     *rendered* — which is a different one at every scroll position, and
     stripping its margin there would shift the text while scrolling. */
  .privacy
    :global(
      .markdown-view > .spacer > .blocks[style^='top: 0px'] > :first-child
    ) {
    margin-top: 0;
  }
</style>
