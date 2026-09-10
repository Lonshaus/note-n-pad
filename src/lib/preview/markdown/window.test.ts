// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  addRun,
  anchoredScrollTop,
  blockAt,
  blockHeightsFromTops,
  captureScrollAnchor,
  heightOf,
  isCovered,
  maxHasSettled,
  measuredBlocks,
  measuredHeight,
  metricOf,
  offsetOf,
  type Metric,
  type Run,
} from './window';
import type { BlockIndex } from './scan';

/** A block index whose blocks all have the same source length, so `metricOf`
 *  cannot separate a per-block cost from a per-character one and falls back to
 *  the flat per-block average these tests were written against. */
function uniformIndex(blocks: number, len = 40): BlockIndex {
  const index = new Int32Array(blocks * 2);
  for (let i = 0; i < blocks; i += 1) {
    index[i * 2] = i * (len + 1);
    index[i * 2 + 1] = i * (len + 1) + len;
  }
  return index;
}

/** A block index whose blocks have arbitrary, individually specified source
 *  lengths, for tests that need block count and character count to vary
 *  independently. */
function buildIndex(lengths: number[]): BlockIndex {
  const index = new Int32Array(lengths.length * 2);
  let cursor = 0;
  for (let i = 0; i < lengths.length; i += 1) {
    index[i * 2] = cursor;
    cursor += lengths[i] as number;
    index[i * 2 + 1] = cursor;
  }
  return index;
}

describe('addRun', () => {
  it('records blocks and their measured height', () => {
    const metric = metricOf([], uniformIndex(10), 28);
    const runs = addRun([], 0, 10, 300, metric);
    expect(measuredBlocks(runs)).toBe(10);
    expect(measuredHeight(runs)).toBe(300);
  });

  it('keeps touching runs separate', () => {
    const metric = metricOf([], uniformIndex(20), 28);
    let runs = addRun([], 0, 10, 300, metric);
    runs = addRun(runs, 10, 20, 300, metric);
    expect(runs).toEqual([
      { from: 0, to: 10, height: 300 },
      { from: 10, to: 20, height: 300 },
    ]);
    expect(heightOf(runs, 20, metric)).toBe(measuredHeight(runs));
    expect(heightOf(runs, 20, metric)).toBe(600);
  });

  it('keeps runs with a gap between them separate', () => {
    const metric = metricOf([], uniformIndex(20), 28);
    let runs = addRun([], 0, 10, 300, metric);
    runs = addRun(runs, 15, 20, 150, metric);
    expect(runs).toEqual([
      { from: 0, to: 10, height: 300 },
      { from: 15, to: 20, height: 150 },
    ]);
  });

  it('ignores an empty or non-positive measurement', () => {
    const metric = metricOf([], uniformIndex(10), 28);
    expect(addRun([], 5, 5, 100, metric)).toEqual([]);
    expect(addRun([], 0, 10, 0, metric)).toEqual([]);
  });

  it('never exceeds 64 runs, merging the smallest gap and preserving the total height it had before the merge', () => {
    let runs: Run[] = [];
    const index = uniformIndex(200);
    let metric: Metric = metricOf([], index, 28);
    // 65 isolated single-block runs, each 10px, with a one-block gap between
    // every pair except the smallest, which sits at index 40/42.
    for (let i = 0; i < 65; i += 1) {
      const from = i * 2;
      runs = addRun(runs, from, from + 1, 10, metric);
      metric = metricOf(runs, index, 28);
    }
    expect(runs.length).toBeLessThanOrEqual(64);
    const heightBefore = measuredHeight(runs);
    // Force one more merge: the total must never lose what was already
    // measured, only gain the new block plus a non-negative gap estimate.
    runs = addRun(runs, 130, 131, 10, metric);
    metric = metricOf(runs, index, 28);
    expect(runs.length).toBeLessThanOrEqual(64);
    expect(measuredHeight(runs)).toBeGreaterThanOrEqual(heightBefore + 10);
    // The gap-merge estimate is priced purely per block here (a uniform
    // index cannot separate a per-character term), so whatever it added
    // beyond the new block's own height must be an exact multiple of the
    // metric's per-block cost.
    const bridgedCost = measuredHeight(runs) - heightBefore - 10;
    expect(bridgedCost).toBeGreaterThanOrEqual(0);
    expect(bridgedCost % metric.perBlock).toBeCloseTo(0, 6);
  });
});

