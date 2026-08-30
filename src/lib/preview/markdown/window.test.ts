// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  addRun,
  anchoredScrollTop,
  averageHeight,
  blockAt,
  blockHeightsFromTops,
  captureScrollAnchor,
  heightOf,
  isCovered,
  maxHasSettled,
  measuredBlocks,
  measuredHeight,
  offsetOf,
  type Run,
} from './window';

describe('addRun', () => {
  it('records blocks and their measured height', () => {
    const runs = addRun([], 0, 10, 300);
    expect(measuredBlocks(runs)).toBe(10);
    expect(measuredHeight(runs)).toBe(300);
  });

  it('merges runs that touch', () => {
    let runs = addRun([], 0, 10, 300);
    runs = addRun(runs, 10, 20, 300);
    expect(runs).toEqual([{ from: 0, to: 20, height: 600 }]);
  });

  it('keeps runs with a gap between them separate', () => {
    let runs = addRun([], 0, 10, 300);
    runs = addRun(runs, 15, 20, 150);
    expect(runs).toEqual([
      { from: 0, to: 10, height: 300 },
      { from: 15, to: 20, height: 150 },
    ]);
  });

  it('ignores an empty or non-positive measurement', () => {
    expect(addRun([], 5, 5, 100)).toEqual([]);
    expect(addRun([], 0, 10, 0)).toEqual([]);
  });

  it('never exceeds 64 runs, merging the smallest gap and preserving the total height it had before the merge', () => {
    let runs: Run[] = [];
    // 65 isolated single-block runs, each 10px, with a one-block gap between
    // every pair except the smallest, which sits at index 40/42.
    for (let i = 0; i < 65; i += 1) {
      const from = i * 2;
      runs = addRun(runs, from, from + 1, 10);
    }
    expect(runs.length).toBeLessThanOrEqual(64);
    const heightBefore = measuredHeight(runs);
    // Force one more merge: the total must never lose what was already
    // measured, only gain the new block plus a non-negative gap estimate.
    runs = addRun(runs, 130, 131, 10);
    expect(runs.length).toBeLessThanOrEqual(64);
    expect(measuredHeight(runs)).toBeGreaterThanOrEqual(heightBefore + 10);
  });
});

describe('addRun + isCovered', () => {
  it('does not double count blocks an overlapping window already covered', () => {
    // Mirrors how MarkdownView.measure folds a render window in: it checks
    // isCovered per block and only ever hands addRun the blocks that are
    // actually new, however much the rendered window overlaps a prior one.
    let runs = addRun([], 0, 20, 600); // window [0, 20), 30px/block
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
    runs = addRun(runs, newFrom, newTo, newHeight);
    expect(measuredBlocks(runs)).toBe(30);
    expect(measuredHeight(runs)).toBe(600 + 250);
  });
});

describe('isCovered', () => {
  it('is true only for blocks inside a run', () => {
    const runs = addRun([], 5, 10, 50);
    expect(isCovered(runs, 4)).toBe(false);
    expect(isCovered(runs, 5)).toBe(true);
    expect(isCovered(runs, 9)).toBe(true);
    expect(isCovered(runs, 10)).toBe(false);
  });
});

describe('averageHeight', () => {
  it('returns the seed before anything has been measured', () => {
    expect(averageHeight([], 28)).toBe(28);
  });

  it('is the overall mean height per measured block', () => {
    const runs = addRun(addRun([], 0, 10, 300), 20, 25, 100);
    expect(averageHeight(runs, 28)).toBe(400 / 15);
  });
});

