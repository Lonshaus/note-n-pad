// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Where a tab dropped from another window goes on the tab bar, and how the
// core's offset becomes a point of this window.

import { describe, expect, it } from 'vitest';
import { dropSlot, toClientPoint, type TabBarGeometry } from './tabDrag';
/** Three tabs of 100 px in a bar 400 px wide at the left of the viewport, 30 px
 *  high. */
function bar(scrollLeft = 0): TabBarGeometry {
  return {
    tabs: [0, 100, 200].map((left) => ({ left, width: 100 })),
    scrollLeft,
    bar: { left: 0, right: 400, top: 0, bottom: 30 },
  };
}

describe('toClientPoint', () => {
  it('takes macOS points as they are: a CSS pixel is a point', () => {
    expect(toClientPoint({ x: 120.5, y: 40 }, 'macos', 2)).toEqual({
      x: 120.5,
      y: 40,
    });
  });

  it('divides a Windows offset by the device pixel ratio, text scaling included', () => {
    // A monitor scale of 1.0 with text scaling at 125%.
    expect(toClientPoint({ x: 250, y: 100 }, 'windows', 1.25)).toEqual({
      x: 200,
      y: 80,
    });
    expect(toClientPoint({ x: 450, y: 225 }, 'windows', 2.25)).toEqual({
      x: 200,
      y: 100,
    });
  });
});

describe('dropSlot', () => {
  it('is the tab under the point, by the rule of a reorder', () => {
    expect(dropSlot({ x: 10, y: 15 }, bar())).toBe(0);
    expect(dropSlot({ x: 99, y: 15 }, bar())).toBe(0);
    expect(dropSlot({ x: 100, y: 15 }, bar())).toBe(1);
    expect(dropSlot({ x: 250, y: 15 }, bar())).toBe(2);
  });

  it('counts the bar scrolled', () => {
    expect(dropSlot({ x: 10, y: 15 }, bar(100))).toBe(1);
  });

  it('appends past the last tab', () => {
    expect(dropSlot({ x: 300, y: 15 }, bar())).toBe(3);
    expect(dropSlot({ x: 399, y: 15 }, bar())).toBe(3);
    expect(dropSlot({ x: 5, y: 15 }, { ...bar(), tabs: [] })).toBe(0);
  });

  it('is none below the tab bar', () => {
    expect(dropSlot({ x: 50, y: 30 }, bar())).toBeNull();
    expect(dropSlot({ x: 50, y: 300 }, bar())).toBeNull();
    expect(dropSlot({ x: 50, y: 29.5 }, bar())).toBe(0);
  });
});
