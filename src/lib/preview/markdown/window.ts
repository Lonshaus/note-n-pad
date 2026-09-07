// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Pure arithmetic for MarkdownView's virtualized block window.
 *
 *  A block's position and the document's total height used to be derived
 *  from different things — an estimated `first * avgHeight` for position, an
 *  estimate-plus-one-measurement for height — so they disagreed and the
 *  reported height flipped between two states as the rendered window moved.
 *  Here both come from the same function over the same data: a list of
 *  measured runs. A run is real pixels for real blocks and is never
 *  recomputed, so the document height can only ever gain precision, never
 *  flip back.
 *
 *  Kept free of the DOM so it runs, and is tested, in plain node — the
 *  Svelte component owns the `$state` and calls these as plain functions. */

import { blockEnd, blockStart, type BlockIndex } from './scan';

/** Blocks `from` (inclusive) to `to` (exclusive) were rendered together and
 *  measured `height` pixels tall in total. */
export interface Run {
  from: number;
  to: number;
  height: number;
}

/** Memory bound: at 3 numbers per run this is roughly 1.5 KB regardless of
 *  document size. Enforced by merging the two runs with the smallest gap
 *  between them, not by dropping data. */
const MAX_RUNS = 64;

export const EMPTY_RUNS: Run[] = [];

/** Total blocks covered by measured runs. */
export function measuredBlocks(runs: Run[]): number {
  return runs.reduce((sum, run) => sum + (run.to - run.from), 0);
}

/** Total measured height across all runs. */
export function measuredHeight(runs: Run[]): number {
  return runs.reduce((sum, run) => sum + run.height, 0);
}

/** Character offset where block `i` begins; at `total` the document's end. */
function charAt(index: BlockIndex, i: number): number {
  const total = index.length >> 1;
  if (total === 0) {
    return 0;
  }
  return i >= total ? blockEnd(index, total - 1) : blockStart(index, i);
}

/** What a stretch of document is assumed to cost in pixels: a fixed amount
 *  for every block plus an amount for every source character. One number per
 *  block cannot describe both a heading and a code fence, and a document with
 *  one very tall block then prices every other block by that block's height —
 *  measured: a 7600px block among 197 put block 8 at 1744px when its real
 *  offset was 563. */
export interface Metric {
  index: BlockIndex;
  perBlock: number;
  perChar: number;
}

/** Smallest per-block cost the model may use. A pure per-character fit would
 *  otherwise give a span of zero-character blocks a cost of zero, and both the
 *  share taken inside a run and the price of a gap divide by that. */
const MIN_PER_BLOCK = 1e-6;

/** Pixels a span is modelled to occupy. Strictly positive whenever
 *  `to > from`, which is what every division by it relies on. */
function spanCost(metric: Metric, from: number, to: number): number {
  const blocks = to - from;
  if (blocks <= 0) {
    return 0;
  }
  const chars = charAt(metric.index, to) - charAt(metric.index, from);
  return (
    Math.max(metric.perBlock, MIN_PER_BLOCK) * blocks +
    Math.max(0, metric.perChar) * Math.max(0, chars)
  );
}

/** Fit the two costs to the runs themselves: each run is one observation,
 *  "n blocks and s characters measured H pixels tall". Least squares over at
 *  most `MAX_RUNS` of those, so this costs nothing that scales with the
 *  document. Falls back to a single parameter whenever two cannot be
 *  separated — one observation, collinear observations, or a fit that comes
 *  out negative, which is the model extrapolating outside its own data. */
