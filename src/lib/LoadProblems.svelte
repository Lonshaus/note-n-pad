<!-- Copyright © 2026 Lonshaus -->
<!-- SPDX-License-Identifier: GPL-3.0-only -->
<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { ask } from '@tauri-apps/plugin-dialog';
  import { t } from './i18n';
  import { platform } from './state/platform.svelte';
  import type { DataKind, SkippedFile } from './util/protocol';
  import { revealKey, skipReasonKey } from './util/skipped';

  interface Props {
    /** What the store passed over. Empty renders nothing at all. */
    items: SkippedFile[];
    /** Which folder the names belong to; the core resolves it from this. */
    kind: DataKind;
    /** Whether each row offers reveal and delete. A theme that fails to load
     *  was just placed in the folder by hand, so its location is already
     *  known; a locale or a snapshot sits somewhere never visited. */
    actions: boolean;
    /** Called with the file name after a successful delete, so the caller can
     *  reload its list or drop that one row. */
    onchanged?: (name: string) => void;
  }

  let { items, kind, actions, onchanged }: Props = $props();

  let failure = $state('');
  let open = $state(false);

  /** Close on Escape and on a click anywhere outside, the way a popover
   *  behaves: the list floats over the layout, so nothing else can be reached
   *  through it and there is no visible boundary telling the reader that. */
  function dismissOn(node: HTMLElement): { destroy: () => void } {
    const onPointer = (e: MouseEvent) => {
      if (open && !node.contains(e.target as Node)) {
        open = false;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        open = false;
      }
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return {
      destroy() {
        document.removeEventListener('pointerdown', onPointer, true);
        document.removeEventListener('keydown', onKey, true);
      },
    };
  }

  async function reveal(name: string): Promise<void> {
    failure = '';
    try {
      await invoke('reveal_data_file', { kind, name });
    } catch (e) {
      failure = String(e);
    }
  }

  async function remove(name: string): Promise<void> {
    failure = '';
    // Deleting removes the file for good, so confirm first — same treatment as
    // the theme and locale deletes this panel sits under.
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
      await invoke('delete_data_file', { kind, name });
    } catch (e) {
      failure = String(e);
      return;
    }
    onchanged?.(name);
  }
</script>

{#if items.length > 0}
  <div class="load-problems" use:dismissOn>
    <!-- The list floats over the layout instead of taking height in it: this
         column has a fixed height and a parent that clips, so an inline list
         would squeeze the language list above it and still lose its last rows
         off the window edge. -->
    <button
      class="summary error"
      aria-expanded={open}
      onclick={() => (open = !open)}
    >
      {t('skipped.heading', { count: items.length })}
    </button>
    {#if open}
      <span class="arrow" aria-hidden="true"></span>
      <ul>
        {#each items as file (file.name)}
          <li>
            <div class="what">
              <span class="name" title={file.name}>{file.name}</span>
              <span class="reason">{t(skipReasonKey(file.reason))}</span>
            </div>
            {#if actions}
              <div class="row-actions">
                <button class="link" onclick={() => void reveal(file.name)}>
                  {t(revealKey(platform))}
                </button>
                <button
                  class="link danger"
                  onclick={() => void remove(file.name)}
                >
                  {t('skipped.delete')}
                </button>
              </div>
            {/if}
          </li>
        {/each}
        {#if failure !== ''}
          <li class="error">{failure}</li>
        {/if}
      </ul>
    {/if}
  </div>
{/if}

<style>
  .load-problems {
    position: relative;
    margin-top: 0.5rem;
  }
  .summary {
    /* A button for the keyboard and for screen readers, drawn as the plain
       line of text it looks like. */
    display: block;
    width: 100%;
    padding: 0;
    border: none;
    background: none;
    text-align: left;
    cursor: pointer;
    font: inherit;
  }
  .error {
    color: var(--danger);
    font-size: 0.78rem;
  }
  ul {
    position: absolute;
    /* This project has no global `box-sizing: border-box`, so without this the
       padding and border are added on top of max-height and the popover ends
       up taller than the space it was capped to. */
    box-sizing: border-box;
    left: 0;
    /* A popover is not bound to the width of the thing it points at. This
       column is 250px, and two action chips would leave the file name almost
       no room, so the list grows to fit its content and only wraps back when
       it would leave the window. */
    min-width: 100%;
    width: max-content;
    max-width: calc(100vw - 2rem);
    /* Opens upward: this block is the last thing in its column, so downward
       would run past the window edge, where the clipping parent would eat the
       rows instead of scrolling to them. The gap leaves room for the arrow. */
    bottom: calc(100% + 0.55rem);
    z-index: 5;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin: 0;
    padding: 0.6rem;
    list-style: none;
    border: 1px solid var(--topbar-border);
    border-radius: 10px;
    /* Lifted off the panel behind it rather than painted in the same colour,
       which is what made the first attempt read as part of the column. */
    background: color-mix(in srgb, CanvasText 6%, Canvas);
    box-shadow:
      0 10px 30px rgb(0 0 0 / 30%),
      0 2px 6px rgb(0 0 0 / 18%);
    /* Grows with its content, capped at the space above it so the top row
       stays on screen. Only a folder holding more unusable files than fit in a
       whole window reaches the cap. */
    max-height: calc(100vh - 5rem);
    overflow-y: auto;
  }
  /* The arrow, drawn as a rotated square so its two visible edges keep the
     popover's own border and background. */
  .arrow {
    position: absolute;
    bottom: calc(100% + 0.25rem);
    left: 1.1rem;
    width: 0.6rem;
    height: 0.6rem;
    z-index: 6;
    transform: rotate(45deg);
    border-right: 1px solid var(--topbar-border);
    border-bottom: 1px solid var(--topbar-border);
    background: color-mix(in srgb, CanvasText 6%, Canvas);
  }
  li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.35rem 0.15rem;
  }
  /* Hairline between rows, none after the last: ten identical rows with no
     separation was the unreadable part. */
  li + li {
    border-top: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
  }
  .what {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    /* Required for the name's ellipsis to work inside a flex row. */
    min-width: 0;
  }
  .name {
    /* Wraps rather than truncates: this is the name the reader has to go and
       find on disk, and an ellipsis in the middle of `note (conflicted
       copy).json` hides exactly the part that identifies it. */
    overflow-wrap: anywhere;
    font-size: 0.8rem;
  }
  .reason {
    font-size: 0.72rem;
    opacity: 0.6;
  }
  .row-actions {
    display: flex;
    flex-shrink: 0;
    gap: 0.6rem;
  }
  /* Quiet chips rather than filled buttons: two solid buttons on every one of
     ten rows read as a wall of controls, and a bare underlined link reads as
     unfinished. These carry their colour only until pointed at, then fill. */
  .link {
    padding: 0.16rem 0.5rem;
    border: 1px solid transparent;
    border-radius: 999px;
    background: none;
    cursor: pointer;
    font: inherit;
    font-size: 0.72rem;
    line-height: 1.3;
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
  .link:active {
    background: color-mix(in srgb, var(--accent) 26%, transparent);
  }
  .link.danger {
    color: var(--danger);
  }
  .link.danger:hover {
    border-color: color-mix(in srgb, var(--danger) 40%, transparent);
    background: color-mix(in srgb, var(--danger) 14%, transparent);
  }
  .link.danger:active {
    background: color-mix(in srgb, var(--danger) 26%, transparent);
  }
</style>
