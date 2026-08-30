<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import { onMount } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type { Text } from '@codemirror/state';
  import {
    childrenOf,
    disposeXmlPreview,
    parseXmlForPreview,
    visibleRowCount,
    visibleRows,
    isRowOpen,
    type XmlParseResult,
  } from './xml';
  import { computeVisibleWindow } from '../util/largeView';
  import {
    blockTopFor,
    engineScrollLimit,
    MAX_SCROLL_HEIGHT,
    rowLayout,
  } from '../util/tableRows';
  import XmlRow from './XmlRow.svelte';
  import { t } from '../i18n';

  interface Props {
    /** The document itself, for the same reason as the JSON view: a string prop
     *  is rebuilt on every render of the parent, a rope is not. The parser
     *  reads the rope directly, so no full-size copy is ever made. */
    doc: Text;
    dark: boolean;
  }

  let { doc, dark }: Props = $props();

  // Row virtualization: rendering every row of a 115,556-child root cost 6GB of
  // WebContent RSS and wedged the window. Only the rows in the viewport are
  // built at all — `visibleRowCount`/`visibleRows` in xml.ts never materialize a
  // collapsed node's children, so the DOM tracks the viewport, not the document.
  const OVERSCAN = 20;
  let scrollEl: HTMLDivElement;
  let blockEl: HTMLDivElement | undefined = $state();
  let scrollTop = $state(0);
  let viewportHeight = $state(0);
  // Seeded from the CSS, then replaced by a real measurement: zoom and font
  // size move it. Rows never wrap (`white-space: pre`), so one measurement
  // covers every row regardless of depth or content.
  let rowHeight = $state(20);
  let scrollCap = $state(MAX_SCROLL_HEIGHT);

  // A node the user expanded stays expanded when it scrolls out of the window
  // and back. Keyed by path (dot-joined child indices from the top), not
  // object identity — rows are rebuilt every scroll, so an identity-keyed set
  // would forget everything the instant the window moved.
  //
  // `SvelteSet`, not `$state(new Set())`: `$state` deep-proxies objects and
  // arrays but not Sets, so `add`/`delete` would mutate silently and the rows
  // would never redraw. DocumentApp uses `SvelteMap` for the same reason.
  const toggled = new SvelteSet<string>();

  // Parsing runs in slices off the rope, so a large document cannot freeze the
  // window. The result is kept next to the document it came from: while a new
  // one is in flight the view draws nothing rather than the last document's
  // tree, and a small document is ready before the frame anyway.
  //
  // `$state.raw`, not `$state`: plain `$state` proxies the object deeply, and
  // `childrenOf` finds a row's parser node in a WeakMap keyed by the row's own
  // identity. A proxied row is a different object, so every lookup missed and
  // the pane rendered empty while reporting a clean parse. The result is
  // replaced wholesale and never mutated, so there is nothing to proxy for.
  let done = $state.raw<{ doc: Text; result: XmlParseResult } | null>(null);

  $effect(() => {
    const source = doc;
    let stale = false;
    void parseXmlForPreview(source, () => stale).then((result) => {
      if (result === null) {
        return;
      }
      if (stale) {
        // The view moved on before this result landed. Nobody will ever
        // read it, so release its document copy right away instead of
        // waiting for a collector that would otherwise have to.
        if (result.ok) {
          disposeXmlPreview(result.root);
        }
        return;
      }
      if (done !== null && done.result.ok) {
        disposeXmlPreview(done.result.root);
      }
      done = { doc: source, result };
    });
    return () => {
      stale = true;
    };
  });

  const result = $derived(
    done !== null && done.doc === doc ? done.result : null,
  );
  const parsed = $derived(result !== null && result.ok ? result : null);
  const failure = $derived(result !== null && !result.ok ? result.error : null);

  // The `#document` wrapper is dropped: it carries nothing, and rendering it
  // would push the root element down a level and leave it collapsed. These are
  // few (a declaration, maybe a doctype, the root element), so building them
  // eagerly costs nothing regardless of how large the root element itself is.
  const roots = $derived(parsed !== null ? childrenOf(parsed.root) : []);

  // Independent of scroll position: only the parse and the expansion state
  // change how many rows there are.
  const rowCount = $derived(visibleRowCount(roots, toggled));

  const trueHeight = $derived(rowCount * rowHeight);
  const contentHeight = $derived(Math.min(trueHeight, scrollCap));
  const compressed = $derived(contentHeight < trueHeight);
  const view = $derived(
    computeVisibleWindow(
      scrollTop,
      rowHeight,
      viewportHeight,
      rowCount,
      contentHeight,
      OVERSCAN,
    ),
  );
  const layout = $derived(
    rowLayout(
      view.startLine,
      view.endLine,
      rowCount,
      rowHeight,
      [],
      blockTopFor(
        view.startLine,
        view.firstVisible,
        scrollTop,
        rowHeight,
        compressed,
      ),
      contentHeight,
    ),
  );

  // Never walks past `[startLine, endLine)`: a collapsed node's children off
  // screen are never built, however many the node has.
  const windowRows = $derived(
    visibleRows(roots, toggled, view.startLine, view.endLine),
  );

  function onScroll(): void {
    scrollTop = scrollEl.scrollTop;
  }

  function toggle(path: string): void {
    if (toggled.has(path)) {
      toggled.delete(path);
    } else {
      toggled.add(path);
    }
  }

  // Measured, not read off the stylesheet. Forces layout, so mount/resize only.
  function measureRowHeight(): void {
    const measured = blockEl?.querySelector<HTMLElement>('.row')?.offsetHeight;
    if (measured !== undefined && measured > 0 && measured !== rowHeight) {
      rowHeight = measured;
    }
  }

  function measurePane(): void {
    if (scrollEl.clientHeight !== viewportHeight) {
      viewportHeight = scrollEl.clientHeight;
    }
  }

  let observer: ResizeObserver | undefined;

  onMount(() => {
    observer = new ResizeObserver(() => {
      measurePane();
      measureRowHeight();
    });
    observer.observe(scrollEl);
    scrollCap = engineScrollLimit(document);
    measurePane();
    return () => {
      observer?.disconnect();
      if (done !== null && done.result.ok) {
        disposeXmlPreview(done.result.root);
      }
    };
  });

  // `.blocks` only exists once a document has parsed, so it is observed
  // separately from the pane itself: an element gets its first ResizeObserver
  // callback as soon as it is observed, which is what measures the real row
  // height the moment the first rows land, rather than leaving the seed value
  // in place until some unrelated resize happens to fire.
  $effect(() => {
    const el = blockEl;
    if (el === undefined || observer === undefined) {
      return;
    }
    observer.observe(el);
    return () => {
      observer?.unobserve(el);
    };
  });
