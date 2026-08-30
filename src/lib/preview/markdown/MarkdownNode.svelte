<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import { invoke } from '@tauri-apps/api/core';
  import { getPreviewAnchors } from './anchors';
  import type { MdNode } from './core';
  import { getPreviewExternalLinks } from './externalLinks';
  import { docimgUrl, getPreviewImages } from './images';
  import { linkKind, showsAsLink } from './links';
  import MarkdownNode from './MarkdownNode.svelte';

  interface Props {
    node: MdNode;
  }

  let { node }: Props = $props();

  const images = getPreviewImages();
  const anchors = getPreviewAnchors();
  const externalLinks = getPreviewExternalLinks();
  // The destination whose load was refused or undecodable, so the alt text
  // takes over instead of a broken-image box. Held as the destination rather
  // than a flag so a node reused for a different image starts clean.
  let failedDest = $state<string | null>(null);
  const showImage = $derived(
    images?.on === true && node.kind === 'image' && failedDest !== node.dest,
  );
  const kind = $derived(node.kind === 'link' ? linkKind(node.dest) : 'blocked');
  /** The block holding the heading this anchor names, or null when no heading
   *  matches — an anchor pointing nowhere stays plain text rather than
   *  becoming a link that does nothing. */
  const anchorBlock = $derived(
    node.kind === 'link' && kind === 'anchor'
      ? (anchors?.find(node.dest) ?? null)
      : null,
  );
  const showLink = $derived(
    showsAsLink(
      kind,
      images?.on === true,
      externalLinks?.allowed === true,
      anchorBlock !== null,
    ),
  );

  /** The webview must never follow a link: leaving the app's own page ends the
   *  IPC context, and nothing in this codebase gets it back. The Rust
   *  navigation hook is the backstop, this is the mechanism. */
  function openLink(event: MouseEvent): void {
    event.preventDefault();
    if (node.kind !== 'link') {
      return;
    }
    if (anchorBlock !== null) {
      anchors?.jump(anchorBlock);
      return;
    }
    // The destination travels whole. Which command it goes to is only a
    // routing choice — both refuse on their own terms, and `open_preview_link`
    // resolves against a folder this side never sees.
    const call =
      kind === 'external'
        ? invoke('open_external_link', { url: node.dest })
        : invoke('open_preview_link', { dest: node.dest });
    // A refusal is the core's answer and the only one that counts; there is
    // nothing useful to show for it.
    void call.catch(() => {});
  }
</script>

