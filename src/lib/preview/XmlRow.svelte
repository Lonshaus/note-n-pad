<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import type { XmlNode } from './xml';

  interface Props {
    node: XmlNode;
    depth: number;
    /** Whether this row currently shows its children. Owned by the caller
     *  (keyed by the row's path, not this component's own state), so a row
     *  that scrolls out of the window and back reopens the way it was left. */
    open: boolean;
    ontoggle: () => void;
  }

  let { node, depth, open, ontoggle }: Props = $props();

  const container = $derived(node.childCount > 0);

  // Every value below is a string that came out of the parse layer. Nothing
  // here is a parsed node, and nothing is inserted as markup.
  function label(): string {
    switch (node.kind) {
      case 'element':
        return `<${node.name}>`;
      case 'instruction':
        return `<?${node.name}?>`;
      case 'comment':
        return '<!-- -->';
      case 'cdata':
        return 'CDATA';
      case 'document':
        return '#document';
      default:
        return '';
    }
  }
</script>

<div class="row" style="padding-left: {depth * 1.1}rem">
  {#if container}
    <button class="twisty" aria-expanded={open} onclick={ontoggle}
      >{open ? '▾' : '▸'}</button
    >
  {:else}
    <span class="twisty spacer"></span>
  {/if}
  {#if node.kind === 'text'}
    <span class="text">{node.value}</span>
  {:else}
    <span class="tag {node.kind}">{label()}</span>
    {#each node.attributes as attr (attr.name)}
      <span class="attr-name">{attr.name}</span><span class="eq">=</span><span
        class="attr-value">"{attr.value}"</span
      >
    {/each}
    {#if node.kind === 'comment' || node.kind === 'cdata' || node.kind === 'instruction'}
      <span class="text">{node.value}</span>
    {/if}
    {#if container && !open}
      <span class="summary">{node.childCount}</span>
    {/if}
  {/if}
</div>

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
  .tag {
    color: var(--accent);
  }
  .tag.comment,
  .tag.cdata,
  .tag.instruction,
  .tag.document {
    color: var(--fg-dim);
  }
  .attr-name {
    color: var(--fg-dim);
  }
  .eq {
    color: var(--fg-dim);
  }
  .attr-value {
    color: var(--ok, var(--fg));
  }
  .text {
    color: var(--fg);
  }
  .summary {
    color: var(--fg-dim);
  }
</style>
