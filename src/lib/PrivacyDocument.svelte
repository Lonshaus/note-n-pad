<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { Text } from '@codemirror/state';
  import { settingsState } from './state/settings.svelte';
  import { t } from './i18n';
  import MarkdownView from './preview/markdown/MarkdownView.svelte';

  let policy = $state<Text>(Text.empty);
  /** The raw failure detail from `read_privacy_policy`, or null while it has
   *  not failed. Kept untranslated so the message follows a language switch
   *  instead of freezing in whatever language was active when it failed. */
  let loadError = $state<string | null>(null);

  // The document the core hands back depends on the interface language, so the
  // fetch belongs to a component the caller remounts on a language change
  // rather than to an effect that would have to write $state.
  onMount(() => {
    void (async () => {
      try {
        const text = await invoke<string>('read_privacy_policy');
        policy = Text.of(text.split('\n'));
      } catch (e) {
        // Without this the window renders empty, which is indistinguishable
        // from a rendering bug.
        loadError = String(e);
      }
    })();
  });
</script>

{#if loadError !== null}
  <p class="error">{t('privacy.loadError', { detail: loadError })}</p>
{:else}
  <MarkdownView
    doc={policy}
    dark={settingsState.isDark}
    baseDir={null}
    registeredBase={null}
    allowExternalLinks={true}
  />
{/if}

<style>
  .error {
    margin: 0;
    padding: 1rem 1.2rem;
    color: var(--danger);
    font-size: 0.85rem;
  }
</style>
