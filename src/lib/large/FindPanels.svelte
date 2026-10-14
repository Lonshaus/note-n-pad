<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only
  // The find bar (with its results list) and the go-to-line box that float over
  // a large file. Shared by the read-only viewer and the editing mode, which
  // adds a Replace row. The parent owns every piece of state; this renders it.

  import { t } from '../i18n';
  import { TEXT_FIELD_ATTRS } from '../editor/textFieldAttrs';
  import { matchSegments } from '../util/matchSegments';
  /** One result row: `line` is 1-based, as displayed. */
  export interface FindResult {
    line: number;
    preview: string;
  }

  interface Props {
    // Goto and search are mutually exclusive: only one is ever open.
    panel: 'none' | 'goto' | 'search';
    gotoValue: string;
    ongotokeydown: (e: KeyboardEvent) => void;
    query: string;
    caseSensitive: boolean;
    // Shown and used only when `showReplace` is set.
    replacement?: string;
    showReplace?: boolean;
    status: string;
    results: FindResult[];
    cursor: number;
    // The query and case the shown results were searched with, for highlighting.
    resultQuery: string;
    resultCase: boolean;
    onsearch: () => void;
    onjump: (index: number) => void;
    onclose: () => void;
    onsearchkeydown: (e: KeyboardEvent) => void;
    onreplace?: () => void;
    onreplaceall?: () => void;
  }

  let {
    panel,
    gotoValue = $bindable(),
    ongotokeydown,
    query = $bindable(),
    caseSensitive = $bindable(),
    replacement = $bindable(''),
    showReplace = false,
    status,
    results,
    cursor,
    resultQuery,
    resultCase,
    onsearch,
    onjump,
    onclose,
    onsearchkeydown,
    onreplace,
    onreplaceall,
  }: Props = $props();

  let gotoInput = $state<HTMLInputElement | null>(null);
  let queryInput = $state<HTMLInputElement | null>(null);
  let replaceInput = $state<HTMLInputElement | null>(null);

  export function focusGoto(): void {
    gotoInput?.focus();
  }
  export function focusQuery(): void {
    queryInput?.focus();
  }
  export function focusReplace(): void {
    replaceInput?.focus();
  }
  export function isQueryFocused(): boolean {
    return queryInput !== null && document.activeElement === queryInput;
  }
  export function isReplaceFocused(): boolean {
    return replaceInput !== null && document.activeElement === replaceInput;
  }
</script>

{#if panel === 'goto'}
  <div class="goto-panel cm-panel">
    <input
      bind:this={gotoInput}
      class="cm-textfield"
      type="text"
      inputmode="numeric"
      placeholder={t('large.goto.placeholder')}
      aria-label={t('large.goto.aria')}
      bind:value={gotoValue}
      onkeydown={ongotokeydown}
      {...TEXT_FIELD_ATTRS}
    />
  </div>
{/if}

{#if panel === 'search'}
  <div class="cm-panel cm-search search-panel">
    <div class="cm-search-row">
      <input
        bind:this={queryInput}
        class="cm-textfield"
        type="text"
        placeholder={t('large.search.label')}
        aria-label={t('large.search.label')}
        bind:value={query}
        onkeydown={onsearchkeydown}
        {...TEXT_FIELD_ATTRS}
      />
      <button class="cm-button" onclick={onsearch}
        >{t('large.search.label')}</button
      >
      <label>
        <input type="checkbox" bind:checked={caseSensitive} />
        {t('large.search.case')}
      </label>
    </div>
    {#if showReplace}
      <div class="cm-search-row">
        <input
          bind:this={replaceInput}
          class="cm-textfield"
          type="text"
          placeholder={t('cm.replaceField')}
          aria-label={t('cm.replaceField')}
          bind:value={replacement}
          onkeydown={onsearchkeydown}
          {...TEXT_FIELD_ATTRS}
        />
        <button class="cm-button" onclick={onreplace}>{t('cm.replace')}</button>
        <button class="cm-button" onclick={onreplaceall}
          >{t('cm.replaceAll')}</button
        >
      </div>
    {/if}
    {#if status !== ''}
      <div class="search-status">{status}</div>
    {/if}
    {#if results.length > 0}
      <div class="search-results">
        {#each results as r, i (i)}
          <button
            type="button"
            class="search-result"
            class:active={i === cursor}
            onclick={() => onjump(i)}
            onkeydown={onsearchkeydown}
          >
            <span class="rline">{r.line}</span>
            <span class="rprev"
              >{#each matchSegments(r.preview, resultQuery, resultCase) as seg, j (j)}{#if seg.hit}<mark
                    class="rhit">{seg.text}</mark
                  >{:else}{seg.text}{/if}{/each}</span
            >
          </button>
        {/each}
      </div>
    {/if}
    <button
      name="close"
      title={t('common.close')}
      aria-label={t('common.close')}
      onclick={onclose}>×</button
    >
  </div>
{/if}

<style>
  /* Floating goto box, top-right, reusing the flat control look of the search
     panel (which app.css styles globally via .cm-panel.cm-search). */
  .goto-panel {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 5;
    padding: 8px 10px;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--topbar-border);
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  }
  .goto-panel .cm-textfield {
    width: 8rem;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--topbar-border);
    border-radius: 5px;
    padding: 5px 9px;
    font-size: 0.85rem;
  }
  .goto-panel .cm-textfield:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent);
  }
  /* The search shell picks up .cm-panel.cm-search from app.css; only its docking
     position and the read-only results list are component-local. */
  .search-panel {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 5;
  }
  .search-panel [name='close'] {
    border: none;
    background: none;
    cursor: default;
  }
  .search-status {
    font-size: 0.78rem;
    opacity: 0.7;
  }
  .search-results {
    display: flex;
    flex-direction: column;
    max-height: 40vh;
    overflow-y: auto;
    border: 1px solid var(--topbar-border);
    border-radius: 5px;
  }
  .search-result {
    /* overflow: hidden drops a flex item's minimum height to 0, so a long
       result list would shrink every row to a sliver instead of scrolling. */
    flex: 0 0 auto;
    display: flex;
    gap: 0.6rem;
    align-items: baseline;
    padding: 3px 8px;
    border: none;
    background: none;
    color: var(--fg);
    font-family: var(--doc-font-family);
    font-size: 0.8rem;
    text-align: left;
    white-space: pre;
    overflow: hidden;
    cursor: default;
  }
  .search-result:hover {
    background: rgba(127, 127, 127, 0.15);
  }
  .search-result.active {
    background: color-mix(in srgb, var(--accent) 25%, transparent);
  }
  .rhit {
    background: color-mix(in srgb, var(--accent) 40%, transparent);
    color: inherit;
    border-radius: 2px;
  }
  .rline {
    flex: 0 0 auto;
    min-width: 4rem;
    text-align: right;
    opacity: 0.6;
  }
  .rprev {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
