<script lang="ts">
  // Copyright © 2026 Lonshaus
  // SPDX-License-Identifier: GPL-3.0-only

  import { onMount, tick } from 'svelte';
  import type { Text } from '@codemirror/state';
  import { GFM, parser as baseParser } from '@lezer/markdown';
  import { anchorSlug, setPreviewAnchors } from './anchors';
  import { renderBlockSource, type MdNode } from './core';
  import { blockCount, blockEnd, blockStart, scanLines } from './scan';
  import { setPreviewExternalLinks } from './externalLinks';
  import { previewImagesReady, setPreviewImages } from './images';
  import { platform } from '../../state/platform.svelte';
  import { settingsState } from '../../state/settings.svelte';
  import MarkdownNode from './MarkdownNode.svelte';
  import {
    addRun,
    anchoredScrollTop,
    averageHeight,
    blockAt,
    blockHeightsFromTops,
    captureScrollAnchor,
    EMPTY_RUNS,
    heightOf,
    isCovered,
    maxHasSettled,
    offsetOf,
    type Run,
    type ScrollAnchor,
  } from './window';

  interface Props {
    /** The document itself, not a copy of it. A string prop would mean a second
     *  full-size allocation for every preview — the cost this view is built to
     *  avoid. Lines are read from the rope to scan, and only the blocks on
     *  screen are ever sliced out of it. */
    doc: Text;
    dark: boolean;
    /** The folder holding the document, or null for an unsaved tab. Only used
     *  to decide whether images can render at all — the folder itself is
     *  registered with the Rust core by DocumentApp, and an image URL never
     *  carries a path. */
    baseDir: string | null;
    /** The folder the core has confirmed, which trails `baseDir` until the
     *  registration lands. An `<img>` before then is refused for good. */
    registeredBase: string | null;
    /** Lets `external` links (http/https/mailto) render as clickable without
     *  turning on local images. For a document that ships inside the app,
     *  like the privacy policy, and has no folder for a `relative` link to
     *  resolve against anyway. Defaults to false so the document preview,
     *  where an external link is someone else's outbound address, is
     *  unchanged. */
    allowExternalLinks?: boolean;
  }

  let {
    doc,
    dark,
    baseDir,
    registeredBase,
    allowExternalLinks = false,
  }: Props = $props();

  // Getter, so the prop could vary over the view's lifetime, same as `images`.
  setPreviewExternalLinks({
    get allowed() {
      return allowExternalLinks;
    },
  });

  const imagesOn = $derived(
    previewImagesReady(
      settingsState.previewLocalResources,
      baseDir,
      registeredBase,
    ),
  );
  // Getters, so a toggle in Settings reaches the already-mounted node tree.
  setPreviewImages({
    get on() {
      return imagesOn;
    },
    get windows() {
      return platform.isWindows;
    },
  });

  /** Blocks rendered beyond each edge of the viewport. */
  const OVERSCAN = 6;
  /** Height assumed for a block nothing has measured yet. Replaced by the
   *  running average as real blocks land, so the guess only governs the very
   *  first frame. */
  const SEED_HEIGHT = 28;
  /** Safety backstop for the settle loop in `restoreScrollPosition`, not its
   *  termination condition — that is `maxHasSettled`. Only guards against a
   *  scroller that genuinely never stops resizing (e.g. torn down mid-wait);
   *  a real settle after a measurement is one or two frames. */
  const MAX_SETTLE_FRAMES = 20;

  const parser = baseParser.configure(GFM);

  let scrollEl: HTMLDivElement;
  let blockEl: HTMLDivElement | undefined = $state();
  let scrollTop = $state(0);
  let viewportHeight = $state(0);
  // Measured runs of blocks. Both a block's position (`offsetOf`/`blockAt`)
  // and the document's total height (`heightOf`) are read from this same
  // list, so the two can never disagree.
  let runs = $state<Run[]>(EMPTY_RUNS);
  const avgHeight = $derived(averageHeight(runs, SEED_HEIGHT));
  // The real DOM height of the currently rendered `[first, last)` window,
  // refreshed by every `measure()` call regardless of whether it found any
  // new territory to fold into `runs` — `topSpacer` needs it fresh every
  // time, not just on the calls that happen to grow `runs`.
  let windowHeight = $state(0);
  // Set while a scroll-position correction is waiting on `tick()`. Not
  // `$state`: it is read and cleared only from event callbacks (`onScroll`,
  // the correction itself), never from a template or a `$derived`.
  let pendingAnchor: ScrollAnchor | null = null;

  // Two integers per block and nothing else: measured, 120 million characters
  // index in 186ms and hold 30MB, against 1.1GB for parsing the same document
  // into a tree up front.
  const scanned = $derived(scanLines(doc.iterLines()));
  const index = $derived(scanned.index);
  const refs = $derived(scanned.refs);
  const headings = $derived(scanned.headings);
  const total = $derived(blockCount(index));
  const first = $derived(
    Math.max(0, blockAt(runs, scrollTop, avgHeight) - OVERSCAN),
  );
  const last = $derived(
    Math.min(
      total,
      Math.ceil((scrollTop + viewportHeight) / avgHeight) + OVERSCAN,
    ),
  );
  // `.blocks`' own top must never let its real, measured DOM height run
  // past `.spacer` — that ambiguity (one edge governed by a laid-out
  // spacer, the other by an absolutely positioned box extending past it)
  // is what a live report showed WebView2 resolving inconsistently frame
  // to frame, flipping `scrollHeight` between the two readings even with
  // nothing on screen changing.
  //
  // Computed from the *bottom* edge, not the top: `offsetOf(last)` minus
  // this window's own real height, rather than `offsetOf(first)` on its
  // own. `offsetOf(first)` can still be a proportional guess whenever
  // `first` lands inside a run that was measured as part of a *different*
  // window (unavoidable once two overlapping windows' runs merge — a run
  // stores one aggregate, never a per-block breakdown), and guessing too
  // high is exactly what let `.blocks` render short of where the document
  // really put it. Anchoring off `last` instead needs no such guess to stay
  // safe: `offsetOf` is monotonic and `total >= last`, so
  // `offsetOf(last) - windowHeight + windowHeight = offsetOf(last) <=
  // offsetOf(total) = contentHeight` always — `.blocks` can never be
  // positioned to overflow `.spacer`. And once `last` reaches `total`,
  // `offsetOf(last)` *is* `contentHeight` exactly, which makes this exact
  // at the one place a live report showed it failing: `.blocks`' own
  // bottom edge lands exactly on `.spacer`'s.
  const topSpacer = $derived(offsetOf(runs, last, avgHeight) - windowHeight);
  const contentHeight = $derived(heightOf(runs, total, avgHeight));
  // Parsing only what is on screen, which measured at about 1ms per screenful
  // regardless of document size — cheap enough that pushing it to a worker
  // would cost more in copying than it saves.
  //
  // `blockNodeCounts` tracks how many top-level DOM children each rendered
  // block produced (a block can yield zero nodes, e.g. a reference
  // definition, or more than one) — `measure` needs it to attribute
  // `.blocks` children back to the block they came from.
  const parsedBlocks = $derived.by(() => {
    const nodes: MdNode[] = [];
    const blockNodeCounts: number[] = [];
    for (let i = first; i < last; i += 1) {
      const source = doc.sliceString(blockStart(index, i), blockEnd(index, i));
      let count = 0;
      for (const node of renderBlockSource(
        (s) => parser.parse(s),
        source,
        refs,
      )) {
        nodes.push(node);
        count += 1;
      }
      blockNodeCounts.push(count);
    }
    return { nodes, blockNodeCounts };
  });
  const nodes = $derived(parsedBlocks.nodes);
  const blockNodeCounts = $derived(parsedBlocks.blockNodeCounts);

  // The reader's position and intent (pinned to the bottom or not), captured
  // at the one moment that is safe: inside `onScroll`, before the reactive
  // re-render this scroll triggers can grow `.blocks` past `.spacer`. Reading
  // `scrollMax()` any later — e.g. from inside `measure`, once the new
  // window's blocks have already rendered but `runs` has not caught up yet —
  // compares the reader's old position against an already-inflated maximum
  // and wrongly concludes they fell behind, which is what left a first
  // scroll-to-bottom stuck short of the real end.
  let lastAnchor: ScrollAnchor = { pinnedBottom: false, blockIndex: 0 };
  // Where a correction's own write is about to land, so `onScroll` does not
  // re-derive `lastAnchor` from the event that write causes. A position rather
  // than a flag: a write that moves nothing leaves a flag latched for good.
  let ownScrollTarget: number | null = null;

  function onScroll(): void {
    // A scroll arriving while a correction is pending is the reader moving on
    // their own — drop the correction rather than fight them. The correction
    // clears `pendingAnchor` itself before writing `scrollTop`, so the event
    // that write produces never lands here while still pending.
    pendingAnchor = null;
    scrollTop = scrollEl.scrollTop;
    // Cleared on a miss too, or it waits for whatever scrolls there next.
    const target = ownScrollTarget;
    ownScrollTarget = null;
    if (scrollTop === target) {
      return;
    }
    lastAnchor = captureScrollAnchor(scrollTop, scrollMax(), avgHeight);
  }

  // Anchors are resolved against the scan, not the DOM: the heading a link
  // names is almost never one of the blocks currently rendered, so there is no
  // element to scrollIntoView. The block ordinal times the running average is
  // the same estimate the scrollbar already uses — off by however far the
  // average is wrong, and corrected on the frame after the jump.
  setPreviewAnchors({
    find(dest: string): number | null {
      const slug = anchorSlug(dest);
      if (slug === null || slug === '') {
        return null;
      }
      return headings.get(slug) ?? null;
    },
    jump(block: number): void {
      scrollEl.scrollTop = offsetOf(runs, block, avgHeight);
    },
  });

  /** The scroller's real maximum `scrollTop`. `.blocks` is absolutely
   *  positioned inside `.spacer` and free to overflow it whenever the
   *  unmeasured tail is estimated shorter than it really is, so this is read
   *  from the DOM rather than derived from `contentHeight` — the anchor must
   *  never pin short of where the reader can actually scroll. */
  function scrollMax(): number {
    return Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
  }

  /** Fold what the rendered blocks actually measure into `runs`, so the
   *  document height converges on reality without ever being recomputed from
   *  an estimate. Reads each block's own DOM top (`blockHeightsFromTops`
   *  turns those into real per-block heights, margins included — see its
   *  own doc comment), grouped back into blocks by `blockNodeCounts`, so
   *  that a window overlapping territory already in `runs` folds in only the
   *  blocks that are actually new — the layout pass is already forced by
   *  these reads, so no second one is added. `runs` only ever gains new,
   *  disjoint territory this way, never rewrites what it already has: that
   *  append-only shape is what keeps `avgHeight` — and so `first`/`last`,
   *  which derive from it — converging instead of chasing its own tail
   *  frame after frame (a real, reproduced failure of an earlier version of
   *  this function that instead overwrote the whole rendered window on
   *  every call).
   *
   *  A new `runs` changes `contentHeight`, which the browser applies to the
   *  `.spacer` element and, if the reader is scrolled near the new edge,
   *  clamps `scrollTop` to fit — a jump under a reader who did not ask to
   *  move. The anchor captured below is what undoes that jump once the new
   *  height has actually reached the DOM. */
  function measure(): void {
    // A fresh object every call, even though `lastAnchor`'s fields are
    // unchanged since the last genuine reader scroll: `restoreScrollPosition`
    // tells "am I still the latest correction" apart by object identity
    // (`pendingAnchor !== anchor`), and the convergence cascade this
    // triggers — resize reveals more real height, which shifts `first`/
    // `last`, which resizes `.blocks` again — calls `measure()` several
    // times in a row with no reader scroll in between. Passing `lastAnchor`
    // itself would hand every one of those calls the same reference, so an
    // earlier call finishing after a later one starts would null out
    // `pendingAnchor` and make the later, more accurate call wrongly think
    // it had been superseded.
    const anchor = { ...lastAnchor };
    if (blockEl !== undefined) {
      // Snapshotted once, up front: `first`/`last` are `$derived` from
      // `runs`/`avgHeight`, so writing `runs` below can make Svelte
      // recompute them on their very next read — reading the *live*
      // bindings again afterward, for the correspondence check, would
      // silently compare the just-measured window against whatever window
      // `runs` now says is current, not the one actually measured here.
      const windowFirst = first;
      const windowLast = last;
      windowHeight = blockEl.offsetHeight;
      // One entry per block in the window: its first DOM node's own
      // `offsetTop`, or null for a block that produced no node at all.
      // `offsetHeight` alone would exclude margins, and adding
      // `marginTop`/`marginBottom` per block would over-count wherever two
      // blocks' margins collapse into one — the top of each block's own box
      // is the only quantity that carries no risk of either.
      const tops: (number | null)[] = [];
      let childIndex = 0;
      for (let i = windowFirst; i < windowLast; i += 1) {
        const nodeCount = blockNodeCounts[i - windowFirst] ?? 0;
        if (nodeCount > 0) {
          const child = blockEl.children.item(childIndex) as HTMLElement | null;
          tops.push(child?.offsetTop ?? null);
        } else {
          tops.push(null);
        }
        childIndex += nodeCount;
      }
      const heights = blockHeightsFromTops(tops, windowHeight);

      let pendingFrom: number | null = null;
      let pendingHeight = 0;
      for (let i = windowFirst; i < windowLast; i += 1) {
        const blockHeight = heights[i - windowFirst] ?? 0;
        if (isCovered(runs, i)) {
          if (pendingFrom !== null) {
            runs = addRun(runs, pendingFrom, i, pendingHeight);
            pendingFrom = null;
            pendingHeight = 0;
          }
        } else {
          pendingFrom ??= i;
          pendingHeight += blockHeight;
        }
      }
      if (pendingFrom !== null) {
        runs = addRun(runs, pendingFrom, windowLast, pendingHeight);
      }
      // Correspondence check: what the model now says about the window
      // just measured must equal what the DOM actually reported for it. A
      // mismatch here is a bug in the arithmetic, not noise — five prior
      // rounds each passed every unit test while disagreeing with the
      // browser's own layout, because no test compared the two. It can
      // still fire legitimately once `windowFirst` lands inside a run that
      // was recorded as part of a *different*, overlapping window (a run
      // holds one aggregate, never a per-block breakdown, so `offsetOf` can
      // only guess that split) — `topSpacer` is deliberately anchored off
      // `windowLast` instead so that guess never governs where `.blocks`
      // actually renders (see its own comment).
      if (import.meta.env.DEV) {
        const modelHeight =
          offsetOf(runs, windowLast, avgHeight) -
          offsetOf(runs, windowFirst, avgHeight);
        if (Math.abs(modelHeight - windowHeight) > 1) {
          console.warn('[MarkdownView] model/DOM height mismatch', {
            first: windowFirst,
            last: windowLast,
            modelHeight,
            domHeight: windowHeight,
            runs,
          });
        }
      }
    }
    pendingAnchor = anchor;
    void restoreScrollPosition(anchor);
  }

  /** Resolves on the next animation frame — a point after the engine has
   *  actually laid out whatever changed the DOM before it, unlike `tick()`,
   *  which only flushes Svelte's own update queue. */
  function nextFrame(): Promise<void> {
    return new Promise((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }

  /** Waits for the height change `measure` just made to reach the DOM, then
   *  restores the reading position `anchor` describes. `tick()` alone flushes
   *  Svelte's queue but not necessarily the engine's relayout — on WebView2
   *  the very next `scrollMax()` read can still reflect the pre-growth
   *  height, so this keeps re-reading it a frame at a time until two
   *  successive reads agree (`maxHasSettled`). That is guaranteed to happen:
   *  `runs` only ever grows toward `total`'s finite height, so the maximum it
   *  drives has nowhere left to move to once layout catches up.
   *
   *  Bails if a newer measurement or a genuine user scroll superseded
   *  `anchor` in the meantime — `pendingAnchor` no longer being this exact
   *  anchor is how either is detected. */
  async function restoreScrollPosition(anchor: ScrollAnchor): Promise<void> {
    await tick();
    if (pendingAnchor !== anchor) {
      return;
    }
    let max = scrollMax();
    for (let frame = 0; frame < MAX_SETTLE_FRAMES; frame += 1) {
      await nextFrame();
      if (pendingAnchor !== anchor) {
        return;
      }
      const next = scrollMax();
      const settled = maxHasSettled(max, next);
      max = next;
      if (settled) {
        break;
      }
    }
    pendingAnchor = null;
    // Whole pixels: WebKit truncates `scrollTop`, so a sub-pixel write moves
    // nothing and no event arrives to acknowledge it.
    const restored = Math.round(anchoredScrollTop(anchor, max, avgHeight));
    if (Math.abs(restored - scrollEl.scrollTop) >= 1) {
      ownScrollTarget = restored;
      scrollEl.scrollTop = restored;
      scrollTop = scrollEl.scrollTop;
      // Clamped by the scroller's real maximum: nothing moved, no event coming.
      if (scrollTop !== restored) {
        ownScrollTarget = null;
      }
    }
  }

  onMount(() => {
    const observer = new ResizeObserver(() => {
      if (scrollEl.clientHeight !== viewportHeight) {
        viewportHeight = scrollEl.clientHeight;
      }
      measure();
    });
    observer.observe(scrollEl);
    if (blockEl !== undefined) {
      observer.observe(blockEl);
    }
    viewportHeight = scrollEl.clientHeight;
    return () => {
      observer.disconnect();
    };
  });
</script>

<div class="markdown-view" class:dark bind:this={scrollEl} onscroll={onScroll}>
  <div class="spacer" style="height: {contentHeight}px;">
    <div class="blocks" style="top: {topSpacer}px;" bind:this={blockEl}>
      <!-- Keyed on the registered folder so a destination that failed under
           the previous one is not still latched as failed under this one. -->
      {#key registeredBase}
        {#each nodes as node, i (first + '-' + i)}
          <MarkdownNode {node} />
        {/each}
      {/key}
    </div>
  </div>
</div>

<style>
  .markdown-view {
    position: absolute;
    inset: 0;
    overflow: auto;
    padding: 0.8rem 1rem;
    background: var(--bg);
    color: var(--fg);
    font-size: 0.95rem;
    line-height: 1.6;
  }
  .spacer {
    position: relative;
  }
  .blocks {
    position: absolute;
    left: 0;
    right: 0;
  }
</style>
