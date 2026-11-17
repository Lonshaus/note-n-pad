// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachMarquee, marqueeStep, type MarqueeState } from './marquee';

const START: MarqueeState = { x: 0, held: false, holdLeftMs: 0 };
// A 200 px text in a 100 px box: it reaches its end at x = -100, and its
// copy follows after a 32 px gap, so a lap is 232 px.
const TEXT = 200;
const BOX = 100;
const GAP = 32;

describe('marqueeStep', () => {
  it('moves x left by 30 px per second', () => {
    const next = marqueeStep(START, 50, TEXT, BOX, GAP);
    expect(next.x).toBeCloseTo(-1.5, 9);
    expect(next.held).toBe(false);
  });

  it('stops exactly at the end of the text and pauses for 1000 ms', () => {
    const near: MarqueeState = { x: -99, held: false, holdLeftMs: 0 };
    const next = marqueeStep(near, 100, TEXT, BOX, GAP);
    expect(next.x).toBe(-100);
    expect(next.held).toBe(true);
    expect(next.holdLeftMs).toBe(1000);
  });

  it('only counts the pause down while it lasts', () => {
    const paused: MarqueeState = { x: -100, held: true, holdLeftMs: 1000 };
    const next = marqueeStep(paused, 100, TEXT, BOX, GAP);
    expect(next.x).toBe(-100);
    expect(next.holdLeftMs).toBe(900);
  });

  it('runs on after the pause, wraps at the loop and starts a new lap', () => {
    let state: MarqueeState = { x: -99, held: false, holdLeftMs: 0 };
    state = marqueeStep(state, 100, TEXT, BOX, GAP);
    for (let i = 0; i < 10; i += 1) {
      state = marqueeStep(state, 100, TEXT, BOX, GAP);
    }
    expect(state.holdLeftMs).toBe(0);
    expect(state.held).toBe(true);
    expect(state.x).toBe(-100);
    let wrapped = false;
    for (let i = 0; i < 100 && !wrapped; i += 1) {
      const before = state;
      state = marqueeStep(state, 100, TEXT, BOX, GAP);
      expect(state.x).toBeLessThan(before.x + 232);
      wrapped = state.x > before.x;
    }
    expect(wrapped).toBe(true);
    expect(state.held).toBe(false);
    expect(state.x).toBeLessThanOrEqual(0);
    expect(state.x).toBeGreaterThan(-3.1);
  });

  it('pauses where x is when the box grows past it', () => {
    const state: MarqueeState = { x: -50, held: false, holdLeftMs: 0 };
    // The end of the text is now at -40, behind x.
    const next = marqueeStep(state, 10, TEXT, 160, GAP);
    expect(next.x).toBe(-50);
    expect(next.held).toBe(true);
    expect(next.holdLeftMs).toBe(1000);
  });

  it('never sends x back when the widths change mid-lap', () => {
    let state: MarqueeState = START;
    for (let i = 0; i < 3000; i += 1) {
      const text = 220 + 60 * Math.sin(i / 37);
      const box = 100 + 70 * Math.cos(i / 53);
      const loop = text + GAP;
      const before = state;
      state = marqueeStep(state, 16, text, box, GAP);
      expect(state.x).toBeLessThanOrEqual(0);
      if (state.x > before.x) {
        // Only a wrap moves it right, and only when the step reached the loop.
        expect(before.x - 0.48).toBeLessThanOrEqual(-loop);
        expect(state.held).toBe(false);
      }
    }
  });

  it('keeps x where it is when the widths change while paused', () => {
    const paused: MarqueeState = { x: -100, held: true, holdLeftMs: 600 };
    const next = marqueeStep(paused, 16, 260, 90, GAP);
    expect(next.x).toBe(-100);
    expect(next.holdLeftMs).toBe(584);
  });

  it('counts a NaN step as zero', () => {
    expect(marqueeStep(START, NaN, TEXT, BOX, GAP)).toEqual(START);
    const paused: MarqueeState = { x: -100, held: true, holdLeftMs: 600 };
    expect(marqueeStep(paused, NaN, TEXT, BOX, GAP)).toEqual(paused);
  });

  it('counts a long frame as at most 100 ms', () => {
    const next = marqueeStep(START, 10_000, TEXT, BOX, GAP);
    expect(next.x).toBeGreaterThanOrEqual(-3);
    expect(next.x).toBeLessThan(0);
  });

  it('returns the state unchanged for an unusable loop or offset', () => {
    const states: MarqueeState[] = [
      { x: -5, held: false, holdLeftMs: 0 },
      { x: -5, held: true, holdLeftMs: 400 },
    ];
    for (const s of states) {
      expect(marqueeStep(s, 16, 0, 0, 0)).toEqual(s);
      expect(marqueeStep(s, 16, 10, 20, -15)).toEqual(s);
      expect(marqueeStep(s, 16, NaN, 0, 0)).toEqual(s);
      expect(marqueeStep(s, 16, Infinity, 0, 0)).toEqual(s);
    }
    const lost: MarqueeState = { x: -Infinity, held: false, holdLeftMs: 0 };
    expect(marqueeStep(lost, 0, 40, 20, 10)).toEqual(lost);
  });

  it('wraps by whole loops and stays in range', () => {
    const at = (x: number): MarqueeState =>
      marqueeStep({ x, held: true, holdLeftMs: 0 }, 0, 40, 20, 10);
    expect(Object.is(at(-50).x, 0)).toBe(true);
    expect(at(-120).x).toBe(-20);
    expect(at(-149.5).x).toBe(-49.5);
    for (const x of [-50, -120, -149.5]) {
      expect(at(x).held).toBe(false);
    }
    expect(at(-49)).toEqual({ x: -49, held: true, holdLeftMs: 0 });
    const huge = at(-1e17).x;
    expect(huge).toBeGreaterThan(-50);
    expect(huge).toBeLessThanOrEqual(0);
  });
});

