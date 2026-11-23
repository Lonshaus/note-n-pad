// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  DRAG_THRESHOLD,
  IDLE,
  dragStep,
  hoverAccepted,
  hoverCall,
  hoverGap,
  hoverShift,
  overTabBar,
  slideOffset,
  slotAt,
  translateXOf,
  type CancelReason,
  type DragInput,
  type DragOutcome,
  type DragState,
  type TabBarGeometry,
} from './tabDrag';
/** Four tabs of 100 px in a bar 300 px wide at the left of the viewport, 30 px
 *  high: the last tab is partly out of view when `scrollLeft` is above 100. */
function bar(scrollLeft = 0): TabBarGeometry {
  return {
    tabs: [0, 100, 200, 300].map((left) => ({ left, width: 100 })),
    scrollLeft,
    bar: { left: 0, right: 300, top: 0, bottom: 30 },
  };
}
/** Plays `inputs` through the machine from `IDLE`; the last result. */
function play(inputs: DragInput[], from: DragState = IDLE) {
  let state = from;
  let last = dragStep(state, { kind: 'click' });
  for (const input of inputs) {
    last = dragStep(state, input);
    state = last.state;
  }
  return last;
}
const down = (index = 1, x = 150, y = 15): DragInput => ({
  kind: 'down',
  x,
  y,
  index,
});
const move = (x: number, y = 15, scrollLeft = 0): DragInput => ({
  kind: 'move',
  x,
  y,
  geometry: bar(scrollLeft),
});
const up = (x: number, y = 15, scrollLeft = 0): DragInput => ({
  kind: 'up',
  x,
  y,
  geometry: bar(scrollLeft),
});

describe('slotAt', () => {
  it('counts the other tabs whose midpoint is left of the pointer', () => {
    // Midpoints at 50, 150, 250 and 350; the dragged tab is the first.
    expect(slotAt(149, bar(), 0)).toBe(0);
    expect(slotAt(151, bar(), 0)).toBe(1);
    expect(slotAt(251, bar(), 0)).toBe(2);
    // The dragged tab is the third.
    expect(slotAt(49, bar(), 2)).toBe(0);
    expect(slotAt(51, bar(), 2)).toBe(1);
    expect(slotAt(149, bar(), 2)).toBe(1);
    expect(slotAt(151, bar(), 2)).toBe(2);
  });

  it('ignores the midpoint of the dragged tab', () => {
    // Past its own midpoint (150) the tab still takes slot 1: only tab 0 is left.
    expect(slotAt(160, bar(), 1)).toBe(1);
    expect(slotAt(260, bar(), 1)).toBe(2);
  });

  it('is the first before the first tab and the last past the last', () => {
    expect(slotAt(-40, bar(), 1)).toBe(0);
    expect(slotAt(5000, bar(), 0)).toBe(3);
    expect(slotAt(5000, bar(), 3)).toBe(3);
  });

  it('adds the scroll offset of the bar', () => {
    // 150 px scrolled: the pointer at 10 is over content 160, right of the
    // midpoints 50 and 150.
    expect(slotAt(10, bar(150), 3)).toBe(2);
    expect(slotAt(10, bar(0), 3)).toBe(0);
    expect(slotAt(10, bar(400), 0)).toBe(3);
  });

  it('is measured from the left edge of the bar, not of the viewport', () => {
    const shifted: TabBarGeometry = {
      ...bar(),
      bar: { left: 50, right: 350, top: 0, bottom: 30 },
    };
    expect(slotAt(60, shifted, 3)).toBe(0);
    expect(slotAt(160, shifted, 3)).toBe(1);
  });

  it('is 0 for a bar without tabs', () => {
    expect(slotAt(10, { ...bar(), tabs: [] }, null)).toBe(0);
  });
});

describe('overTabBar', () => {
  it('is the bar box in viewport coordinates', () => {
    expect(overTabBar(10, 10, bar())).toBe(true);
    expect(overTabBar(10, 30, bar())).toBe(false);
    expect(overTabBar(10, -1, bar())).toBe(false);
    expect(overTabBar(300, 10, bar())).toBe(false);
    expect(overTabBar(-1, 10, bar())).toBe(false);
  });
});

describe('slideOffset', () => {
  it('moves the tabs between the old and the new slot toward the gap', () => {
    // The tab at 1 is dragged to 3: tabs 2 and 3 move left.
    expect([0, 1, 2, 3].map((i) => slideOffset(i, 1, 3, 100))).toEqual([
      0, 0, -100, -100,
    ]);
    // The tab at 3 is dragged to 1: tabs 1 and 2 move right.
    expect([0, 1, 2, 3].map((i) => slideOffset(i, 3, 1, 100))).toEqual([
      0, 100, 100, 0,
    ]);
    expect([0, 1, 2, 3].map((i) => slideOffset(i, 2, 2, 100))).toEqual([
      0, 0, 0, 0,
    ]);
  });
});

