<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import type { LineEnding } from './util/text';
  import type { ViewMode } from './util/viewModes';
  import { formatFileSize } from './util/format';
  import { syntaxOrder } from './util/syntaxOrder';
  import { t } from './i18n';

  /** One entry of the view-mode switcher. `disabledReason` is the tooltip
   *  explaining why a mode cannot be picked right now — null when it can. */
  interface ViewModeOption {
    mode: ViewMode;
    disabledReason: string | null;
  }

  /** Reading-mode status for a large-file tab; when set, the bar shows the
   *  view-only layout instead of the editor controls. */
  interface LargeBar {
    size: number;
    totalLines: number | null;
    indexedLines: number;
    firstLine: number;
    indexing: boolean;
    readFailed: boolean;
  }

  interface Props {
    lineEnding: LineEnding;
    hadBom: boolean;
    encoding: string;
    encodings: readonly string[];
    lossy: boolean;
    language: string | null;
    languages: string[];
    line: number;
    col: number;
    // Every mode this tab can show, in switcher order. One entry means there is
    // nothing to switch between, so no switcher is drawn.
    modeOptions: ViewModeOption[];
    viewMode: ViewMode;
    large: LargeBar | null;
    // Long-line gate status for a normal editor tab, or null when it is off.
    // `workerColoring` true means worker highlighting is running; false means it
    // is unavailable (setting off or no parser), so highlighting is disabled.
    longLine: { workerColoring: boolean } | null;
    onlineending: (ending: LineEnding) => void;
    onencoding: (label: string) => void;
    onlanguage: (name: string | null) => void;
    onviewmode: (mode: ViewMode) => void;
  }

  let {
    lineEnding,
    hadBom,
    encoding,
    encodings,
    lossy,
    language,
    languages,
    line,
    col,
    modeOptions,
    viewMode,
    large,
    longLine,
    onlineending,
    onencoding,
    onlanguage,
    onviewmode,
  }: Props = $props();

  // The current language pinned at top, then a separator, then the rest —
  // same structure as the Format > Syntax menu.
  let langOrder = $derived(syntaxOrder(languages, language));

  function onEndingChange(e: Event): void {
    const value = (e.currentTarget as HTMLSelectElement).value as LineEnding;
    onlineending(value);
  }

  function onEncodingChange(e: Event): void {
    onencoding((e.currentTarget as HTMLSelectElement).value);
  }

  function onLangChange(e: Event): void {
    const value = (e.currentTarget as HTMLSelectElement).value;
    onlanguage(value === '' ? null : value);
  }

  function onViewModeChange(e: Event): void {
    onviewmode((e.currentTarget as HTMLSelectElement).value as ViewMode);
  }

  // Format names stay English in every locale (see the never-translate rule);
  // the editor and table views are ordinary translated labels.
  function modeLabel(mode: ViewMode): string {
    switch (mode) {
      case 'source':
        return t('status.viewSource');
      case 'table':
        return t('status.viewTable');
      case 'json':
        return 'JSON';
      case 'xml':
        return 'XML';
      case 'markdown':
        return 'Markdown';
    }
  }
</script>