</script>

<div class="xml-view" class:dark bind:this={scrollEl} onscroll={onScroll}>
  {#if parsed !== null}
    <div class="spacer" style="height: {contentHeight}px;">
      <div
        class="blocks"
        style="top: {layout.topSpacer}px;"
        bind:this={blockEl}
      >
        {#each windowRows as row (row.path)}
          <XmlRow
            node={row.node}
            depth={row.depth}
            open={isRowOpen(row.path, row.depth, toggled)}
            ontoggle={() => {
              toggle(row.path);
            }}
          />
        {/each}
      </div>
    </div>
  {:else if failure !== null}
    <p class="error">
      {#if failure.position !== null}
        {t('preview.xmlErrorAt', {
          line: failure.position.line,
          column: failure.position.column,
          detail: failure.message,
        })}
      {:else}
        {t('preview.xmlError', { detail: failure.message })}
      {/if}
    </p>
  {/if}
</div>

<style>
  .xml-view {
    position: absolute;
    inset: 0;
    overflow: auto;
    padding: 0.5rem;
    background: var(--bg);
    color: var(--fg);
    font-family: var(--editor-font, monospace);
    font-size: 0.85rem;
  }
  .spacer {
    position: relative;
  }
  .blocks {
    position: absolute;
    left: 0;
    right: 0;
  }
  .error {
    margin: 0;
    color: var(--danger);
    white-space: pre-wrap;
  }
</style>