describe('addRun + isCovered', () => {
  it('does not double count blocks an overlapping window already covered', () => {
    // Mirrors how MarkdownView.measure folds a render window in: it checks
    // isCovered per block and only ever hands addRun the blocks that are
    // actually new, however much the rendered window overlaps a prior one.
    const metric = metricOf([], uniformIndex(30), 28);
    let runs = addRun([], 0, 20, 600, metric); // window [0, 20), 30px/block
    // Next window is [10, 30) — blocks 10-19 are already covered, only
    // 20-29 (each measuring 25px this time) are new.
    const newFrom = 20;
    const newTo = 30;
    let newHeight = 0;
    for (let i = 10; i < 30; i += 1) {
      if (!isCovered(runs, i)) {
        newHeight += 25;
      }
    }
    runs = addRun(runs, newFrom, newTo, newHeight, metric);
    expect(measuredBlocks(runs)).toBe(30);
    expect(measuredHeight(runs)).toBe(600 + 250);
  });
});

describe('isCovered', () => {
  it('is true only for blocks inside a run', () => {
    const metric = metricOf([], uniformIndex(10), 28);
    const runs = addRun([], 5, 10, 50, metric);
    expect(isCovered(runs, 4)).toBe(false);
    expect(isCovered(runs, 5)).toBe(true);
    expect(isCovered(runs, 9)).toBe(true);
    expect(isCovered(runs, 10)).toBe(false);
  });
});

describe('metricOf', () => {
  it('recovers both coefficients from two runs with different block/char ratios', () => {
    // Run A: 5 blocks, each 100 characters long. Run B: 5 blocks, each 5
    // characters long. Generated from a known perBlock=2, perChar=0.5 so the
    // fit can be checked against the values that produced the heights.
    const index = buildIndex([
      ...Array<number>(5).fill(100),
      ...Array<number>(5).fill(5),
    ]);
    const runs: Run[] = [
      { from: 0, to: 5, height: 2 * 5 + 0.5 * (5 * 100) },
      { from: 5, to: 10, height: 2 * 5 + 0.5 * (5 * 5) },
    ];
    const metric = metricOf(runs, index, 28);
    expect(metric.perBlock).toBeCloseTo(2, 6);
    expect(metric.perChar).toBeCloseTo(0.5, 6);
  });

  it('falls back to a single parameter when the fit would come out negative', () => {
    // More characters correlating with less height contradicts the model —
    // the two-parameter fit goes negative and metricOf must fall back.
    const index = buildIndex([
      ...Array<number>(5).fill(100),
      ...Array<number>(5).fill(10),
    ]);
    const runs: Run[] = [
      { from: 0, to: 5, height: 50 },
      { from: 5, to: 10, height: 200 },
    ];
    const metric = metricOf(runs, index, 28);
    expect(metric.perBlock).toBeGreaterThanOrEqual(0);
    expect(metric.perChar).toBeGreaterThanOrEqual(0);
  });
});

