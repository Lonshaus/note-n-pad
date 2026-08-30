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

/** Mean height per measured block, or `seed` before anything is measured. */
export function averageHeight(runs: Run[], seed: number): number {
  const blocks = measuredBlocks(runs);
  return blocks > 0 ? measuredHeight(runs) / blocks : seed;
}

/** Sort by `from` and merge runs that touch or overlap, summing their
 *  heights. Assumes no two runs in the input genuinely overlap without also
 *  touching at a shared boundary — true of every run this module creates. */
function normalize(runs: Run[]): Run[] {
  const sorted = [...runs].sort((a, b) => a.from - b.from);
  const out: Run[] = [];
  for (const run of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && run.from <= last.to) {
      last.to = Math.max(last.to, run.to);
      last.height += run.height;
    } else {
      out.push({ ...run });
    }
  }
  return out;
}

/** Merge the two adjacent runs with the smallest gap until at most
 *  `MAX_RUNS` remain. The gap's blocks were never measured, so their share
 *  of the merged height is estimated at the current overall average — the
 *  only place this module estimates rather than measures, and only to keep
 *  memory bounded. */
function capRuns(runs: Run[]): Run[] {
  if (runs.length <= MAX_RUNS) {
    return runs;
  }
  const avg = measuredHeight(runs) / measuredBlocks(runs);
  let bestIndex = 0;
  let bestGap = Infinity;
  for (let i = 0; i < runs.length - 1; i += 1) {
    const current = runs[i];
    const next = runs[i + 1];
    if (current === undefined || next === undefined) {
      continue;
    }
    const gap = next.from - current.to;
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
    height: a.height + b.height + bestGap * avg,
  };
  const next = [
    ...runs.slice(0, bestIndex),
    merged,
    ...runs.slice(bestIndex + 2),
  ];
  return next.length > MAX_RUNS ? capRuns(next) : next;
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
): Run[] {
  if (to <= from || height <= 0) {
    return runs;
  }
  return capRuns(normalize([...runs, { from, to, height }]));
}

/** Cumulative height of blocks `0 .. index - 1`: real height for the parts
 *  covered by runs, `avg` per block for the gaps between them. */
export function offsetOf(runs: Run[], index: number, avg: number): number {
  let offset = 0;
  let cursor = 0;
  for (const run of runs) {
    if (run.from >= index) {
      break;
    }
    if (run.from > cursor) {
      offset += (run.from - cursor) * avg;
    }
    const end = Math.min(run.to, index);
    if (end > run.from) {
      const density = run.height / (run.to - run.from);
      offset += (end - run.from) * density;
    }
    cursor = Math.max(cursor, run.to);
    if (cursor >= index) {
      return offset;
    }
  }
  if (cursor < index) {
    offset += (index - cursor) * avg;
  }
  return offset;
}

/** The document's scrollable height. The same function as `offsetOf`,
 *  called at the last block — so a block's position and the document's
 *  height can never disagree, whatever `first`/`last` happen to be. */
export function heightOf(runs: Run[], total: number, avg: number): number {
  return offsetOf(runs, total, avg);
}

/** The block index whose span contains `offset`. The inverse of `offsetOf`:
 *  walks the same runs and gaps, stopping once the cumulative height would
 *  pass `offset`. */
export function blockAt(runs: Run[], offset: number, avg: number): number {
  if (offset <= 0) {
    return 0;
  }
  let cursor = 0;
  let pos = 0;
  for (const run of runs) {
    if (run.from > cursor) {
      const gapHeight = (run.from - cursor) * avg;
      if (pos + gapHeight > offset) {
        return cursor + Math.floor((offset - pos) / avg);
      }
      pos += gapHeight;
      cursor = run.from;
    }
    if (pos + run.height > offset) {
      const density = run.height / (run.to - run.from);
      return cursor + Math.floor((offset - pos) / density);
    }
    pos += run.height;
    cursor = run.to;
  }
  return cursor + Math.floor((offset - pos) / avg);
}

/** What the reader was looking at, captured just before a height change so it
 *  can be restored after. `blockIndex` is the fractional block offset under
 *  the top of the viewport (`scrollTop / avgHeight`), which scales with
 *  `avgHeight` the same way the content itself does — the arithmetic behind
 *  "keep the same content under the viewport" when the estimate moves.
 *
 *  Judged and restored against the scroller's real `scrollHeight -
 *  clientHeight`, not `contentHeight`: `.blocks` is absolutely positioned
 *  and free to overflow `.spacer` when the unmeasured tail is estimated
 *  shorter than it really is, so the DOM's own range is the only maximum
 *  that is never short of where the reader can actually scroll. */
export interface ScrollAnchor {
  pinnedBottom: boolean;
  blockIndex: number;
}

/** `epsilon`: how many pixels short of the true maximum still counts as
 *  pinned. Browsers report `scrollTop` as an integer, so a max of, say,
 *  1804.6 is never exactly reached. */
export function captureScrollAnchor(
  scrollTop: number,
  realMax: number,
  avgHeight: number,
  epsilon = 1,
): ScrollAnchor {
  return {
    pinnedBottom: scrollTop >= realMax - epsilon,
    blockIndex: avgHeight > 0 ? scrollTop / avgHeight : 0,
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

/** The `scrollTop` that restores `anchor` once `realMax`/`avgHeight` have
 *  moved to their new values. Pinned-at-bottom stays pinned at the new real
 *  maximum regardless of how the estimate changed; otherwise the same block
 *  offset lands under the top of the viewport again. Clamped to the new
 *  document's own scroll range either way. */
export function anchoredScrollTop(
  anchor: ScrollAnchor,
  realMax: number,
  avgHeight: number,
): number {
  if (anchor.pinnedBottom) {
    return realMax;
  }
  return Math.min(realMax, Math.max(0, anchor.blockIndex * avgHeight));
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