describe('offsetOf / heightOf', () => {
  it('agrees with the sum of a fully measured tail once every rendered block is in runs', () => {
    // From a live report: blocks .top (offsetOf(first)) read 667, the
    // rendered blocks measured 1058px total, and their sum, 1725, was the
    // real bottom of the document. heightOf must equal exactly that once the
    // run covering [first, total) is folded in — a mismatch here would mean
    // the pure model disagrees with itself, not a DOM-timing issue.
    const avg = 667 / 29; // gap [0, 29) unmeasured at this average
    const runs = addRun([], 29, 40, 1058); // tail run: 11 blocks, 1058px
    expect(offsetOf(runs, 29, avg)).toBeCloseTo(667, 9);
    expect(heightOf(runs, 40, avg)).toBeCloseTo(1725, 9);
  });

  it('uses real height for measured blocks and avg for the gaps', () => {
    // Blocks 0-9 measured at 30px/block, blocks 10-19 unmeasured.
    const runs = addRun([], 0, 10, 300);
    const avg = 20;
    expect(offsetOf(runs, 0, avg)).toBe(0);
    expect(offsetOf(runs, 5, avg)).toBe(150);
    expect(offsetOf(runs, 10, avg)).toBe(300);
    expect(offsetOf(runs, 15, avg)).toBe(300 + 5 * avg);
  });

  it('heightOf is offsetOf at the last block, and the two always agree', () => {
    const runs = addRun([], 3, 8, 250);
    const total = 20;
    const avg = averageHeight(runs, 28);
    expect(heightOf(runs, total, avg)).toBe(offsetOf(runs, total, avg));
  });

  it('gives the same document height no matter what window happens to be rendered', () => {
    // This is the property whose absence caused the flicker: heightOf takes
    // no window, so it cannot answer differently depending on where the
    // reader happens to be scrolled.
    const runs = addRun(addRun([], 0, 20, 600), 40, 45, 100);
    const avg = averageHeight(runs, 28);
    const total = 50;
    const fromNearTheTop = heightOf(runs, total, avg);
    const fromNearTheBottom = heightOf(runs, total, avg);
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
    let runs = addRun([], 25, 40, 850); // window reaches the final block
    const avg1 = averageHeight(runs, 28);
    const height1 = heightOf(runs, total, avg1);
    let newHeight = 0;
    for (let i = 30; i < 40; i += 1) {
      if (!isCovered(runs, i)) {
        newHeight += 60; // no block in [30, 40) is actually new
      }
    }
    runs = addRun(runs, 30, 40, newHeight);
    const avg2 = averageHeight(runs, 28);
    const height2 = heightOf(runs, total, avg2);
    expect(height2).toBe(height1);
  });
});

describe('blockAt', () => {
  it('is the inverse of offsetOf across a run boundary', () => {
    const runs = addRun([], 0, 10, 300); // 30px/block
    const avg = 20;
    for (let i = 0; i <= 10; i += 1) {
      const offset = offsetOf(runs, i, avg);
      expect(blockAt(runs, offset, avg)).toBe(i);
    }
  });

  it('is the inverse of offsetOf inside a gap', () => {
    const runs = addRun([], 0, 10, 300); // 30px/block, blocks 10+ unmeasured
    const avg = 20;
    const offset = offsetOf(runs, 10, avg) + 3 * avg; // 3 blocks into the gap
    expect(blockAt(runs, offset, avg)).toBe(13);
  });

  it('returns zero at or before the start of the document', () => {
    const runs = addRun([], 5, 10, 100);
    expect(blockAt(runs, 0, 20)).toBe(0);
  });
});