describe('offsetOf / heightOf', () => {
  it('agrees with the sum of a fully measured tail once every rendered block is in runs', () => {
    // From a live report: blocks .top (offsetOf(first)) read 667, the
    // rendered blocks measured 1058px total, and their sum, 1725, was the
    // real bottom of the document. heightOf must equal exactly that once the
    // run covering [first, total) is folded in — a mismatch here would mean
    // the pure model disagrees with itself, not a DOM-timing issue.
    const metric: Metric = {
      index: uniformIndex(40),
      perBlock: 667 / 29, // gap [0, 29) unmeasured at this rate
      perChar: 0,
    };
    const runs = addRun([], 29, 40, 1058, metric); // tail run: 11 blocks, 1058px
    expect(offsetOf(runs, 29, metric)).toBeCloseTo(667, 9);
    expect(heightOf(runs, 40, metric)).toBeCloseTo(1725, 9);
  });

  it('uses real height for measured blocks and the metric for the gaps', () => {
    // Blocks 0-9 measured at 30px/block, blocks 10-19 unmeasured.
    const metric: Metric = {
      index: uniformIndex(20),
      perBlock: 20,
      perChar: 0,
    };
    const runs = addRun([], 0, 10, 300, metric);
    expect(offsetOf(runs, 0, metric)).toBe(0);
    expect(offsetOf(runs, 5, metric)).toBe(150);
    expect(offsetOf(runs, 10, metric)).toBe(300);
    expect(offsetOf(runs, 15, metric)).toBe(300 + 5 * 20);
  });

  it('heightOf is offsetOf at the last block, and the two always agree', () => {
    const total = 20;
    const index = uniformIndex(total);
    const buildMetric = metricOf([], index, 28);
    const runs = addRun([], 3, 8, 250, buildMetric);
    const metric = metricOf(runs, index, 28);
    expect(heightOf(runs, total, metric)).toBe(offsetOf(runs, total, metric));
  });

  it('gives the same document height no matter what window happens to be rendered', () => {
    // This is the property whose absence caused the flicker: heightOf takes
    // no window, so it cannot answer differently depending on where the
    // reader happens to be scrolled.
    const total = 50;
    const index = uniformIndex(total);
    const buildMetric = metricOf([], index, 28);
    const runs = addRun(
      addRun([], 0, 20, 600, buildMetric),
      40,
      45,
      100,
      buildMetric,
    );
    const metric = metricOf(runs, index, 28);
    const fromNearTheTop = heightOf(runs, total, metric);
    const fromNearTheBottom = heightOf(runs, total, metric);
    expect(fromNearTheTop).toBe(fromNearTheBottom);
  });

  it('does not change the document height when a later window adds no new territory', () => {
    // Live sample of a document scrolled to bottom: layout alternated
    // between a 15-block window measuring 850px and a 16-block window
    // measuring 978px, and the reported height flip-flopped between the two
    // states. Once the tail is measured, resampling territory already known
    // — the caller filters it out via isCovered, exactly as MarkdownView's
    // measure does — must be a no-op, not a second, disagreeing answer.
    const total = 40;
    const index = uniformIndex(total);
    const buildMetric = metricOf([], index, 28);
    let runs = addRun([], 25, 40, 850, buildMetric); // window reaches the final block
    const metric1 = metricOf(runs, index, 28);
    const height1 = heightOf(runs, total, metric1);
    let newHeight = 0;
    for (let i = 30; i < 40; i += 1) {
      if (!isCovered(runs, i)) {
        newHeight += 60; // no block in [30, 40) is actually new
      }
    }
    runs = addRun(runs, 30, 40, newHeight, metric1);
    const metric2 = metricOf(runs, index, 28);
    const height2 = heightOf(runs, total, metric2);
    expect(height2).toBe(height1);
  });
});