export function metricOf(runs: Run[], index: BlockIndex, seed: number): Metric {
  if (runs.length === 0) {
    return { index, perBlock: seed, perChar: 0 };
  }
  let nn = 0;
  let ns = 0;
  let ss = 0;
  let nh = 0;
  let sh = 0;
  for (const run of runs) {
    const n = run.to - run.from;
    const c = charAt(index, run.to) - charAt(index, run.from);
    nn += n * n;
    ns += n * c;
    ss += c * c;
    nh += n * run.height;
    sh += c * run.height;
  }
  const byBlock = nn > 0 ? nh / nn : seed;
  const det = nn * ss - ns * ns;
  if (runs.length < 2 || Math.abs(det) < 1e-9) {
    return { index, perBlock: byBlock, perChar: 0 };
  }
  const perBlock = (nh * ss - sh * ns) / det;
  const perChar = (sh * nn - nh * ns) / det;
  if (perBlock >= 0 && perChar >= 0) {
    return { index, perBlock, perChar };
  }
  const byChar = ss > 0 ? sh / ss : 0;
  const err = (a: number, b: number): number =>
    runs.reduce((e, run) => {
      const n = run.to - run.from;
      const c = charAt(index, run.to) - charAt(index, run.from);
      return e + (a * n + b * c - run.height) ** 2;
    }, 0);
  return err(byBlock, 0) <= err(0, byChar)
    ? { index, perBlock: byBlock, perChar: 0 }
    : { index, perBlock: 0, perChar: byChar };
}

/** Sort by `from` and merge only runs that genuinely overlap, summing their
 *  heights. Runs that merely touch are left apart: a run holds one aggregate
 *  height, so merging two measured windows throws away the boundary between
 *  them, and every block on both sides is then priced at their blended
 *  density. Measured, that is the whole defect — one 7600px block among 197
 *  made the model place block 8 at 1744px where it really sat at 563. */
function normalize(runs: Run[]): Run[] {
  const sorted = [...runs].sort((a, b) => a.from - b.from);
  const out: Run[] = [];
  for (const run of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && run.from < last.to) {
      last.to = Math.max(last.to, run.to);
      last.height += run.height;
    } else {
      out.push({ ...run });
    }
  }
  return out;
}

/** Merge the two adjacent runs with the smallest modelled gap until at most
 *  `MAX_RUNS` remain. The gap's blocks were never measured, so their share of
 *  the merged height is priced by the metric — the only place this module
 *  estimates rather than measures, and only to keep memory bounded.
 *
 *  Now that touching runs are kept apart, most candidate gaps are zero blocks
 *  wide and the tie goes to the lowest index, so a long reading session grows
 *  one coarse run over the front of the document. That costs nothing here
 *  because a block's share inside a run is scaled by its source characters
 *  rather than by block count: replayed on a 1576-block document whose front
 *  run had swallowed blocks 0..1513, re-entering that territory left every
 *  scroll position covered, worst placement error 231px. */
function capRuns(runs: Run[], metric: Metric): Run[] {
  if (runs.length <= MAX_RUNS) {
    return runs;
  }
  let bestIndex = 0;
  let bestGap = Infinity;
  for (let i = 0; i < runs.length - 1; i += 1) {
    const current = runs[i];
    const next = runs[i + 1];
    if (current === undefined || next === undefined) {
      continue;
    }
    const gap = spanCost(metric, current.to, next.from);
    if (gap < bestGap) {
      bestGap = gap;
      bestIndex = i;
    }
  }
  const a = runs[bestIndex];
  const b = runs[bestIndex + 1];
  if (a === undefined || b === undefined) {
    return runs;
  }
  const merged: Run = {
    from: a.from,
    to: b.to,
    height: a.height + b.height + bestGap,
  };
  const next = [
    ...runs.slice(0, bestIndex),
    merged,
    ...runs.slice(bestIndex + 2),
  ];
  return next.length > MAX_RUNS ? capRuns(next, metric) : next;
}

/** Whether block `index` already lies inside a measured run. */
export function isCovered(runs: Run[], index: number): boolean {
  return runs.some((run) => run.from <= index && index < run.to);
}

/** Fold in a measurement of `[from, to)` totalling `height` pixels. Callers
 *  measure each rendered block individually and check `isCovered` before
 *  including it (see MarkdownView's `measure`), so `[from, to)` is always
 *  territory nothing has measured before — that is what keeps an overlapping
 *  render window from being double counted here. */
export function addRun(
  runs: Run[],
  from: number,
  to: number,
  height: number,
  metric: Metric,
): Run[] {
  if (to <= from || height <= 0) {
    return runs;
  }
  return capRuns(normalize([...runs, { from, to, height }]), metric);
}

/** Cumulative height of blocks `0 .. index - 1`: real height for the parts
 *  covered by runs, `avg` per block for the gaps between them. */