describe('attachMarquee', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the position when the box width changes mid-run', () => {
    // Vitest runs without a DOM: plain fakes stand in for the elements.
    class FakeElement {}
    let frame: ((now: number) => void) | null = null;
    vi.stubGlobal('HTMLElement', FakeElement);
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      frame = cb;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {
      frame = null;
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    vi.stubGlobal('getComputedStyle', () => ({ fontSize: '16px' }));
    const textPx = 200;
    let boxPx = 100;
    const inner = Object.assign(new FakeElement(), {
      style: { transform: '' },
      offsetLeft: 0,
      offsetTop: 0,
      getBoundingClientRect: () => ({ width: textPx }),
      cloneNode: () => ({
        style: {},
        setAttribute: () => {},
        remove: () => {},
      }),
    });
    const label = {
      firstElementChild: inner,
      isConnected: true,
      getBoundingClientRect: () => ({ width: boxPx }),
      appendChild: () => {},
    };
    const listeners = new Map<string, () => void>();
    const button = {
      matches: () => false,
      addEventListener: (type: string, fn: () => void) => {
        listeners.set(type, fn);
      },
      removeEventListener: () => {},
    };
    const run = (now: number): void => {
      const cb: ((now: number) => void) | null = frame;
      expect(cb).not.toBeNull();
      cb?.(now);
    };
    const x = (): number =>
      Number(/translateX\((.*)px\)/.exec(inner.style.transform)?.[1]);
    attachMarquee(
      label as unknown as HTMLElement,
      button as unknown as HTMLElement,
    );
    listeners.get('pointerenter')?.();
    for (let now = 0; now <= 1000; now += 50) {
      run(now);
    }
    expect(x()).toBe(-30);
    boxPx = 140;
    run(1050);
    expect(x()).toBe(-31.5);
    listeners.get('pointerleave')?.();
    expect(inner.style.transform).toBe('');
  });
});