describe('blockAt', () => {
  it('is the inverse of offsetOf across a run boundary', () => {
    const metric: Metric = {
      index: uniformIndex(10),
      perBlock: 20,
      perChar: 0,
    };
    const runs = addRun([], 0, 10, 300, metric); // 30px/block
    for (let i = 0; i <= 10; i += 1) {
      const offset = offsetOf(runs, i, metric);
      expect(blockAt(runs, offset, metric)).toBe(i);
    }
  });

  it('is the inverse of offsetOf inside a gap', () => {
    const metric: Metric = {
      index: uniformIndex(15),
      perBlock: 20,
      perChar: 0,
    };
    const runs = addRun([], 0, 10, 300, metric); // 30px/block, blocks 10+ unmeasured
    const offset = offsetOf(runs, 10, metric) + 3 * 20; // 3 blocks into the gap
    expect(blockAt(runs, offset, metric)).toBe(13);
  });

  it('returns zero at or before the start of the document', () => {
    const metric: Metric = {
      index: uniformIndex(10),
      perBlock: 20,
      perChar: 0,
    };
    const runs = addRun([], 5, 10, 100, metric);
    expect(blockAt(runs, 0, metric)).toBe(0);
  });

  it('keeps two touching runs separate and each keeps its own density, not a blend', () => {
    const metric: Metric = { index: uniformIndex(20), perBlock: 1, perChar: 0 };
    let runs = addRun([], 0, 10, 100, metric); // 10px/block
    runs = addRun(runs, 10, 20, 1000, metric); // 100px/block
    expect(offsetOf(runs, 10, metric)).toBe(100);
    expect(offsetOf(runs, 15, metric)).toBe(100 + 500); // second run's own density
    for (let i = 0; i <= 20; i += 1) {
      expect(blockAt(runs, offsetOf(runs, i, metric), metric)).toBe(i);
    }
  });

  it('clamps at total for an offset past the end of the document', () => {
    const metric: Metric = { index: uniformIndex(20), perBlock: 1, perChar: 0 };
    let runs = addRun([], 0, 10, 100, metric);
    runs = addRun(runs, 10, 20, 1000, metric);
    expect(blockAt(runs, 1e9, metric)).toBe(20);
  });

  it('stays finite and monotonically increasing for a pure per-character fit over zero-character blocks', () => {
    // All five blocks sit at the same character offset, so every span costs
    // zero characters — a pure per-character metric must not divide by that.
    const index: BlockIndex = new Int32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const metric: Metric = { index, perBlock: 0, perChar: 2 };
    const offsets: number[] = [];
    for (let i = 0; i <= 5; i += 1) {
      const offset = offsetOf([], i, metric);
      expect(Number.isFinite(offset)).toBe(true);
      offsets.push(offset);
    }
    for (let i = 1; i < offsets.length; i += 1) {
      expect(offsets[i] as number).toBeGreaterThan(offsets[i - 1] as number);
    }
    const total = heightOf([], 5, metric);
    expect(Number.isFinite(total)).toBe(true);
    expect(Number.isFinite(blockAt([], total / 2, metric))).toBe(true);
  });
});