describe('the threshold', () => {
  it('starts a drag only past 4 px of travel', () => {
    expect(DRAG_THRESHOLD).toBe(4);
    const still = play([down(1, 150, 15), move(154, 15)]);
    expect(still.state.phase).toBe('pressed');
    const moved = play([down(1, 150, 15), move(155, 15)]);
    expect(moved.state.phase).toBe('dragging');
  });

  it('counts travel in both directions, diagonally too', () => {
    expect(play([down(1, 150, 15), move(150, 20)]).state.phase).toBe(
      'dragging',
    );
    expect(play([down(1, 150, 15), move(147, 18)]).state.phase).toBe(
      'dragging',
    );
    expect(play([down(1, 150, 15), move(153, 17)]).state.phase).toBe('pressed');
  });

  it('stays a drag once started, even back at the press point', () => {
    const r = play([down(1, 150, 15), move(200), move(150)]);
    expect(r.state.phase).toBe('dragging');
  });

  it('ignores moves without a press', () => {
    expect(play([move(200)]).state.phase).toBe('idle');
  });
});

describe('the slot and the bar while dragging', () => {
  it('follows the pointer along the tabs', () => {
    expect(play([down(1), move(260)]).state.slot).toBe(2);
    expect(play([down(1), move(260), move(20)]).state.slot).toBe(0);
  });

  it('uses the scroll offset of the bar at the time of the move', () => {
    expect(play([down(1), move(10, 15, 300)]).state.slot).toBe(2);
    expect(play([down(1), move(10, 15, 0)]).state.slot).toBe(0);
  });

  it('is past the end for a pointer right of the last tab', () => {
    const wide: TabBarGeometry = {
      ...bar(),
      bar: { left: 0, right: 600, top: 0, bottom: 30 },
    };
    const r = dragStep(dragStep(IDLE, down(0)).state, {
      kind: 'move',
      x: 550,
      y: 10,
      geometry: wide,
    });
    expect(r.state.slot).toBe(3);
    expect(r.state.overBar).toBe(true);
  });

  it('knows when the pointer left the bar', () => {
    expect(play([down(1), move(200, 15)]).state.overBar).toBe(true);
    expect(play([down(1), move(200, 80)]).state.overBar).toBe(false);
    expect(play([down(1), move(200, 80), move(200, 10)]).state.overBar).toBe(
      true,
    );
  });
});

describe('the outcome of a release', () => {
  it('is a click when the threshold was not crossed', () => {
    const r = play([down(1), move(152), up(152)]);
    expect(r.outcome).toEqual({ kind: 'click' });
    expect(r.state.phase).toBe('idle');
    expect(r.state.swallowClick).toBe(false);
  });

  it('is a release with the slot when it ends over the bar', () => {
    const r = play([down(1), move(260), up(260)]);
    expect(r.outcome).toEqual({ kind: 'release', slot: 2, overBar: true });
    expect(r.state.phase).toBe('idle');
  });

  it('is a release, not a return, inside the viewport but off the bar', () => {
    // The point is inside a viewport far larger than the bar; only the bar's
    // box decides what the release means.
    const r = play([down(1), move(260, 15), move(260, 400), up(260, 400)]);
    expect(r.outcome).toEqual({ kind: 'release', slot: 2, overBar: false });
  });

  it('is decided at the release point, not at the last move', () => {
    const r = play([down(1), move(260, 15), up(260, 200)]);
    expect(r.outcome).toEqual({ kind: 'release', slot: 2, overBar: false });
    const back = play([down(1), move(260, 200), up(40, 10)]);
    expect(back.outcome).toEqual({ kind: 'release', slot: 0, overBar: true });
  });

  it('is nothing without a press', () => {
    expect(play([up(10)]).outcome).toBeNull();
  });
});

describe('the click that follows a drag', () => {
  it('is swallowed once', () => {
    let state = play([down(1), move(260), up(260)]).state;
    const first = dragStep(state, { kind: 'click' });
    expect(first.swallowed).toBe(true);
    state = first.state;
    expect(dragStep(state, { kind: 'click' }).swallowed).toBe(false);
  });

  it('is not swallowed after a press that never became a drag', () => {
    const released = play([down(1), move(152), up(152)]);
    expect(dragStep(released.state, { kind: 'click' }).swallowed).toBe(false);
  });

  it('is not swallowed when no pointer event came before it', () => {
    expect(dragStep(IDLE, { kind: 'click' }).swallowed).toBe(false);
  });

  it('is not carried over to a later press', () => {
    const afterDrag = play([down(1), move(260), up(260)]).state;
    const nextPress = dragStep(afterDrag, down(2)).state;
    const clicked = play([up(150)], nextPress);
    expect(dragStep(clicked.state, { kind: 'click' }).swallowed).toBe(false);
  });
});

