<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { ask } from '@tauri-apps/plugin-dialog';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { settingsState } from './lib/state/settings.svelte';
  import { revealWhenThemed } from './lib/util/reveal';
  import { applyTheme, applyChrome } from './lib/theme/applyTheme';
  import { themeRegistry } from './lib/theme/themeRegistry.svelte';
  import { localeRegistry } from './lib/i18n/localeRegistry.svelte';
  import { platform } from './lib/state/platform.svelte';
  import { t } from './lib/i18n';
  import { startupSkips } from './lib/state/startupSkips.svelte';
  import { revealKey, skipReasonKey } from './lib/util/skipped';

  const win = getCurrentWindow();
  let failure = $state('');

  $effect(() => {
    applyTheme(settingsState.themeId);
    applyChrome(settingsState.interfaceMode, settingsState.prefersDark);
  });

  async function reveal(name: string): Promise<void> {
    failure = '';
    try {
      await invoke('reveal_data_file', { kind: 'snapshots', name });
    } catch (e) {
      failure = String(e);
    }
  }

  async function remove(name: string): Promise<void> {
    failure = '';
    // Deleting removes the file for good, so confirm first.
    const ok = await ask(t('skipped.deleteConfirm', { name }), {
      title: t('skipped.delete'),
      kind: 'warning',
      // Without these the plugin answers with its own English Yes/No beside a
      // sentence in the user's language. Naming the action rather than
      // translating "yes" also means the button reads on its own.
      okLabel: t('skipped.delete'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) {
      return;
    }
    try {
      await invoke('delete_data_file', { kind: 'snapshots', name });
    } catch (e) {
      failure = String(e);
      return;
    }
    startupSkips.forget(name);
    // Nothing left to act on, so the window has done its job.
    if (startupSkips.items.length === 0) {
      void win.close();
    }
  }

  onMount(() => {
    const unlistenTheme = settingsState.listen();
    const unlistenChanges = settingsState.listenChanges();
    const unlistenThemes = themeRegistry.listen();
    const unlistenLocales = localeRegistry.listen();
    void revealWhenThemed();
    // The core held the list from startup; this window is what it was held for.
    void startupSkips.claim();
    return () => {
      unlistenTheme();
      void unlistenChanges.then((u) => u());
      void unlistenThemes.then((u) => u());
      void unlistenLocales.then((u) => u());
    };
  });
</script>

<main class="problems">
  <!-- Laid out like a system alert: the mark and the two lines that say what
       happened at the top, what the user can act on below, and the dismissal
       in the bottom corner. -->
  <header>
    <svg
      class="mark"
      viewBox="0 0 24 24"
      width="30"
      height="30"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 4L2.5 20.5h19L12 4z" />
      <path d="M12 10v4" />
      <path d="M12 17.5v.2" />
    </svg>
    <div class="said">
      <p class="intro">
        {t('skipped.snapshotHeading', { count: startupSkips.items.length })}
      </p>
      <p class="hint">{t('skipped.windowHint')}</p>
    </div>
  </header>
  <ul>
    {#each startupSkips.items as file (file.name)}
      <li>
        <div class="what">
          <span class="name">{file.name}</span>
          <span class="reason">{t(skipReasonKey(file.reason))}</span>
        </div>
        <div class="row-actions">
          <button class="link" onclick={() => void reveal(file.name)}>
            {t(revealKey(platform))}
          </button>
          <button class="link danger" onclick={() => void remove(file.name)}>
            {t('skipped.delete')}
          </button>
        </div>
      </li>
    {/each}
  </ul>
  <footer>
    {#if failure !== ''}
      <p class="failure">{failure}</p>
    {/if}
    <button class="close" onclick={() => void win.close()}>
      {t('common.close')}
    </button>
  </footer>
</main>

<style>
  .problems {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    box-sizing: border-box;
    height: 100vh;
    padding: 1.1rem 1.2rem 0.9rem;
    background: var(--bg);
    color: var(--fg);
    font-size: 0.85rem;
  }
  header {
    display: flex;
    align-items: flex-start;
    gap: 0.8rem;
  }
  .mark {
    flex-shrink: 0;
    margin-top: 0.1rem;
    color: var(--danger);
  }
  .said {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }
  .intro {
    margin: 0;
    font-size: 0.92rem;
    font-weight: 600;
  }
  .hint {
    margin: 0;
    opacity: 0.7;
    font-size: 0.78rem;
    line-height: 1.4;
  }
  footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.75rem;
  }
  .close {
    padding: 0.28rem 1.1rem;
    border: 1px solid color-mix(in srgb, CanvasText 22%, transparent);
    border-radius: 6px;
    background: color-mix(in srgb, CanvasText 6%, Canvas);
    cursor: pointer;
    font: inherit;
    font-size: 0.8rem;
    color: inherit;
  }
  .close:hover {
    background: color-mix(in srgb, CanvasText 12%, Canvas);
  }
  ul {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 0.15rem;
    margin: 0.2rem 0 0;
    padding: 0;
    list-style: none;
    /* The window is resizable and this is the only part that should grow, so
       the list scrolls rather than the page. */
    overflow-y: auto;
  }
  li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.45rem 0.15rem;
  }
  li + li {
    border-top: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
  }
  .what {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
  }
  .name {
    /* Wraps rather than truncates: this is the name the reader has to go and
       find on disk, and an ellipsis hides the part that identifies a copy. */
    overflow-wrap: anywhere;
    font-size: 0.82rem;
  }
  .reason {
    font-size: 0.75rem;
    opacity: 0.65;
  }
  .row-actions {
    display: flex;
    flex-shrink: 0;
    gap: 0.5rem;
  }
  .link {
    padding: 0.18rem 0.55rem;
    border: 1px solid transparent;
    border-radius: 999px;
    background: none;
    cursor: pointer;
    font: inherit;
    font-size: 0.75rem;
    white-space: nowrap;
    color: var(--accent);
    transition:
      background-color 120ms ease,
      border-color 120ms ease;
  }
  .link:hover {
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  .link.danger {
    color: var(--danger);
  }
  .link.danger:hover {
    border-color: color-mix(in srgb, var(--danger) 40%, transparent);
    background: color-mix(in srgb, var(--danger) 14%, transparent);
  }
  .failure {
    flex: 1;
    margin: 0;
    color: var(--danger);
    font-size: 0.78rem;
  }
</style>