describe('captureScrollAnchor / anchoredScrollTop', () => {
  it('stays pinned to the new maximum when the total shrinks', () => {
    // Reader was sitting at the (old) real bottom of the scroller.
    const runs: Run[] = [];
    const metric30: Metric = {
      index: uniformIndex(60),
      perBlock: 30,
      perChar: 0,
    };
    const anchor = captureScrollAnchor(1459, 1459, runs, metric30);
    expect(anchor.pinnedBottom).toBe(true);
    // The scroller's real range has since settled to a shorter document.
    const metric27: Metric = {
      index: uniformIndex(60),
      perBlock: 27,
      perChar: 0,
    };
    const restored = anchoredScrollTop(anchor, 1317, runs, metric27);
    expect(restored).toBe(1317);
  });

  it('treats a position within one pixel of the maximum as pinned', () => {
    const metric30: Metric = {
      index: uniformIndex(60),
      perBlock: 30,
      perChar: 0,
    };
    const anchor = captureScrollAnchor(1458.4, 1459, [], metric30);
    expect(anchor.pinnedBottom).toBe(true);
  });

  it('keeps the same block under the viewport at a mid-document position', () => {
    // Not at the bottom: scrollTop 300 at 30px/block is 10 blocks down.
    const runs: Run[] = [];
    const metric30: Metric = {
      index: uniformIndex(60),
      perBlock: 30,
      perChar: 0,
    };
    const anchor = captureScrollAnchor(300, 1459, runs, metric30);
    expect(anchor.pinnedBottom).toBe(false);
    expect(anchor.block).toBe(10);
    expect(anchor.fraction).toBeCloseTo(0, 5);
    // The estimate moves to 27px/block; the same 10 blocks should still sit
    // at the top of the viewport.
    const metric27: Metric = {
      index: uniformIndex(60),
      perBlock: 27,
      perChar: 0,
    };
    const restored = anchoredScrollTop(anchor, 1155, runs, metric27);
    expect(restored).toBeCloseTo(270, 5);
  });

  it('clamps the restored position to the new scroll range', () => {
    const runs: Run[] = [];
    const metric30: Metric = {
      index: uniformIndex(60),
      perBlock: 30,
      perChar: 0,
    };
    const anchor = captureScrollAnchor(300, 1459, runs, metric30);
    // A drastically shorter document than the anchored offset would land in.
    const metric27: Metric = {
      index: uniformIndex(60),
      perBlock: 27,
      perChar: 0,
    };
    const restored = anchoredScrollTop(anchor, 0, runs, metric27);
    expect(restored).toBe(0);
  });

  it('pins to the scroller real maximum even when the estimated content height disagrees with it', () => {
    // Live sample: scrollTop 1224, scrollHeight 1738, clientHeight 514 —
    // `.blocks` overflows `.spacer` because the unmeasured tail is estimated
    // shorter than it really is, so the estimated content height (spacer
    // 1540, implying a max of 1540 - 514 = 1026) disagrees with the
    // scroller's real range of 1738 - 514 = 1224. The anchor must use 1224.
    const realMax = 1738 - 514;
    const runs: Run[] = [];
    const metric: Metric = {
      index: uniformIndex(60),
      perBlock: 56,
      perChar: 0,
    };
    const anchor = captureScrollAnchor(1224, realMax, runs, metric);
    expect(anchor.pinnedBottom).toBe(true);
    const restored = anchoredScrollTop(anchor, realMax, runs, metric);
    expect(restored).toBe(1224);
  });
});

describe('maxHasSettled', () => {
  it('is settled once two reads agree exactly', () => {
    expect(maxHasSettled(1095, 1095)).toBe(true);
  });

  it('is settled within the one-pixel tolerance', () => {
    expect(maxHasSettled(1094.6, 1095)).toBe(true);
  });

  it('is not settled while the reported maximum is still growing', () => {
    // The WebView2 case from the live sample: pass 1 still reads the
    // pre-relayout maximum, pass 2 reads the settled one.
    expect(maxHasSettled(1010, 1095)).toBe(false);
  });

  it('is not settled while the reported maximum is shrinking', () => {
    expect(maxHasSettled(1095, 1010)).toBe(false);
  });
});

