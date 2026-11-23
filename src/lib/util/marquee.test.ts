// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachMarquee,
  marqueeStep,
  type MarqueeHandle,
  type MarqueeState,
} from './marquee';

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
  // Vitest runs without a DOM: plain fakes stand in for the elements.
  class FakeElement {
    closest(_selector: string): FakeElement | null {
      return null;
    }
  }
  type Listener = (event: unknown) => void;
  class FakeDocument {
    listeners: { type: string; fn: Listener }[] = [];
    addEventListener(type: string, fn: Listener): void {
      this.listeners.push({ type, fn });
    }
    removeEventListener(type: string, fn: Listener): void {
      this.listeners = this.listeners.filter(
        (l) => l.type !== type || l.fn !== fn,
      );
    }
    emit(type: string, event: unknown): void {
      for (const l of [...this.listeners]) {
        if (l.type === type) {
          l.fn(event);
        }
      }
    }
  }
  class FakeButton extends FakeElement {
    disabled = false;
    hovered = false;
    ownerDocument: FakeDocument | undefined;
    listeners = new Map<string, () => void>();
    constructor(doc: FakeDocument | undefined) {
      super();
      this.ownerDocument = doc;
    }
    matches(selector: string): boolean {
      return selector === ':hover' && this.hovered;
    }
    closest(selector: string): FakeElement | null {
      return selector === 'button' ? this : null;
    }
    addEventListener(type: string, fn: () => void): void {
      this.listeners.set(type, fn);
    }
    removeEventListener(type: string): void {
      this.listeners.delete(type);
    }
  }
  // A target that sits inside `button`.
  const inside = (button: FakeButton): FakeElement =>
    Object.assign(new FakeElement(), { closest: () => button });
  const TEXT_PX = 200;
  let frames = new Map<number, (now: number) => void>();
  let nextFrame = 1;
  let resizeCallbacks: (() => void)[] = [];

  const setup = (): void => {
    frames = new Map();
    nextFrame = 1;
    resizeCallbacks = [];
    vi.stubGlobal('HTMLElement', FakeElement);
    vi.stubGlobal('Element', FakeElement);
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      frames.set(nextFrame, cb);
      return nextFrame++;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.delete(id);
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          resizeCallbacks.push(cb);
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    vi.stubGlobal('getComputedStyle', () => ({ fontSize: '16px' }));
  };
  // Runs every pending frame callback once.
  const run = (now: number): void => {
    const pending = [...frames.values()];
    frames.clear();
    for (const cb of pending) {
      cb(now);
    }
  };

  interface Rig {
    button: FakeButton;
    inner: { style: { transform: string } };
    handle: MarqueeHandle;
    setBox(px: number): void;
    resize(): void;
    x(): number;
  }
  // `button` is shared when a test needs two marquees in one button.
  const make = (doc: FakeDocument | undefined, existing?: FakeButton): Rig => {
    let boxPx = 100;
    const inner = Object.assign(new FakeElement(), {
      style: { transform: '' },
      offsetLeft: 0,
      offsetTop: 0,
      getBoundingClientRect: () => ({ width: TEXT_PX }),
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
    const button = existing ?? new FakeButton(doc);
    const handle = attachMarquee(
      label as unknown as HTMLElement,
      button as unknown as HTMLElement,
    );
    const onResize = resizeCallbacks[resizeCallbacks.length - 1];
    return {
      button,
      inner,
      handle,
      setBox: (px) => {
        boxPx = px;
      },
      resize: () => onResize?.(),
      x: () => Number(/translateX\((.*)px\)/.exec(inner.style.transform)?.[1]),
    };
  };
  // Pointer events as the document listeners see them.
  const over = (doc: FakeDocument, target: FakeElement): void => {
    doc.emit('pointerover', { target });
  };
  const out = (doc: FakeDocument, relatedTarget: FakeElement | null): void => {
    doc.emit('pointerout', { relatedTarget });
  };
  const runFrames = (from: number, to: number): void => {
    for (let now = from; now <= to; now += 50) {
      run(now);
    }
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the position when the box width changes mid-run', () => {
    setup();
    const rig = make(undefined);
    rig.button.listeners.get('pointerenter')?.();
    rig.button.hovered = true;
    runFrames(0, 1000);
    expect(rig.x()).toBe(-30);
    rig.setBox(140);
    run(1050);
    expect(rig.x()).toBe(-31.5);
    rig.button.hovered = false;
    rig.button.listeners.get('pointerleave')?.();
    expect(rig.inner.style.transform).toBe('');
  });

  it('(1) runs the label of a disabled button on a document pointerover', () => {
    setup();
    const doc = new FakeDocument();
    const rig = make(doc);
    rig.button.disabled = true;
    rig.button.hovered = true;
    over(doc, inside(rig.button));
    runFrames(0, 1000);
    expect(rig.inner.style.transform).toMatch(/^translateX\(-\d/);
  });

  it('(2) stops a disabled button once :hover is gone', () => {
    setup();
    const doc = new FakeDocument();
    const rig = make(doc);
    rig.button.disabled = true;
    rig.button.hovered = true;
    over(doc, inside(rig.button));
    runFrames(0, 500);
    expect(rig.inner.style.transform).not.toBe('');
    rig.button.hovered = false;
    run(550);
    expect(rig.inner.style.transform).toBe('');
  });

  it('(3) starts on a document pointerout only for the button', () => {
    setup();
    const doc = new FakeDocument();
    const rig = make(doc);
    rig.button.disabled = true;
    rig.button.hovered = true;
    const other = new FakeButton(doc);
    other.disabled = true;
    expect(() => {
      out(doc, other);
      out(doc, inside(other));
      out(doc, new FakeElement());
      out(doc, null);
    }).not.toThrow();
    runFrames(0, 500);
    expect(rig.inner.style.transform).toBe('');
    out(doc, rig.button);
    runFrames(0, 500);
    expect(rig.inner.style.transform).toMatch(/^translateX\(-\d/);
  });

  it('(4) leaves an enabled button to pointerenter and pointerleave', () => {
    setup();
    const doc = new FakeDocument();
    const rig = make(doc);
    rig.button.hovered = true;
    over(doc, inside(rig.button));
    runFrames(0, 500);
    expect(rig.inner.style.transform).toBe('');
    rig.button.listeners.get('pointerenter')?.();
    runFrames(0, 1000);
    expect(rig.x()).toBe(-30);
    rig.button.hovered = false;
    rig.button.listeners.get('pointerleave')?.();
    expect(rig.inner.style.transform).toBe('');
  });

  it('(5a) stops a running label when :hover is gone without an event', () => {
    setup();
    const rig = make(new FakeDocument());
    rig.button.hovered = true;
    rig.button.listeners.get('pointerenter')?.();
    runFrames(0, 500);
    expect(rig.inner.style.transform).not.toBe('');
    rig.button.disabled = true;
    rig.button.hovered = false;
    run(550);
    expect(rig.inner.style.transform).toBe('');
  });

  it('(5b) drops the hover left over from before a disabled period', () => {
    setup();
    const rig = make(new FakeDocument());
    rig.button.hovered = true;
    rig.button.listeners.get('pointerenter')?.();
    run(0);
    // The label fits, so the frame stops it and leaves hover set.
    rig.setBox(300);
    run(50);
    expect(rig.inner.style.transform).toBe('');
    rig.button.disabled = true;
    rig.button.hovered = false;
    rig.button.disabled = false;
    rig.setBox(100);
    rig.resize();
    run(100);
    expect(rig.inner.style.transform).toBe('');
  });

  it('(6) uses two document listeners however many marquees there are', () => {
    setup();
    const doc = new FakeDocument();
    const rigs = Array.from({ length: 100 }, () => make(doc));
    expect(doc.listeners).toHaveLength(2);
    for (const rig of rigs) {
      rig.handle.destroy();
    }
    expect(doc.listeners).toHaveLength(0);
  });

  it('(7) keeps the listeners until the last marquee is destroyed', () => {
    setup();
    const doc = new FakeDocument();
    const rigs = Array.from({ length: 5 }, () => make(doc));
    const last = rigs[4];
    expect(last).toBeDefined();
    if (last === undefined) {
      return;
    }
    last.button.disabled = true;
    for (const rig of rigs.slice(0, 4)) {
      rig.handle.destroy();
    }
    expect(doc.listeners).toHaveLength(2);
    last.button.hovered = true;
    over(doc, inside(last.button));
    runFrames(0, 500);
    expect(last.inner.style.transform).not.toBe('');
    last.handle.destroy();
    expect(doc.listeners).toHaveLength(0);
  });

  it('(8) adds the listeners again after the last destroy', () => {
    setup();
    const doc = new FakeDocument();
    make(doc).handle.destroy();
    expect(doc.listeners).toHaveLength(0);
    const rig = make(doc);
    expect(doc.listeners).toHaveLength(2);
    rig.button.disabled = true;
    rig.button.hovered = true;
    over(doc, inside(rig.button));
    runFrames(0, 500);
    expect(rig.inner.style.transform).not.toBe('');
  });

  it('(9) keeps one marquee when the other one in its button is destroyed', () => {
    for (const destroyFirst of [true, false]) {
      setup();
      const doc = new FakeDocument();
      const a = make(doc);
      const b = make(doc, a.button);
      a.button.disabled = true;
      a.button.hovered = true;
      over(doc, inside(a.button));
      runFrames(0, 500);
      expect(a.inner.style.transform).not.toBe('');
      expect(b.inner.style.transform).not.toBe('');
      const [gone, kept] = destroyFirst ? [a, b] : [b, a];
      gone.handle.destroy();
      a.button.hovered = false;
      run(550);
      expect(kept.inner.style.transform).toBe('');
      a.button.hovered = true;
      over(doc, inside(a.button));
      runFrames(600, 1100);
      expect(kept.inner.style.transform).not.toBe('');
      kept.handle.destroy();
    }
  });

  it('(10) ignores a second destroy of the same handle', () => {
    setup();
    const doc = new FakeDocument();
    const x = make(doc);
    const y = make(doc);
    y.button.disabled = true;
    x.handle.destroy();
    x.handle.destroy();
    expect(doc.listeners).toHaveLength(2);
    y.button.hovered = true;
    over(doc, inside(y.button));
    runFrames(0, 500);
    expect(y.inner.style.transform).not.toBe('');
  });

  it('(11) registers nothing for a button without an owner document', () => {
    setup();
    const rig = make(undefined);
    rig.button.hovered = true;
    rig.button.listeners.get('pointerenter')?.();
    runFrames(0, 500);
    expect(rig.inner.style.transform).not.toBe('');
  });
});
