// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  computeVisibleWindow,
  lineToScrollTop,
  SAFE_SCROLL_HEIGHT,
  scrollAxisHeight,
} from './largeView';

describe('scrollAxisHeight', () => {
  it('uses the exact pixel height while it fits under the cap', () => {
    expect(scrollAxisHeight(1000, 20)).toBe(20_000);
  });

  it('caps the axis for documents past the browser scroll-height limit', () => {
    // 200M lines * 20px would be 4e9px, far beyond WebKit's ~33.5M limit.
    expect(scrollAxisHeight(200_000_000, 20)).toBe(SAFE_SCROLL_HEIGHT);
    expect(SAFE_SCROLL_HEIGHT).toBeLessThan(33_554_432);
  });
});

describe('computeVisibleWindow', () => {
  it('maps scroll offset to the first visible line by proportion', () => {
    // total 1001 (maxLine 1000), axis 20_020, viewport 20 => range 20_000.
    const w = computeVisibleWindow(10_000, 20, 20, 1001, 20_020, 0);
    expect(w.firstVisible).toBe(500);
    // ceil(20 / 20) + 1 = 2 rows fit.
    expect(w.visibleCount).toBe(2);
  });

  it('pads the render range by the overscan on both sides', () => {
    const w = computeVisibleWindow(10_000, 20, 20, 1001, 20_020, 50);
    expect(w.firstVisible).toBe(500);
    expect(w.startLine).toBe(450);
    expect(w.endLine).toBe(500 + 2 + 50);
  });

  it('bottom-aligns the tail: max scroll shows the last full viewport', () => {
    // Regression: scrolling to the very bottom must land the LAST line flush
    // with the viewport bottom (first visible = total - viewportLines), never
    // the last line alone at the top with emptiness below it.
    const axis = scrollAxisHeight(1000, 20);
    const range = axis - 400;
    const top = computeVisibleWindow(0, 20, 400, 1000, axis, 0);
    expect(top.firstVisible).toBe(0);
    const bottom = computeVisibleWindow(range, 20, 400, 1000, axis, 0);
    // viewport 400px / 20px rows = 20 lines on screen.
    expect(bottom.firstVisible).toBe(980);
    expect(bottom.endLine).toBe(1000);
  });

  it('keeps the last line reachable when the axis is capped', () => {
    // A file whose 1:1 height would overflow the browser limit: the cap must
    // not strand any lines. At the bottom of the travel the final line is the
    // last row of the viewport.
    const total = 200_000_000;
    const axis = scrollAxisHeight(total, 20);
    expect(axis).toBe(SAFE_SCROLL_HEIGHT);
    const range = axis - 800;
    const bottom = computeVisibleWindow(range, 20, 800, total, axis, 0);
    expect(bottom.firstVisible).toBe(total - 40);
    expect(bottom.endLine).toBe(total);
  });

  it('handles an empty document', () => {
    const w = computeVisibleWindow(0, 20, 400, 0, 0, 50);
    expect(w.firstVisible).toBe(0);
    expect(w.startLine).toBe(0);
    expect(w.endLine).toBe(0);
  });

  it('pins a single-line document to line 0 for any scroll offset', () => {
    const w = computeVisibleWindow(9999, 20, 400, 1, 20, 0);
    expect(w.firstVisible).toBe(0);
    expect(w.endLine).toBe(1);
  });

  it('never divides by a zero line height', () => {
    const w = computeVisibleWindow(100, 0, 400, 1000, 20_000, 0);
    expect(Number.isFinite(w.firstVisible)).toBe(true);
  });
});

describe('lineToScrollTop', () => {
  it('places line 0 at the top and the max first-visible at travel end', () => {
    const axis = scrollAxisHeight(1000, 20);
    expect(lineToScrollTop(0, 1000, 20, axis, 400)).toBe(0);
    // viewport 400px / 20px rows = 20 lines; 980 is the last valid top line.
    expect(lineToScrollTop(980, 1000, 20, axis, 400)).toBe(axis - 400);
  });

  it('clamps lines inside the last screen (and beyond) to the travel end', () => {
    const axis = scrollAxisHeight(1000, 20);
    expect(lineToScrollTop(-5, 1000, 20, axis, 400)).toBe(0);
    expect(lineToScrollTop(999, 1000, 20, axis, 400)).toBe(axis - 400);
    expect(lineToScrollTop(9999, 1000, 20, axis, 400)).toBe(axis - 400);
  });

  it('round-trips an exact line through the capped axis', () => {
    // scrollToLine -> computeVisibleWindow must return the same integer line,
    // even when many lines share a single scroll pixel. Lines past the max
    // first-visible cap cannot sit at the top; they must land on screen.
    const total = 200_000_000;
    const axis = scrollAxisHeight(total, 20);
    const viewport = 800;
    const maxFirst = total - 40;
    for (const line of [0, 1, 42, 1_234_567, 99_000_000, maxFirst]) {
      const top = lineToScrollTop(line, total, 20, axis, viewport);
      const w = computeVisibleWindow(top, 20, viewport, total, axis, 0);
      expect(w.firstVisible).toBe(line);
    }
    const tail = lineToScrollTop(total - 1, total, 20, axis, viewport);
    const w = computeVisibleWindow(tail, 20, viewport, total, axis, 0);
    expect(w.firstVisible).toBe(maxFirst);
    expect(w.endLine).toBe(total);
  });
});