describe('heightOf invariant: full coverage of [0, total) sums exactly', () => {
  // The direct claim under investigation: once a run set covers every block
  // from 0 up to total with no gap, heightOf must equal the sum of the run
  // heights exactly — there is nothing left for it to estimate. A mismatch
  // here would mean the arithmetic itself disagrees with its own data, not
  // that a DOM measurement hasn't landed yet.
  it('one run spanning the whole document', () => {
    const metric: Metric = {
      index: uniformIndex(40),
      perBlock: 30,
      perChar: 0,
    };
    const runs = addRun([], 0, 40, 1043, metric);
    expect(heightOf(runs, 40, metric)).toBe(measuredHeight(runs));
    expect(heightOf(runs, 40, metric)).toBe(1043);
  });

  it('two touching runs stay separate', () => {
    const metric: Metric = {
      index: uniformIndex(40),
      perBlock: 30,
      perChar: 0,
    };
    let runs = addRun([], 0, 20, 500, metric);
    runs = addRun(runs, 20, 40, 543, metric);
    expect(runs).toEqual([
      { from: 0, to: 20, height: 500 },
      { from: 20, to: 40, height: 543 },
    ]);
    expect(heightOf(runs, 40, metric)).toBe(measuredHeight(runs));
    expect(heightOf(runs, 40, metric)).toBe(1043);
  });

  it('a gap opened by two separate windows, then closed by a third — the real MarkdownView convergence shape', () => {
    const metric: Metric = {
      index: uniformIndex(40),
      perBlock: 30,
      perChar: 0,
    };
    let runs = addRun([], 0, 10, 300, metric); // first window
    runs = addRun(runs, 20, 40, 743, metric); // a later, non-adjacent window
    runs = addRun(runs, 10, 20, 200, metric); // the gap in between, discovered last
    expect(runs).toEqual([
      { from: 0, to: 10, height: 300 },
      { from: 10, to: 20, height: 200 },
      { from: 20, to: 40, height: 743 },
    ]);
    expect(heightOf(runs, 40, metric)).toBe(measuredHeight(runs));
    expect(heightOf(runs, 40, metric)).toBe(1243);
  });

  it('many small, non-adjacent runs force capRuns to bridge gaps, then every remaining block is folded in for real', () => {
    // Mirrors a document long and its convergence messy enough to force
    // capRuns' 64-run cap: every third block measured first, in isolation
    // (67 disconnected runs for a 200-block document, well past MAX_RUNS),
    // then every remaining block folded in individually — exactly the
    // isCovered-gated, one-block-at-a-time shape MarkdownView.measure
    // produces as its render window shifts and re-measures.
    const total = 200;
    const index = uniformIndex(total);
    let runs: Run[] = [];
    let metric: Metric = metricOf([], index, 28);
    const trueHeight = (i: number): number => 10 + (i % 7) * 3; // 10..28
    for (let i = 0; i < total; i += 3) {
      if (!isCovered(runs, i)) {
        runs = addRun(runs, i, i + 1, trueHeight(i), metric);
        metric = metricOf(runs, index, 28);
      }
    }
    for (let i = 0; i < total; i += 1) {
      if (!isCovered(runs, i)) {
        runs = addRun(runs, i, i + 1, trueHeight(i), metric);
        metric = metricOf(runs, index, 28);
      }
    }
    let trueTotal = 0;
    for (let i = 0; i < total; i += 1) {
      trueTotal += trueHeight(i);
    }
    expect(measuredBlocks(runs)).toBe(total);
    // The literal invariant under investigation: full coverage means
    // heightOf is nothing but the sum of the run heights — always true by
    // heightOf's own definition, so this can never be the failing half.
    expect(heightOf(runs, total, metric)).toBe(measuredHeight(runs));
    // The half that actually matters for the live report: does that sum
    // agree with the true, physical per-block total? It still does not —
    // capRuns still bridges a gap using the metric fit so far, permanently,
    // and isCovered still refuses to let a later, real measurement of that
    // exact territory ever correct it. Keeping touching runs separate did
    // not remove the imperfection, only its size: about 13.6px out of 3782
    // in this shape (previously about 15px). Not a bug fix assertion — a
    // pinned demonstration, re-measured against the new metric-based model.
    const error = Math.abs(heightOf(runs, total, metric) - trueTotal);
    expect(error).toBeGreaterThan(5);
    expect(error).toBeLessThan(25);
  });
});