describe('cancelling', () => {
  const reasons: CancelReason[] = [
    'escape',
    'pointercancel',
    'lostcapture',
    'blur',
  ];

  it.each(reasons)('%s ends a drag with a cancel', (reason) => {
    const r = play([down(1), move(260), { kind: 'cancel', reason }]);
    expect(r.outcome).toEqual<DragOutcome>({ kind: 'cancel' });
    expect(r.state.phase).toBe('idle');
  });

  it.each(reasons)('%s ends a press before the threshold', (reason) => {
    const r = play([down(1), { kind: 'cancel', reason }]);
    expect(r.outcome).toEqual<DragOutcome>({ kind: 'cancel' });
    expect(r.state.phase).toBe('idle');
  });

  it('is nothing for the capture lost after a release', () => {
    const r = play([
      down(1),
      move(260),
      up(260),
      { kind: 'cancel', reason: 'lostcapture' },
    ]);
    expect(r.outcome).toBeNull();
    // The release left the click to swallow; the late cancel keeps it.
    expect(r.state.swallowClick).toBe(true);
  });

  it('swallows the click that still comes after Escape or a blur, not after the others', () => {
    for (const reason of reasons) {
      const cancelled = play([down(1), move(260), { kind: 'cancel', reason }]);
      const swallowed = dragStep(cancelled.state, { kind: 'click' }).swallowed;
      expect(swallowed).toBe(reason === 'escape' || reason === 'blur');
    }
  });

  it('ignores moves and a release that follow a cancel', () => {
    const cancelled = play([
      down(1),
      move(260),
      { kind: 'cancel', reason: 'escape' },
    ]);
    expect(play([move(100)], cancelled.state).state.phase).toBe('idle');
    expect(play([up(100)], cancelled.state).outcome).toBeNull();
  });
});

describe('hoverCall', () => {
  it('hovers while dragging off the own bar, whether or not it hovered before', () => {
    expect(
      hoverCall({
        dragging: true,
        overBar: false,
        hovering: false,
        transferable: true,
      }),
    ).toBe('hover');
    expect(
      hoverCall({
        dragging: true,
        overBar: false,
        hovering: true,
        transferable: true,
      }),
    ).toBe('hover');
  });

  it('ends a hover when the pointer is back over the own bar', () => {
    expect(
      hoverCall({
        dragging: true,
        overBar: true,
        hovering: true,
        transferable: true,
      }),
    ).toBe('end');
    expect(
      hoverCall({
        dragging: true,
        overBar: true,
        hovering: false,
        transferable: true,
      }),
    ).toBe('none');
  });

  it('ends a hover once the drag is over, and does nothing without one', () => {
    expect(
      hoverCall({
        dragging: false,
        overBar: false,
        hovering: true,
        transferable: true,
      }),
    ).toBe('end');
    expect(
      hoverCall({
        dragging: false,
        overBar: true,
        hovering: true,
        transferable: true,
      }),
    ).toBe('end');
    expect(
      hoverCall({
        dragging: false,
        overBar: false,
        hovering: false,
        transferable: true,
      }),
    ).toBe('none');
  });
});

describe('hoverCall for a tab that cannot be transferred', () => {
  it('does nothing off the own bar without a hover, and ends one', () => {
    expect(
      hoverCall({
        dragging: true,
        overBar: false,
        hovering: false,
        transferable: false,
      }),
    ).toBe('none');
    expect(
      hoverCall({
        dragging: true,
        overBar: false,
        hovering: true,
        transferable: false,
      }),
    ).toBe('end');
  });
});

describe('hoverAccepted', () => {
  it('accepts a window that is ready and not locked', () => {
    expect(hoverAccepted({ ready: true, locked: false })).toBe(true);
    expect(hoverAccepted({ ready: false, locked: false })).toBe(false);
    expect(hoverAccepted({ ready: true, locked: true })).toBe(false);
  });
});

describe('hoverShift', () => {
  it('moves the tabs from the slot on, by the width of the gap', () => {
    expect([0, 1, 2, 3].map((i) => hoverShift(i, 2, 90))).toEqual([
      0, 0, 90, 90,
    ]);
    expect([0, 1].map((i) => hoverShift(i, 2, 90))).toEqual([0, 0]);
  });
});

describe('translateXOf', () => {
  it('is 0 for none', () => {
    expect(translateXOf('none')).toBe(0);
  });

  it('is the e of a 2D matrix', () => {
    expect(translateXOf('matrix(1, 0, 0, 1, 90, 0)')).toBe(90);
    expect(translateXOf('matrix(1, 0, 0, 1, -37.5, 0)')).toBe(-37.5);
  });

  it('is the 13th value of a 3D matrix', () => {
    expect(
      translateXOf('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 42, 7, 0, 1)'),
    ).toBe(42);
  });
});

describe('hoverGap', () => {
  it('takes the width through unchanged and the offset to a client point', () => {
    const payload = { x: 450, y: 225, width: 90 };
    const one = hoverGap(payload, 'windows', 1);
    const two = hoverGap(payload, 'windows', 2);
    expect(one.width).toBe(90);
    expect(two.width).toBe(90);
    expect(one.point).toEqual({ x: 450, y: 225 });
    expect(two.point).toEqual({ x: 225, y: 112.5 });
  });

  it('keeps a macOS offset as it is', () => {
    expect(hoverGap({ x: 10, y: 20, width: 90 }, 'macos', 2)).toEqual({
      point: { x: 10, y: 20 },
      width: 90,
    });
  });
});