export function offsetOf(runs: Run[], index: number, metric: Metric): number {
  let offset = 0;
  let cursor = 0;
  for (const run of runs) {
    if (run.from >= index) {
      break;
    }
    if (run.from > cursor) {
      offset += spanCost(metric, cursor, run.from);
    }
    const end = Math.min(run.to, index);
    if (end > run.from) {
      const whole = spanCost(metric, run.from, run.to);
      offset +=
        whole > 0
          ? (run.height * spanCost(metric, run.from, end)) / whole
          : run.height;
    }
    cursor = Math.max(cursor, run.to);
    if (cursor >= index) {
      return offset;
    }
  }
  if (cursor < index) {
    offset += spanCost(metric, cursor, index);
  }
  return offset;
}

/** The document's scrollable height. The same function as `offsetOf`,
 *  called at the last block — so a block's position and the document's
 *  height can never disagree, whatever `first`/`last` happen to be. */
export function heightOf(runs: Run[], total: number, metric: Metric): number {
  return offsetOf(runs, total, metric);
}

/** The block index whose span contains `offset`. The inverse of `offsetOf`:
 *  walks the same runs and gaps, stopping once the cumulative height would
 *  pass `offset`. */
export function blockAt(runs: Run[], offset: number, metric: Metric): number {
  if (offset <= 0) {
    return 0;
  }
  const total = metric.index.length >> 1;
  let cursor = 0;
  let pos = 0;
  for (const run of runs) {
    if (run.from > cursor) {
      const gap = spanCost(metric, cursor, run.from);
      if (pos + gap > offset) {
        return seek(metric, cursor, run.from, offset - pos);
      }
      pos += gap;
      cursor = run.from;
    }
    if (pos + run.height > offset) {
      const whole = spanCost(metric, run.from, run.to);
      if (whole <= 0) {
        return run.from;
      }
      return seek(
        metric,
        run.from,
        run.to,
        ((offset - pos) / run.height) * whole,
      );
    }
    pos += run.height;
    cursor = run.to;
  }
  return seek(metric, cursor, total, offset - pos);
}

/** The last index in `[lo, hi]` whose span from `lo` still costs at most `y`.
 *  The inverse of `spanCost`, which is monotonic in the index but no longer a
 *  single division once a character term is in it. Clamped at `hi`, so a
 *  position past the end of the document reports the last block rather than
 *  an index nothing can render. */
