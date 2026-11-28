// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  DRAG_THRESHOLD,
  GHOST_CLASS,
  IDLE,
  TAB_SELECTOR,
  TEAROFF_BAND,
  canTearOff,
  dragStep,
  dropSlot,
  ghostLeft,
  hoverAccepted,
  hoverAck,
  hoverCall,
  hoverGap,
  hoverShift,
  outsideStrip,
  overTabBar,
  slideOffset,
  slotAt,
  tearOffStart,
  translateXOf,
  type CancelReason,
  type DragInput,
  type DragOutcome,
  type DragState,
  type TabBarGeometry,
  type TearOffInput,
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

const tear = (over: Partial<TearOffInput> = {}): TearOffInput => ({
  canTearOff: true,
  onlyTab: false,
  blocked: false,
  mintId: () => 'drag-1',
  ...over,
});
const moveT = (x: number, y: number, over: Partial<TearOffInput> = {}) =>
  ({
    kind: 'move',
    x,
    y,
    geometry: bar(),
    tearOff: tear(over),
  }) satisfies DragInput;
/** A drag of the second tab that is under way inside the bar. */
const underway: DragInput[] = [down(1), move(200)];

describe('where the tab strip ends', () => {
  it('is the bar widened by 15 px above and below, and its own width', () => {
    expect(TEAROFF_BAND).toBe(15);
    const b = bar().bar;
    expect(outsideStrip(10, 10, b)).toBe(false);
    // 15 px above the top is still in the strip, 16 px is out.
    expect(outsideStrip(10, -15, b)).toBe(false);
    expect(outsideStrip(10, -16, b)).toBe(true);
    // Below the bottom (30): 14 px in, 15 px out (the band is half open).
    expect(outsideStrip(10, 44, b)).toBe(false);
    expect(outsideStrip(10, 45, b)).toBe(true);
    // Left of the bar and at its right edge are out; the last pixel is in.
    expect(outsideStrip(-1, 10, b)).toBe(true);
    expect(outsideStrip(299, 10, b)).toBe(false);
    expect(outsideStrip(300, 10, b)).toBe(true);
  });
});

describe('a tab that leaves its bar', () => {
  it('is detached when the pointer leaves the strip sideways', () => {
    const left = play([...underway, moveT(-1, 15)]);
    expect(left.outcome).toEqual({ kind: 'detach', id: 'drag-1' });
    expect(left.state.phase).toBe('detached');
    expect(left.state.tearOffId).toBe('drag-1');
    expect(play([...underway, moveT(300, 15)]).outcome).toEqual({
      kind: 'detach',
      id: 'drag-1',
    });
  });

  it('is detached when it leaves the band above or below, not before', () => {
    expect(play([...underway, moveT(100, -15)]).outcome).toBeNull();
    expect(play([...underway, moveT(100, -16)]).outcome).toEqual({
      kind: 'detach',
      id: 'drag-1',
    });
    expect(play([...underway, moveT(100, 44)]).outcome).toBeNull();
    expect(play([...underway, moveT(100, 45)]).outcome).toEqual({
      kind: 'detach',
      id: 'drag-1',
    });
  });

  it('moves the window instead when it is the only tab', () => {
    const r = play([...underway, moveT(100, 80, { onlyTab: true })]);
    expect(r.outcome).toEqual({ kind: 'moveWindow', id: 'drag-1' });
    expect(r.state.phase).toBe('moveWindow');
  });

  it('is nothing when something blocks the tab or the window cannot do it', () => {
    for (const over of [{ blocked: true }, { canTearOff: false }]) {
      const r = play([...underway, moveT(100, 80, over)]);
      expect(r.outcome).toBeNull();
      expect(r.state.phase).toBe('dragging');
      expect(r.state.overBar).toBe(false);
      // The release is the ordinary one.
      const up = dragStep(r.state, {
        kind: 'up',
        x: 100,
        y: 80,
        geometry: bar(),
      });
      expect(up.outcome).toEqual({ kind: 'release', slot: 1, overBar: false });
    }
    expect(play([...underway, move(100, 80)]).outcome).toBeNull();
  });

  it('is never started from a press that has not become a drag', () => {
    const r = play([down(1, 150, 15), moveT(150, 17)]);
    expect(r.state.phase).toBe('pressed');
    expect(r.outcome).toBeNull();
  });

  it('is decided by the window: a mouse, not Linux, not full screen', () => {
    expect(canTearOff('mouse', 'macos', false)).toBe(true);
    expect(canTearOff('mouse', 'windows', false)).toBe(true);
    expect(canTearOff('mouse', 'macos', true)).toBe(false);
    expect(canTearOff('touch', 'windows', false)).toBe(false);
    expect(canTearOff('pen', 'macos', false)).toBe(false);
    expect(canTearOff('mouse', 'linux', false)).toBe(false);
  });
});

