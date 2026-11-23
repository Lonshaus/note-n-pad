// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Pointer travel, in CSS pixels, past which a press on a tab becomes a drag. */
export const DRAG_THRESHOLD = 4;
/** Where the tabs are. The tab boxes are in the bar's content coordinates (the
 *  scroll offset not applied); `bar` is the bar's box in viewport coordinates. */
export interface TabBarGeometry {
  tabs: readonly { left: number; width: number }[];
  scrollLeft: number;
  bar: { left: number; right: number; top: number; bottom: number };
}
/** The index the dragged tab takes when released at viewport point `x`: the
 *  number of tabs other than `from` whose midpoint is left of the pointer. */
export function slotAt(
  x: number,
  geometry: TabBarGeometry,
  from: number | null,
): number {
  const content = x - geometry.bar.left + geometry.scrollLeft;
  let slot = 0;
  geometry.tabs.forEach((tab, i) => {
    if (i !== from && tab.left + tab.width / 2 < content) {
      slot += 1;
    }
  });
  return slot;
}
/** The index a tab dropped from another window takes at viewport point `point`:
 *  the number of tabs whose midpoint is left of it, so a point past the last
 *  midpoint appends (`tabs.length`). Null when the point is below the tab bar. */
export function dropSlot(
  point: { x: number; y: number },
  geometry: TabBarGeometry,
): number | null {
  if (point.y >= geometry.bar.bottom) {
    return null;
  }
  return slotAt(point.x, geometry, null);
}
/** The client point (CSS pixels of this window's viewport) of `offset`, the
 *  core's distance from this window's inner origin in native units. A CSS pixel
 *  is a point on macOS; on Windows it is `devicePixelRatio` physical pixels,
 *  which includes the user's text scaling and not only the monitor's scale. */
export function toClientPoint(
  offset: { x: number; y: number },
  os: string,
  devicePixelRatio: number,
): { x: number; y: number } {
  if (os !== 'windows') {
    return { x: offset.x, y: offset.y };
  }
  return { x: offset.x / devicePixelRatio, y: offset.y / devicePixelRatio };
}
/** Whether the viewport point is over the tab bar's box. */
export function overTabBar(
  x: number,
  y: number,
  geometry: TabBarGeometry,
): boolean {
  const bar = geometry.bar;
  return x >= bar.left && x < bar.right && y >= bar.top && y < bar.bottom;
}
/** How far the tab at `index` slides while the tab at `from` is dragged to
 *  `slot`: toward the gap the dragged tab left, by the dragged tab's `width`. */
export function slideOffset(
  index: number,
  from: number,
  slot: number,
  width: number,
): number {
  if (index > from && index <= slot) {
    return -width;
  }
  if (index < from && index >= slot) {
    return width;
  }
  return 0;
}
/** What the sender does about the hover feedback in another window. */
export type HoverCall = 'hover' | 'end' | 'none';
/** The call for one moment of a drag: a hover while the pointer is off the own
 *  bar and the tab can be transferred, an end when a hover was sent and is no
 *  longer due. */
export function hoverCall(state: {
  dragging: boolean;
  overBar: boolean;
  hovering: boolean;
  transferable: boolean;
}): HoverCall {
  if (state.dragging && !state.overBar && state.transferable) {
    return 'hover';
  }
  return state.hovering ? 'end' : 'none';
}
/** Whether this window shows a gap for a tab hovering over it: it would accept
 *  the tab. */
export function hoverAccepted(state: {
  ready: boolean;
  locked: boolean;
}): boolean {
  return state.ready && !state.locked;
}
/** How far the tab at `index` moves aside for a gap at `slot`. */
export function hoverShift(index: number, slot: number, width: number): number {
  return index >= slot ? width : 0;
}
/** The horizontal translation of a computed `transform` value. */
export function translateXOf(transform: string): number {
  const open = transform.indexOf('(');
  if (open < 0) {
    return 0;
  }
  const values = transform
    .slice(open + 1, transform.lastIndexOf(')'))
    .split(',')
    .map(Number);
  const x = transform.startsWith('matrix3d') ? values[12] : values[4];
  return x === undefined || Number.isNaN(x) ? 0 : x;
}
/** The hover event's offset as a client point of this window; the width is a CSS
 *  pixel width already and passes through unchanged. */