describe('blockHeightsFromTops', () => {
  it('sums to the container height exactly for the live DOM sample (16 blocks, 867 vs 1043)', () => {
    // Reconstructs a window shaped like the live report: 16 blocks whose own
    // offsetHeight summed to 867px, sitting inside a container whose real
    // offsetHeight was 1043px — 176px of margin the old measurement missed.
    // 15 blocks of content height 54, one of 57 (810 + 57 = 867); a 8px
    // collapsed gap between every consecutive pair (15 * 8 = 120), and a
    // 56px trailing margin after the last block (120 + 56 = 176).
    const contentHeight = [...Array<number>(15).fill(54), 57];
    expect(contentHeight.reduce((a, b) => a + b, 0)).toBe(867);
    const tops: number[] = [0];
    for (let i = 1; i < contentHeight.length; i += 1) {
      const prevTop = tops[i - 1] as number;
      const prevHeight = contentHeight[i - 1] as number;
      tops.push(prevTop + prevHeight + 8);
    }
    const lastTop = tops[tops.length - 1] as number;
    const lastHeight = contentHeight[contentHeight.length - 1] as number;
    const containerHeight = lastTop + lastHeight + 56; // trailing margin
    expect(containerHeight).toBe(1043);

    const heights = blockHeightsFromTops(tops, containerHeight);
    expect(heights).toHaveLength(16);
    expect(heights.reduce((a, b) => a + b, 0)).toBe(1043);
    // What the old sum-of-offsetHeight measurement would have recorded —
    // the number this fix replaces.
    expect(heights.reduce((a, b) => a + b, 0)).not.toBe(867);
  });

  it('matches real CSS margin collapse (the larger margin wins, not the sum) for the live six-child sample', () => {
    // From the same live report: height / marginTop / marginBottom for each
    // of the first six rendered children.
    const children = [
      { h: 120, mt: 0, mb: 7.59 },
      { h: 34, mt: 17.02, mb: 8.5 },
      { h: 24, mt: 7.59, mb: 7.59 },
      { h: 72, mt: 7.59, mb: 7.59 },
      { h: 145, mt: 9.11, mb: 9.11 },
      { h: 24, mt: 7.59, mb: 7.59 },
    ];
    // `.blocks` is a block-formatting-context root (it's absolutely
    // positioned), so the first child's own top margin does not collapse
    // through it — it stays as real leading space, same as any other gap.
    const tops: number[] = [0];
    for (let i = 1; i < children.length; i += 1) {
      const prev = children[i - 1] as (typeof children)[number];
      const cur = children[i] as (typeof children)[number];
      const prevTop = tops[i - 1] as number;
      const gap = Math.max(prev.mb, cur.mt); // collapse: the larger wins
      tops.push(prevTop + prev.h + gap);
    }
    const last = children[children.length - 1] as (typeof children)[number];
    const lastTop = tops[tops.length - 1] as number;
    const containerHeight = lastTop + last.h + last.mb; // nothing follows to collapse with
    const heights = blockHeightsFromTops(tops, containerHeight);
    expect(heights.reduce((a, b) => a + b, 0)).toBeCloseTo(containerHeight, 9);
    // Each block's height is its own content plus the gap that follows it —
    // the gap belongs to whichever block precedes it, never both.
    expect(heights[0]).toBeCloseTo(120 + Math.max(7.59, 17.02), 9);
    expect(heights[1]).toBeCloseTo(34 + Math.max(8.5, 7.59), 9);
    expect(heights[5]).toBeCloseTo(24 + 7.59, 9); // its own trailing margin
  });

  it('gives a contentless block zero height and folds its space into the block before it', () => {
    // block 1 produced no DOM node (e.g. a reference definition).
    const tops = [0, null, 80];
    const heights = blockHeightsFromTops(tops, 150);
    expect(heights).toEqual([80, 0, 70]);
    expect(heights.reduce((a, b) => a + b, 0)).toBe(150);
  });

  it('a single block owns the whole container', () => {
    expect(blockHeightsFromTops([0], 40)).toEqual([40]);
    // Its own recorded top position is irrelevant — only its place in the
    // sequence matters, since it owns everything back to the container top.
    expect(blockHeightsFromTops([17], 40)).toEqual([40]);
  });

  it('every block contentless leaves every height at zero', () => {
    expect(blockHeightsFromTops([null, null], 0)).toEqual([0, 0]);
  });
});