describe('while the core follows the pointer', () => {
  const detached = [...underway, moveT(100, 80)];
  const moving = [...underway, moveT(100, 80, { onlyTab: true })];
  const cases: [string, DragInput[]][] = [
    ['detached', detached],
    ['moving', moving],
  ];

  it.each(cases)('ignores every move (%s)', (_name, inputs) => {
    const before = play(inputs).state;
    const after = play([...inputs, moveT(10, 10), move(250, 15)]);
    expect(after.state).toEqual(before);
    expect(after.outcome).toBeNull();
  });

  it.each(cases)('tells the core the button went up (%s)', (_name, inputs) => {
    const r = play([...inputs, up(100, 80)]);
    expect(r.outcome).toEqual({ kind: 'releaseSeen', id: 'drag-1' });
    expect(r.state.phase).toBe('idle');
    expect(r.state.swallowClick).toBe(true);
  });

  const reasons: CancelReason[] = ['pointercancel', 'lostcapture', 'blur'];
  it.each(cases)(
    'ends with no word to the core when the pointer or the focus is lost (%s)',
    (_name, inputs) => {
      for (const reason of reasons) {
        const r = play([...inputs, { kind: 'cancel', reason }]);
        expect(r.outcome).toBeNull();
        expect(r.state.phase).toBe('idle');
        expect(r.state.swallowClick).toBe(true);
      }
    },
  );

  it.each(cases)('tells the core of Esc and ends (%s)', (_name, inputs) => {
    const r = play([...inputs, { kind: 'cancel', reason: 'escape' }]);
    expect(r.outcome).toEqual({ kind: 'tearOffCancel', id: 'drag-1' });
    expect(r.state.phase).toBe('idle');
    expect(r.state.swallowClick).toBe(true);
  });

  it.each(cases)(
    'ends with the core, for its own id only (%s)',
    (_name, inputs) => {
      const other = play([...inputs, { kind: 'end', id: 'drag-0' }]);
      expect(other.state.phase).not.toBe('idle');
      const mine = play([...inputs, { kind: 'end', id: 'drag-1' }]);
      expect(mine.state.phase).toBe('idle');
      expect(mine.outcome).toBeNull();
      expect(mine.state.swallowClick).toBe(true);
      // The click that follows the release of the button is swallowed.
      expect(dragStep(mine.state, { kind: 'click' }).swallowed).toBe(true);
    },
  );

  it('ignores an end when nothing follows', () => {
    expect(play([...underway, { kind: 'end', id: 'drag-1' }]).state.phase).toBe(
      'dragging',
    );
    expect(play([{ kind: 'end', id: 'drag-1' }]).state.phase).toBe('idle');
  });

  it.each(cases)(
    'goes back to an ordinary drag when the core did not start, and tries no more (%s)',
    (_name, inputs) => {
      const r = play([...inputs, { kind: 'notStarted' }]);
      expect(r.state.phase).toBe('dragging');
      expect(r.state.index).toBe(1);
      // The pointer is still far out: no second offer.
      const again = dragStep(r.state, moveT(100, 90, { onlyTab: true }));
      expect(again.outcome).toBeNull();
      expect(again.state.phase).toBe('dragging');
      // The release behaves as it always did.
      const release = dragStep(again.state, up(100, 90));
      expect(release.outcome).toEqual({
        kind: 'release',
        slot: 1,
        overBar: false,
      });
      // A new press may tear the tab off again.
      const fresh = play([down(1), move(200), moveT(100, 90)]);
      expect(fresh.outcome).toEqual({ kind: 'detach', id: 'drag-1' });
    },
  );

  it('ignores a refusal that comes after the drag ended', () => {
    const r = play([
      ...detached,
      { kind: 'cancel', reason: 'escape' },
      { kind: 'notStarted' },
    ]);
    expect(r.state.phase).toBe('idle');
  });
});