describe('captureScrollAnchor / anchoredScrollTop', () => {
  it('stays pinned to the new maximum when the total shrinks', () => {
    // Reader was sitting at the (old) real bottom of the scroller.
    const anchor = captureScrollAnchor(1459, 1459, 30);
    expect(anchor.pinnedBottom).toBe(true);
    // The scroller's real range has since settled to a shorter document.
    const restored = anchoredScrollTop(anchor, 1317, 27);
    expect(restored).toBe(1317);
  });

  it('treats a position within one pixel of the maximum as pinned', () => {
    const anchor = captureScrollAnchor(1458.4, 1459, 30);
    expect(anchor.pinnedBottom).toBe(true);
  });

  it('keeps the same block under the viewport at a mid-document position', () => {
    // Not at the bottom: scrollTop 300 at 30px/block is 10 blocks down.
    const anchor = captureScrollAnchor(300, 1459, 30);
    expect(anchor.pinnedBottom).toBe(false);
    // The estimate moves to 27px/block; the same 10 blocks should still sit
    // at the top of the viewport.
    const restored = anchoredScrollTop(anchor, 1155, 27);
    expect(restored).toBeCloseTo(270, 5);
  });

  it('clamps the restored position to the new scroll range', () => {
    const anchor = captureScrollAnchor(300, 1459, 30);
    // A drastically shorter document than the anchored offset would land in.
    const restored = anchoredScrollTop(anchor, 0, 27);
    expect(restored).toBe(0);
  });

  it('pins to the scroller real maximum even when the estimated content height disagrees with it', () => {
    // Live sample: scrollTop 1224, scrollHeight 1738, clientHeight 514 —
    // `.blocks` overflows `.spacer` because the unmeasured tail is estimated
    // shorter than it really is, so the estimated content height (spacer
    // 1540, implying a max of 1540 - 514 = 1026) disagrees with the
    // scroller's real range of 1738 - 514 = 1224. The anchor must use 1224.
    const realMax = 1738 - 514;
    const anchor = captureScrollAnchor(1224, realMax, 56);
    expect(anchor.pinnedBottom).toBe(true);
    const restored = anchoredScrollTop(anchor, realMax, 56);
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
    const runs = addRun([], 0, 40, 1043);
    expect(heightOf(runs, 40, 30)).toBe(measuredHeight(runs));
    expect(heightOf(runs, 40, 30)).toBe(1043);
  });

  it('two touching runs merged by normalize into full coverage', () => {
    let runs = addRun([], 0, 20, 500);
    runs = addRun(runs, 20, 40, 543);
    expect(runs).toEqual([{ from: 0, to: 40, height: 1043 }]);
    expect(heightOf(runs, 40, 30)).toBe(measuredHeight(runs));
    expect(heightOf(runs, 40, 30)).toBe(1043);
  });

  it('a gap opened by two separate windows, then closed by a third — the real MarkdownView convergence shape', () => {
    let runs = addRun([], 0, 10, 300); // first window
    runs = addRun(runs, 20, 40, 743); // a later, non-adjacent window
    runs = addRun(runs, 10, 20, 200); // the gap in between, discovered last
    expect(runs).toEqual([{ from: 0, to: 40, height: 1243 }]);
    expect(heightOf(runs, 40, 30)).toBe(measuredHeight(runs));
    expect(heightOf(runs, 40, 30)).toBe(1243);
  });

  it('many small, non-adjacent runs force capRuns to bridge gaps, then every remaining block is folded in for real', () => {
    // Mirrors a document long and its convergence messy enough to force
    // capRuns' 64-run cap: every third block measured first, in isolation
    // (67 disconnected runs for a 200-block document, well past MAX_RUNS),
    // then every remaining block folded in individually — exactly the
    // isCovered-gated, one-block-at-a-time shape MarkdownView.measure
    // produces as its render window shifts and re-measures.
    const total = 200;
    let runs: Run[] = [];
    const trueHeight = (i: number): number => 10 + (i % 7) * 3; // 10..28
    for (let i = 0; i < total; i += 3) {
      if (!isCovered(runs, i)) {
        runs = addRun(runs, i, i + 1, trueHeight(i));
      }
    }
    for (let i = 0; i < total; i += 1) {
      if (!isCovered(runs, i)) {
        runs = addRun(runs, i, i + 1, trueHeight(i));
      }
    }
    let trueTotal = 0;
    for (let i = 0; i < total; i += 1) {
      trueTotal += trueHeight(i);
    }
    expect(measuredBlocks(runs)).toBe(total);
    const avg = averageHeight(runs, 28);
    // The literal invariant under investigation: full coverage means
    // heightOf is nothing but the sum of the run heights — always true by
    // heightOf's own definition, so this can never be the failing half.
    expect(heightOf(runs, total, avg)).toBe(measuredHeight(runs));
    // The half that actually matters for the live report: does that sum
    // agree with the true, physical per-block total? It does not — capRuns
    // bridges a gap using the average measured *so far*, permanently, and
    // isCovered then refuses to let a later, real measurement of that exact
    // territory ever correct it, even once every block has genuinely been
    // measured on its own. This is not a failure of heightOf's arithmetic;
    // it is `runs` itself carrying a stale estimate that nothing can reach
    // again. Documented here, not asserted as a bug fix — see the report.
    // Not a bug fix assertion — a pinned demonstration. This is currently
    // nonzero (about 15px out of 3782 in this shape): capRuns bridged a gap
    // using the average measured so far, and isCovered never lets that
    // territory be re-measured for real afterward, even once every block
    // genuinely has been. See the report for whether this is worth fixing.
    expect(Math.abs(heightOf(runs, total, avg) - trueTotal)).toBeGreaterThan(5);
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