{#if large !== null}
  <footer class="statusbar">
    <div class="left">
      <span class="item badge">{t('status.view')}</span>
      <span class="item">{formatFileSize(large.size)}</span>
      {#if large.indexing}
        <span class="item"
          >{t('status.indexing', { count: large.indexedLines })}</span
        >
      {:else if large.totalLines !== null}
        <span class="item"
          >{t('status.lines', { count: large.totalLines })}</span
        >
      {/if}
      {#if large.readFailed}
        <!-- Blank lines are all a failed read leaves behind, and an empty
             stretch of file looks exactly the same, so this is the only thing
             telling the two apart. Same amber treatment as the lossy-decode
             marker, the bar's existing way of saying something is wrong. -->
        <span class="item warn" role="alert">
          <svg
            viewBox="0 0 24 24"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M12 4L2.5 20.5h19L12 4z" />
            <path d="M12 10v4" />
            <path d="M12 17.5v.2" />
          </svg>
          <span>{t('large.read.failed')}</span>
        </span>
      {/if}
    </div>
    <div class="right">
      <span class="item">Ln {large.firstLine}</span>
    </div>
  </footer>
{:else}
  <footer class="statusbar">
    <div class="left">
      <select
        class="item lang"
        value={lineEnding}
        title={t('status.lineEnding')}
        onchange={onEndingChange}
      >
        <option value="LF">LF</option>
        <option value="CRLF">CRLF</option>
      </select>
      {#if lossy}
        <span class="item warn" title={t('status.lossy')}>
          <svg
            viewBox="0 0 24 24"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M12 4L2.5 20.5h19L12 4z" />
            <path d="M12 10v4" />
            <path d="M12 17.5v.2" />
          </svg>
        </span>
      {/if}
      <select
        class="item lang"
        value={encoding}
        title={t('status.encoding')}
        onchange={onEncodingChange}
      >
        {#each encodings as name (name)}
          <option value={name}>{name}</option>
        {/each}
      </select>
      {#if hadBom}
        <span class="item bom">+BOM</span>
      {/if}
      <select
        class="item lang"
        value={language ?? ''}
        title={t('status.language')}
        onchange={onLangChange}
      >
        <!-- Language names stay untranslated; Plain Text follows the same
             rule. The current language is pinned first, then a separator,
             matching the Format > Syntax menu. -->
        {#each langOrder as name, index (name ?? '')}
          <option value={name ?? ''}>{name ?? 'Plain Text'}</option>
          {#if index === 0}
            <hr />
          {/if}
        {/each}
      </select>
      {#if longLine !== null}
        <span class="item longline" title={t('status.longLine.reason')}>
          {longLine.workerColoring
            ? t('status.longLine.worker')
            : t('status.longLine.disabled')}
        </span>
      {/if}
    </div>
    <div class="right">
      {#if modeOptions.length > 1}
        <select
          class="item lang"
          value={viewMode}
          title={t('status.viewMode')}
          onchange={onViewModeChange}
        >
          {#each modeOptions as option (option.mode)}
            <option
              value={option.mode}
              disabled={option.disabledReason !== null}
              title={option.disabledReason ?? ''}
              >{modeLabel(option.mode)}</option
            >
          {/each}
        </select>
      {/if}
      <span class="item">Ln {line}, Col {col}</span>
    </div>
  </footer>
{/if}

<style>
  .statusbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 22px;
    padding: 0 0.6rem;
    border-top: 1px solid var(--topbar-border);
    background: var(--bg);
    color: var(--fg);
    font-size: 0.72rem;
    flex: 0 0 auto;
    user-select: none;
  }
  .left,
  .right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .item {
    opacity: 0.8;
    white-space: nowrap;
  }
  .lang {
    appearance: none;
    -webkit-appearance: none;
    padding: 0 0.25rem;
    border: none;
    border-radius: 3px;
    background: none;
    color: inherit;
    font: inherit;
    cursor: default;
  }
  .lang:hover {
    opacity: 1;
    background: var(--topbar-border);
  }
  .bom {
    margin-left: -0.55rem;
  }
  .badge {
    padding: 0 0.35rem;
    border: 1px solid var(--topbar-border);
    border-radius: 3px;
    opacity: 1;
  }
  .warn {
    display: flex;
    align-items: center;
    opacity: 1;
    color: #e0a500;
    cursor: help;
  }
  /* Honest long-line marker: syntax highlighting is off the main thread or
     disabled because a line is too long to parse synchronously. */
  .longline {
    padding: 0 0.35rem;
    border: 1px solid var(--topbar-border);
    border-radius: 3px;
    opacity: 1;
    cursor: help;
  }
</style>