<!-- Every branch below writes text into an element this file created. Nothing
     is interpolated as markup, so a document containing `<script>` or an
     `onerror=` attribute shows those characters and does nothing. -->
{#if node.kind === 'text'}{node.text}{:else if node.kind === 'strong'}<strong
    >{#each node.children as child, i (i)}<MarkdownNode
        node={child}
      />{/each}</strong
  >{:else if node.kind === 'emphasis'}<em
    >{#each node.children as child, i (i)}<MarkdownNode
        node={child}
      />{/each}</em
  >{:else if node.kind === 'strike'}<del
    >{#each node.children as child, i (i)}<MarkdownNode
        node={child}
      />{/each}</del
  >{:else if node.kind === 'code'}<code class="inline">{node.text}</code
  >{:else if node.kind === 'heading'}
  <div class="heading h{node.level}" role="heading" aria-level={node.level}>
    {#each node.children as child, i (i)}<MarkdownNode node={child} />{/each}
  </div>
{:else if node.kind === 'paragraph'}
  <p>
    {#each node.children as child, i (i)}<MarkdownNode node={child} />{/each}
  </p>
{:else if node.kind === 'quote'}
  <blockquote>
    {#each node.children as child, i (i)}<MarkdownNode node={child} />{/each}
  </blockquote>
{:else if node.kind === 'list'}
  <ul class:ordered={node.ordered}>
    {#each node.items as item, i (i)}
      <li class:task={item.checked !== null}>
        {#if item.checked !== null}
          <input type="checkbox" checked={item.checked} disabled />
        {:else if node.ordered}
          <span class="marker">{i + 1}.</span>
        {:else}
          <span class="marker">•</span>
        {/if}
        <span class="item-body"
          >{#each item.children as child, j (j)}<MarkdownNode
              node={child}
            />{/each}</span
        >
      </li>
    {/each}
  </ul>
{:else if node.kind === 'codeblock'}
  <pre class="block"><code>{node.text}</code></pre>
{:else if node.kind === 'table'}
  <table>
    <thead>
      <tr>
        {#each node.header as cell, i (i)}
          <th
            >{#each cell as child, j (j)}<MarkdownNode
                node={child}
              />{/each}</th
          >
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each node.rows as row, r (r)}
        <tr>
          {#each row as cell, c (c)}
            <td
              >{#each cell as child, j (j)}<MarkdownNode
                  node={child}
                />{/each}</td
            >
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
{:else if node.kind === 'rule'}
  <hr />
{:else if node.kind === 'html'}
  <!-- Raw HTML in the source is shown as the text it is. This is the one place
       a Markdown renderer usually hands the document control. -->
  <pre class="raw">{node.text}</pre>
{:else if node.kind === 'link'}
  {#if showLink}
    <!-- href only so it reads and hovers like a link; the click is handled
         here and the webview never follows it. A `javascript:` or `file:`
         destination is `blocked` and never reaches an href at all. -->
    <a href={node.dest} onclick={openLink}
      >{#each node.children as child, i (i)}<MarkdownNode
          node={child}
        />{/each}</a
    >
  {:else}
    <!-- Setting off, no document folder, an anchor naming no heading, or a
         scheme nothing may act on. -->
    <span
      >{#each node.children as child, i (i)}<MarkdownNode
          node={child}
        />{/each}</span
    >
  {/if}
{:else if node.kind === 'image'}
  {#if showImage}
    <!-- The destination is never a path here: it goes to the Rust core whole,
         in a query parameter, and only `resolve_within` decides what it means. -->
    <img
      class="preview"
      src={docimgUrl(node.dest, images?.windows === true)}
      alt={node.alt}
      onerror={() => (failedDest = node.dest)}
    />
  {:else}
    <!-- Setting off, no document folder, or the load was refused. -->
    <span>{node.alt}</span>
  {/if}
{/if}

<style>
  .heading {
    font-weight: 700;
    margin: 0.8em 0 0.4em;
  }
  .h1 {
    font-size: 1.7em;
  }
  .h2 {
    font-size: 1.4em;
  }
  .h3 {
    font-size: 1.2em;
  }
  .h4,
  .h5,
  .h6 {
    font-size: 1em;
  }
  p {
    margin: 0.5em 0;
  }
  blockquote {
    margin: 0.5em 0;
    padding-left: 0.8em;
    border-left: 3px solid var(--topbar-border);
    color: var(--fg-dim);
  }
  ul {
    margin: 0.4em 0;
    padding-left: 0.4em;
    list-style: none;
  }
  li {
    display: flex;
    align-items: baseline;
    gap: 0.4em;
  }
  .marker {
    flex: none;
    color: var(--fg-dim);
  }
  li input {
    flex: none;
  }
  .item-body {
    min-width: 0;
  }
  code.inline {
    padding: 0 0.25em;
    border-radius: 3px;
    background: color-mix(in srgb, var(--fg) 10%, transparent);
    font-family: var(--editor-font, monospace);
  }
  pre.block,
  pre.raw {
    margin: 0.6em 0;
    padding: 0.6em 0.8em;
    overflow-x: auto;
    border-radius: 5px;
    background: color-mix(in srgb, var(--fg) 7%, transparent);
    font-family: var(--editor-font, monospace);
    font-size: 0.9em;
  }
  pre.raw {
    color: var(--fg-dim);
  }
  table {
    margin: 0.6em 0;
    border-collapse: collapse;
  }
  th,
  td {
    padding: 0.2em 0.6em;
    border: 1px solid var(--topbar-border);
    text-align: left;
  }
  img.preview {
    max-width: 100%;
    height: auto;
  }
  a {
    color: var(--accent);
    cursor: pointer;
  }
  hr {
    margin: 1em 0;
    border: none;
    border-top: 1px solid var(--topbar-border);
  }
</style>
