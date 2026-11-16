// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Marquee speed in px per second. */
export const MARQUEE_SPEED = 30;
/** Pause at the end of the text, in ms. */
export const MARQUEE_PAUSE_MS = 1000;
/** Gap between the end of the text and the following start, in em. */
export const MARQUEE_GAP_EM = 2;
/** A frame step never counts more than this, in ms. */
export const MARQUEE_MAX_STEP_MS = 100;

export interface MarqueeState {
  /** How far the text has moved left; never above 0. */
  x: number;
  /** This lap's pause has started; reset at a wrap. */
  held: boolean;
  /** Time left in the pause; 0 once it is over. */
  holdLeftMs: number;
}
/**
 * One animation step. `x` only moves left, or by a whole loop at a wrap;
 * a width change never moves it back.
 */
export function marqueeStep(
  state: MarqueeState,
  dtMs: number,
  textPx: number,
  boxPx: number,
  gapPx: number,
): MarqueeState {
  const dt = Number.isNaN(dtMs)
    ? 0
    : Math.min(Math.max(dtMs, 0), MARQUEE_MAX_STEP_MS);
  const shift = textPx - boxPx;
  const loop = textPx + gapPx;
  if (!(loop > 0) || !Number.isFinite(loop) || !Number.isFinite(state.x)) {
    return { ...state };
  }
  let { x, held, holdLeftMs } = state;
  if (held && holdLeftMs > 0) {
    holdLeftMs = Math.max(0, holdLeftMs - dt);
  } else {
    const before = x;
    x -= (MARQUEE_SPEED * dt) / 1000;
    if (!held && x <= -shift) {
      // Clamp to the end only when this step is the one that reaches it.
      x = before > -shift ? -shift : before;
      held = true;
      holdLeftMs = MARQUEE_PAUSE_MS;
    }
  }
  if (x <= -loop) {
    // `%` is exact, so x lands in (-loop, 0].
    const rest = -x % loop;
    x = rest === 0 ? 0 : -rest;
    held = false;
  }
  return { x, held, holdLeftMs };
}

export interface MarqueeHandle {
  /** The text changed: restart from its start. */
  update(): void;
  destroy(): void;
}
/**
 * Run the text of `label` (its one child) as a marquee while `button` is
 * hovered or focused and the text is wider than the label.
 */
export function attachMarquee(
  label: HTMLElement,
  button: HTMLElement,
): MarqueeHandle {
  let hover = button.matches(':hover');
  let focus = button.matches(':focus');
  let destroyed = false;
  let running = false;
  let frame = 0;
  let last = 0;
  let state: MarqueeState = { x: 0, held: false, holdLeftMs: 0 };
  let copy: HTMLElement | null = null;

  const active = (): boolean => hover || focus;
  const inner = (): HTMLElement | null =>
    label.firstElementChild instanceof HTMLElement
      ? label.firstElementChild
      : null;

  const schedule = (): void => {
    if (!destroyed && frame === 0) {
      frame = requestAnimationFrame(tick);
    }
  };

  const stop = (): void => {
    if (frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    running = false;
    copy?.remove();
    copy = null;
    const el = inner();
    if (el !== null) {
      el.style.transform = '';
    }
  };

  const tick = (now: number): void => {
    frame = 0;
    const el = inner();
    if (destroyed || el === null || !label.isConnected || !active()) {
      stop();
      return;
    }
    const textPx = el.getBoundingClientRect().width;
    const boxPx = label.getBoundingClientRect().width;
    if (textPx <= boxPx) {
      stop();
      return;
    }
    const gapPx = MARQUEE_GAP_EM * parseFloat(getComputedStyle(label).fontSize);
    if (!running) {
      running = true;
      state = { x: 0, held: false, holdLeftMs: 0 };
      copy = el.cloneNode(true) as HTMLElement;
      copy.setAttribute('aria-hidden', 'true');
      copy.style.position = 'absolute';
      copy.style.whiteSpace = 'inherit';
      label.appendChild(copy);
    } else {
      state = marqueeStep(state, now - last, textPx, boxPx, gapPx);
    }
    last = now;
    if (copy !== null) {
      copy.style.left = `${el.offsetLeft + textPx + gapPx}px`;
      copy.style.top = `${el.offsetTop}px`;
      copy.style.transform = `translateX(${state.x}px)`;
    }
    el.style.transform = `translateX(${state.x}px)`;
    schedule();
  };

  const setActive = (kind: 'hover' | 'focus', on: boolean): void => {
    if (kind === 'hover') {
      hover = on;
    } else {
      focus = on;
    }
    if (active()) {
      schedule();
    } else {
      stop();
    }
  };

  const onEnter = (): void => setActive('hover', true);
  const onLeave = (): void => setActive('hover', false);
  const onFocus = (): void => setActive('focus', true);
  const onBlur = (): void => setActive('focus', false);
  button.addEventListener('pointerenter', onEnter);
  button.addEventListener('pointerleave', onLeave);
  button.addEventListener('focus', onFocus);
  button.addEventListener('blur', onBlur);

  const observer = new ResizeObserver(() => {
    if (active() && !running) {
      schedule();
    }
  });
  observer.observe(label);
  const first = inner();
  if (first !== null) {
    observer.observe(first);
  }

  if (active()) {
    schedule();
  }

  return {
    update(): void {
      stop();
      if (active()) {
        schedule();
      }
    },
    destroy(): void {
      destroyed = true;
      stop();
      button.removeEventListener('pointerenter', onEnter);
      button.removeEventListener('pointerleave', onLeave);
      button.removeEventListener('focus', onFocus);
      button.removeEventListener('blur', onBlur);
      observer.disconnect();
    },
  };
}
/** Svelte action for a `.marquee` element inside a button; `key` is its text. */
export function marquee(
  node: HTMLElement,
  _key: string,
): { update(key: string): void; destroy(): void } {
  const handle = attachMarquee(node, node.closest('button') ?? node);
  return {
    update: () => handle.update(),
    destroy: () => handle.destroy(),
  };
}
