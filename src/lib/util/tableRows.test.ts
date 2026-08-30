// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  blockTopFor,
  MAX_SCROLL_HEIGHT,
  rowLayout,
  shouldCommitCell,
} from './tableRows';

const H = 23;

/** A table whose scroll axis is its true height — the ordinary case. */
function exact(
  start: number,
  end: number,
  rowCount: number,
  keep: readonly (number | null)[] = [],
): ReturnType<typeof rowLayout> {
  return rowLayout(start, end, rowCount, H, keep, start * H, rowCount * H);
}

/** The whole point of the spacers: the table must measure the height the
 *  scrollbar was told about, whatever is pinned. */
function totalHeight(
  start: number,
  end: number,
  rowCount: number,
  keep: readonly (number | null)[],
): number {
  const layout = exact(start, end, rowCount, keep);
  const rendered =
    (Math.min(end, rowCount) -
      Math.min(start, rowCount) +
      layout.pinned.length) *
    H;
  return layout.topSpacer + rendered + layout.bottomSpacer;
}

describe('rowLayout', () => {
  it('spaces out the rows on either side of the window', () => {
    const layout = exact(100, 140, 1000);
    expect(layout.pinned).toEqual([]);
    expect(layout.topSpacer).toBe(100 * H);
    expect(layout.bottomSpacer).toBe(860 * H);
  });

  it('needs no spacer when the window covers the whole table', () => {
    const layout = exact(0, 30, 30);
    expect(layout.topSpacer).toBe(0);
    expect(layout.bottomSpacer).toBe(0);
  });

  it('gives back the pinned row height from the top spacer', () => {
    const layout = exact(100, 140, 1000, [0]);
    expect(layout.pinned).toEqual([0]);
    expect(layout.topSpacer).toBe(99 * H);
    expect(layout.bottomSpacer).toBe(860 * H);
  });

  it('drops a row from below the window: it renders above the top spacer', () => {
    const layout = exact(100, 140, 1000, [900]);
    expect(layout.pinned).toEqual([]);
    expect(layout.topSpacer).toBe(100 * H);
    expect(layout.bottomSpacer).toBe(860 * H);
  });

  it('drops rows that are already in the window, out of range, or repeated', () => {
    expect(exact(100, 140, 1000, [120]).pinned).toEqual([]);
    expect(exact(100, 140, 1000, [null, -1, 1000]).pinned).toEqual([]);
    expect(exact(100, 140, 1000, [0, 0]).pinned).toEqual([0]);
  });

  it('keeps the table height exact in every one of those cases', () => {
    const cases: ReadonlyArray<[number, number, number, (number | null)[]]> = [
      [0, 0, 0, []],
      [0, 11, 1, []],
      [0, 30, 30, [0]],
      [100, 140, 1000, []],
      [100, 140, 1000, [0]],
      [100, 140, 1000, [0, 900]],
      [100, 140, 1000, [120]],
      [960, 1000, 1000, [0]],
      [0, 40, 270000, [269999]],
    ];
    for (const [start, end, rowCount, keep] of cases) {
      expect(totalHeight(start, end, rowCount, keep)).toBe(rowCount * H);
    }
  });

  it('clamps a window that runs past the end of the table', () => {
    const layout = exact(50, 200, 60);
    expect(layout.topSpacer).toBe(50 * H);
    expect(layout.bottomSpacer).toBe(0);
  });

  it('fills a compressed axis rather than the true document height', () => {
    // 2,000,000 rows want 46,000,000px, past what any engine will lay out.
    const rowCount = 2_000_000;
    const cap = MAX_SCROLL_HEIGHT;
    const blockTop = blockTopFor(990, 1000, 20_000, H, true);
    const layout = rowLayout(990, 1040, rowCount, H, [], blockTop, cap);
    const rendered = 50 * H;
    expect(layout.topSpacer + rendered + layout.bottomSpacer).toBe(cap);
    expect(layout.topSpacer).toBeLessThan(rowCount * H);
  });

  it('never returns a negative spacer at the end of a compressed axis', () => {
    const layout = rowLayout(500, 540, 2000, H, [], 990, 1000);
    expect(layout.topSpacer).toBeGreaterThanOrEqual(0);
    expect(layout.bottomSpacer).toBe(0);
  });
});

describe('blockTopFor', () => {
  it('is the row offset while the axis is the true height', () => {
    expect(blockTopFor(100, 110, 2530, H, false)).toBe(100 * H);
    // The scroll position is ignored: rows sit where their own height puts them.
    expect(blockTopFor(100, 110, 999999, H, false)).toBe(100 * H);
  });

  it('places the block against the scroll position once compressed', () => {
    // firstVisible is 10 rows into the block, so the block starts 10 rows above
    // the viewport top, wherever that currently is.
    expect(blockTopFor(990, 1000, 20_000, H, true)).toBe(20_000 - 10 * H);
  });

  it('never goes negative near the top of a compressed axis', () => {
    expect(blockTopFor(30, 40, 100, H, true)).toBe(0);
  });
});

describe('shouldCommitCell', () => {
  const doc = {};
  const pending = { r: 2, c: 3, document: doc };

  it('commits the cell that was typed into', () => {
    expect(shouldCommitCell(pending, 2, 3, doc)).toBe(true);
  });

  it('does not commit a cell that was only focused', () => {
    // An <input> cannot hold a newline, so a cell whose value contains one
    // hands back a copy with it stripped. Committing that on a bare
    // focus-and-blur deleted the newline with nothing having been edited.
    expect(shouldCommitCell(null, 2, 3, doc)).toBe(false);
  });

  it('does not commit a different cell', () => {
    expect(shouldCommitCell(pending, 2, 4, doc)).toBe(false);
    expect(shouldCommitCell(pending, 5, 3, doc)).toBe(false);
  });

  it('does not commit text typed against a document that has since changed', () => {
    expect(shouldCommitCell(pending, 2, 3, {})).toBe(false);
  });
});