function seek(metric: Metric, lo: number, hi: number, y: number): number {
  let low = lo;
  let high = Math.max(lo, hi);
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (spanCost(metric, lo, mid) <= y) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

/** What the reader was looking at, captured just before a height change so it
 *  can be restored after: the block under the top of the viewport, and how far
 *  into that block the viewport top had already gone.
 *
 *  A block and a fraction rather than `scrollTop / avgHeight`: that ratio was
 *  correct only while every unmeasured block was priced at one flat average,
 *  so the estimated part of the document scaled with the estimate the same way
 *  the content did. Once a gap costs a fixed amount per block plus an amount
 *  per character, no single divisor describes it, but the block under the
 *  viewport is still exactly what the reader is looking at.
 *
 *  Judged and restored against the scroller's real `scrollHeight -
 *  clientHeight`, not `contentHeight`: `.blocks` is absolutely positioned and
 *  free to overflow `.spacer` when the unmeasured tail is estimated shorter
 *  than it really is, so the DOM's own range is the only maximum that is never
 *  short of where the reader can actually scroll. */
export interface ScrollAnchor {
  pinnedBottom: boolean;
  block: number;
  fraction: number;
}

/** Height the model currently gives block `block` on its own. */
function blockHeight(runs: Run[], block: number, metric: Metric): number {
  return offsetOf(runs, block + 1, metric) - offsetOf(runs, block, metric);
}

/** `epsilon`: how many pixels short of the true maximum still counts as
 *  pinned. Browsers report `scrollTop` as an integer, so a max of, say,
 *  1804.6 is never exactly reached. */
export function captureScrollAnchor(
  scrollTop: number,
  realMax: number,
  runs: Run[],
  metric: Metric,
  epsilon = 1,
): ScrollAnchor {
  const block = blockAt(runs, scrollTop, metric);
  const top = offsetOf(runs, block, metric);
  const height = blockHeight(runs, block, metric);
  return {
    pinnedBottom: scrollTop >= realMax - epsilon,
    block,
    fraction:
      height > 0 ? Math.min(1, Math.max(0, (scrollTop - top) / height)) : 0,
  };
}

/** Whether the scroller's reported maximum has stopped changing between two
 *  successive reads, within the same one-pixel tolerance `captureScrollAnchor`
 *  uses. WebView2 can still report a pre-relayout `scrollHeight` on the frame
 *  right after a height change lands, while WebKit already reflects it — this
 *  is what lets the restore tell the two cases apart instead of trusting the
 *  first read. */
export function maxHasSettled(
  previous: number,
  current: number,
  epsilon = 1,
): boolean {
  return Math.abs(current - previous) < epsilon;
}

/** The `scrollTop` that restores `anchor` once `realMax` and the model have
 *  moved to their new values. Pinned-at-bottom stays pinned at the new real
 *  maximum regardless of how the estimate changed; otherwise the same block
 *  lands under the top of the viewport again, at the same fraction into it.
 *  Clamped to the new document's own scroll range either way. */
export function anchoredScrollTop(
  anchor: ScrollAnchor,
  realMax: number,
  runs: Run[],
  metric: Metric,
): number {
  if (anchor.pinnedBottom) {
    return realMax;
  }
  const top = offsetOf(runs, anchor.block, metric);
  const height = blockHeight(runs, anchor.block, metric);
  return Math.min(realMax, Math.max(0, top + anchor.fraction * height));
}

/** Turns each rendered block's own DOM position into the height it actually
 *  occupies, including the CSS margin space around it — the number
 *  `measure()` used to get by summing `offsetHeight` per block, but
 *  `offsetHeight` excludes margins entirely, and adjacent blocks' margins
 *  collapse to the larger of the two rather than adding, so neither
 *  `offsetHeight` alone nor `offsetHeight + marginTop + marginBottom` per
 *  block equals the space the browser actually gives it. A live DOM sample
 *  showed exactly this: 16 blocks summing to 867px of `offsetHeight` inside
 *  a container whose own `offsetHeight` was 1043px — 176px of margin the
 *  old measurement never saw, so every run this module ever recorded was
 *  short by roughly a fifth.
 *
 *  The distance between consecutive blocks' own rendered top edges already
 *  accounts for whatever margin collapsed between them, with no risk of
 *  double counting: `.blocks` is absolutely positioned, so it establishes
 *  its own block formatting context and no margin collapses through it,
 *  which is what makes `.blocks`' own `offsetHeight` a genuine ceiling that
 *  every returned height sums to exactly.
 *
 *  `tops[i]` is block `i`'s own rendered top (its first DOM node's
 *  `offsetTop`, relative to the container), or `null` for a block that
 *  produced no DOM node at all — e.g. a reference definition — which
 *  occupies no space of its own; the space around it is folded into
 *  whichever block precedes it. `containerHeight` is the container's own
 *  total height (`.blocks`' `offsetHeight`). The first block in `tops`
 *  additionally owns whatever margin space precedes its own top, back to
 *  the container's own top edge — its own top position does not otherwise
 *  enter the calculation, only its place in the sequence. */
export function blockHeightsFromTops(
  tops: ReadonlyArray<number | null>,
  containerHeight: number,
): number[] {
  const heights = new Array<number>(tops.length).fill(0);
  const contentIndices: number[] = [];
  for (let i = 0; i < tops.length; i += 1) {
    if (tops[i] !== null && tops[i] !== undefined) {
      contentIndices.push(i);
    }
  }
  for (let k = 0; k < contentIndices.length; k += 1) {
    const idx = contentIndices[k];
    if (idx === undefined) {
      continue;
    }
    const start = k === 0 ? 0 : (tops[idx] as number);
    const nextIdx = contentIndices[k + 1];
    const end =
      nextIdx !== undefined ? (tops[nextIdx] as number) : containerHeight;
    heights[idx] = end - start;
  }
  return heights;
}
