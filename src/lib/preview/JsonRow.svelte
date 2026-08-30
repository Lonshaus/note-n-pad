<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import { untrack } from 'svelte';
  import type { JsonNode } from './json';
  import { childCount, childrenOf, kindOf } from './json';
  import JsonRow from './JsonRow.svelte';

  interface Props {
    node: JsonNode;
    depth: number;
    /** Containers at the root open by default so the pane is not a single
     *  collapsed line; everything deeper waits to be asked for. */
    startOpen: boolean;
  }

  let { node, depth, startOpen }: Props = $props();

  const kind = $derived(kindOf(node.value));
  const container = $derived(kind === 'object' || kind === 'array');
  const count = $derived(container ? childCount(node.value) : 0);

  // Seed only: after mount the row owns its own open state, and a later prop
  // change must not slam it shut again. `untrack` says that outright instead of
  // leaving the compiler to warn about it.
  let open = $state(untrack(() => startOpen));

  // Children are built only while the row is open, so a collapsed subtree costs
  // nothing: this is what keeps a huge document off the main thread.
  const children = $derived(open && container ? childrenOf(node) : []);

  function summary(): string {
    if (kind === 'array') {
      return `[${count}]`;
    }
    return `{${count}}`;
  }

  function scalarText(): string {
    if (kind === 'string') {
      return JSON.stringify(node.value);
    }
    return String(node.value);
  }
</script>

<div class="row" style="padding-left: {depth * 1.1}rem">
  {#if container}
    <button
      class="twisty"
      aria-expanded={open}
      onclick={() => {
        open = !open;
      }}>{open ? '▾' : '▸'}</button
    >
  {:else}
    <span class="twisty spacer"></span>
  {/if}
  {#if node.key !== null}
    <span class="key">{node.key}</span><span class="colon">:</span>
  {/if}
  {#if container}
    <span class="summary">{summary()}</span>
  {:else}
    <span class="value {kind}">{scalarText()}</span>
  {/if}
</div>
{#if open}
  {#each children as child, i (child.key ?? i)}
    <JsonRow node={child} depth={depth + 1} startOpen={false} />
  {/each}
{/if}

<style>
  .row {
    display: flex;
    align-items: baseline;
    gap: 0.25rem;
    white-space: pre;
    line-height: 1.5;
  }
  .twisty {
    width: 1rem;
    flex: none;
    background: none;
    border: none;
    padding: 0;
    color: var(--fg-dim);
    cursor: pointer;
    font: inherit;
    text-align: left;
  }
  .twisty.spacer {
    cursor: default;
  }
  .key {
    color: var(--accent);
  }
  .colon {
    color: var(--fg-dim);
  }
  .summary {
    color: var(--fg-dim);
  }
  .value.string {
    color: var(--ok, var(--fg));
  }
  .value.number {
    color: var(--accent);
  }
  .value.boolean,
  .value.null {
    color: var(--fg-dim);
  }
</style>
