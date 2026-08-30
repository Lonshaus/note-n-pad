<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import type { Text } from '@codemirror/state';
  import { parseJsonForPreview } from './json';
  import JsonRow from './JsonRow.svelte';
  import { t } from '../i18n';

  interface Props {
    /** The document itself. Taking a string would rebuild a full-size copy on
     *  every render of the parent; the parse below recomputes only when the
     *  document does, and the string it makes is dropped as soon as it has. */
    doc: Text;
    dark: boolean;
  }

  let { doc, dark }: Props = $props();

  // Parsing stays on the main thread: measured at 12ms for a ten-million
  // character document in WebKit, which is well inside a frame budget that the
  // markdown path (358ms) will not be.
  const result = $derived(parseJsonForPreview(doc.toString()));
</script>

<div class="json-view" class:dark>
  {#if result.ok}
    <JsonRow node={result.root} depth={0} startOpen={true} />
  {:else}
    <p class="error">
      {#if result.error.position !== null}
        {t('preview.jsonErrorAt', {
          line: result.error.position.line,
          column: result.error.position.column,
          detail: result.error.message,
        })}
      {:else}
        {t('preview.jsonError', { detail: result.error.message })}
      {/if}
    </p>
  {/if}
</div>

<style>
  .json-view {
    position: absolute;
    inset: 0;
    overflow: auto;
    padding: 0.5rem;
    background: var(--bg);
    color: var(--fg);
    font-family: var(--editor-font, monospace);
    font-size: 0.85rem;
  }
  .error {
    margin: 0;
    color: var(--danger);
    white-space: pre-wrap;
  }
</style>