describe('what the core is told when the tab leaves', () => {
  const geometry = (scrollLeft: number): TabBarGeometry => ({
    ...bar(scrollLeft),
    bar: { left: 10, right: 310, top: 2, bottom: 32 },
  });
  const start = (scrollLeft: number) =>
    tearOffStart({
      id: 'drag-1',
      pressed: { x: 155, y: 20 },
      geometry: geometry(scrollLeft),
      index: 1,
      dpr: 2,
      title: 'a.txt',
    });

  it('holds the tab where the button went down on it', () => {
    // The tab sits at 100 in the bar's content, 10 right of the viewport edge:
    // its slot starts at 110, and the press was 45 into it.
    expect(start(0)).toEqual({
      kind: 'tear_off',
      id: 'drag-1',
      grab: { x: 45, y: 20 },
      firstTabClientX: 10,
      escOffset: { x: 111, y: 17 },
      dpr: 2,
      width: 100,
      title: 'a.txt',
    });
  });

  it('measures the grab from the slot with the bar scrolled, and not the first tab', () => {
    const scrolled = start(300);
    // Scrolled 300 px, the slot is 300 further left: the press is 345 into it.
    expect(scrolled.grab).toEqual({ x: 345, y: 20 });
    // The tear-off's bar is not scrolled: its first tab starts where an
    // unscrolled bar's does.
    expect(scrolled.firstTabClientX).toBe(start(0).firstTabClientX);
    expect(scrolled.escOffset.x).toBe(start(0).escOffset.x - 300);
  });
});

describe('hoverAck', () => {
  const plain = { x: 10, y: 20, width: 90 };
  const follow = {
    ...plain,
    follow: { generation: 7, title: 'a.txt', grabX: 20 },
  };

  it('answers a hover of a follow with its generation and what the window takes right now', () => {
    expect(hoverAck(follow, true, false)).toEqual({
      generation: 7,
      accepted: true,
    });
    expect(hoverAck(follow, false, false)).toEqual({
      generation: 7,
      accepted: false,
    });
    expect(hoverAck(follow, true, true)).toEqual({
      generation: 7,
      accepted: false,
    });
  });

  it('is the same check that decides whether the gap and the tab are drawn', () => {
    for (const ready of [true, false]) {
      for (const locked of [true, false]) {
        expect(hoverAck(follow, ready, locked)?.accepted).toBe(
          hoverAccepted({ ready, locked }),
        );
      }
    }
  });

  it('answers nothing to a hover of a drag the sender leads itself', () => {
    expect(hoverAck(plain, true, false)).toBeNull();
    expect(hoverAck(plain, false, true)).toBeNull();
  });
});

describe('ghostLeft', () => {
  const barBox = { left: 10, right: 310 };

  it('puts the tab where the pointer holds it', () => {
    expect(ghostLeft({ x: 150 }, 45, 100, barBox)).toBe(105);
    expect(ghostLeft({ x: 150 }, 0, 100, barBox)).toBe(150);
  });

  it('keeps the tab inside the bar at both ends', () => {
    expect(ghostLeft({ x: 20 }, 45, 100, barBox)).toBe(10);
    expect(ghostLeft({ x: 305 }, 45, 100, barBox)).toBe(210);
    expect(ghostLeft({ x: 1000 }, 0, 100, barBox)).toBe(210);
  });

  it('keeps the left edge of a bar narrower than the tab', () => {
    expect(ghostLeft({ x: 100 }, 20, 400, barBox)).toBe(10);
  });
});

describe('the tab drawn under the pointer', () => {
  it('is not one of the tabs of the bar: its class is kept out of the geometry selector', () => {
    expect(GHOST_CLASS).toBe('tab-ghost');
    expect(TAB_SELECTOR).toBe(':scope > .tab:not(.tab-ghost)');
    // The ghost has the look of a tab, so only the exclusion keeps it out.
    expect(TAB_SELECTOR).toContain(`:not(.${GHOST_CLASS})`);
  });

  it('would move the slot of a point if it were measured as a tab, which is why it is left out', () => {
    const without = bar();
    // A ghost measured as a tab sits in the bar's boxes under the pointer.
    const withGhost = {
      ...bar(),
      tabs: [...bar().tabs, { left: 150, width: 100 }],
    };
    const point = { x: 250, y: 10 };
    expect(dropSlot(point, without)).toBe(2);
    expect(dropSlot(point, withGhost)).toBe(3);
  });
});