export function hoverGap(
  payload: { x: number; y: number; width: number },
  os: string,
  devicePixelRatio: number,
): { point: { x: number; y: number }; width: number } {
  return {
    point: toClientPoint(payload, os, devicePixelRatio),
    width: payload.width,
  };
}
/** What took the mouse away from a drag. */
export type CancelReason = 'escape' | 'pointercancel' | 'lostcapture' | 'blur';
export type DragInput =
  | { kind: 'down'; x: number; y: number; index: number }
  | { kind: 'move'; x: number; y: number; geometry: TabBarGeometry }
  | { kind: 'up'; x: number; y: number; geometry: TabBarGeometry }
  | { kind: 'cancel'; reason: CancelReason }
  | { kind: 'click' };
export interface DragState {
  phase: 'idle' | 'pressed' | 'dragging';
  /** The pressed tab's index. */
  index: number;
  startX: number;
  startY: number;
  /** The slot at the last pointer position. */
  slot: number;
  /** Whether the last pointer position was over the own tab bar. */
  overBar: boolean;
  /** The next click is the tail of a drag. */
  swallowClick: boolean;
}
/** What an event decided. A `release` is any release after the threshold, on the
 *  tab bar or not: `overBar` says which, and the viewport alone never does. */
export type DragOutcome =
  | { kind: 'click' }
  | { kind: 'release'; slot: number; overBar: boolean }
  | { kind: 'cancel' };
export interface DragResult {
  state: DragState;
  outcome: DragOutcome | null;
  /** The `click` event is the tail of a drag and must do nothing. */
  swallowed: boolean;
}
export const IDLE: DragState = {
  phase: 'idle',
  index: 0,
  startX: 0,
  startY: 0,
  slot: 0,
  overBar: false,
  swallowClick: false,
};
/** The drag state machine: pure, one event in, the next state and the decision out. */
export function dragStep(state: DragState, event: DragInput): DragResult {
  switch (event.kind) {
    case 'down':
      return {
        state: {
          ...IDLE,
          phase: 'pressed',
          index: event.index,
          startX: event.x,
          startY: event.y,
          slot: event.index,
        },
        outcome: null,
        swallowed: false,
      };
    case 'move': {
      if (state.phase === 'idle') {
        return { state, outcome: null, swallowed: false };
      }
      if (
        state.phase === 'pressed' &&
        Math.hypot(event.x - state.startX, event.y - state.startY) <=
          DRAG_THRESHOLD
      ) {
        return { state, outcome: null, swallowed: false };
      }
      return {
        state: {
          ...state,
          phase: 'dragging',
          slot: slotAt(event.x, event.geometry, state.index),
          overBar: overTabBar(event.x, event.y, event.geometry),
        },
        outcome: null,
        swallowed: false,
      };
    }
    case 'up': {
      if (state.phase === 'idle') {
        return { state, outcome: null, swallowed: false };
      }
      if (state.phase === 'pressed') {
        return {
          state: IDLE,
          outcome: { kind: 'click' },
          swallowed: false,
        };
      }
      return {
        state: { ...IDLE, swallowClick: true },
        outcome: {
          kind: 'release',
          slot: slotAt(event.x, event.geometry, state.index),
          overBar: overTabBar(event.x, event.y, event.geometry),
        },
        swallowed: false,
      };
    }
    case 'cancel': {
      if (state.phase === 'idle') {
        return { state, outcome: null, swallowed: false };
      }
      // Escape and blur leave the button down, so its click still comes.
      const clickFollows =
        state.phase === 'dragging' &&
        (event.reason === 'escape' || event.reason === 'blur');
      return {
        state: { ...IDLE, swallowClick: clickFollows },
        outcome: { kind: 'cancel' },
        swallowed: false,
      };
    }
    case 'click':
      return {
        state: { ...state, swallowClick: false },
        outcome: null,
        swallowed: state.swallowClick,
      };
  }
}
