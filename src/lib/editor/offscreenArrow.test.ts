// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EditorSelection,
  EditorState,
  RangeSet,
  RangeValue,
  type SelectionRange,
  type Transaction,
  type TransactionSpec,
} from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  deferredMove,
  offscreenArrowKeys,
  offscreenLineTarget,
  offscreenMove,
  settleDeferredMove,
} from './offscreenArrow';

describe('offscreenLineTarget', () => {
  const current = { from: 10, to: 30 };
  const below = { from: 31, to: 45 };
  const above = { from: 0, to: 9 };

  it('keeps the character column on the adjacent line', async () => {
    expect(offscreenLineTarget(15, undefined, current, below, true).pos).toBe(
      36,
    );
    expect(offscreenLineTarget(15, undefined, current, above, false).pos).toBe(
      5,
    );
  });

  it('clamps to the end of a shorter adjacent line', async () => {
    expect(offscreenLineTarget(28, undefined, current, above, false).pos).toBe(
      9,
    );
    expect(
      offscreenLineTarget(29, undefined, current, { from: 31, to: 31 }, true)
        .pos,
    ).toBe(31);
  });

  it('goes to the edge of its own line at the first and last line', async () => {
    expect(offscreenLineTarget(15, undefined, current, null, false).pos).toBe(
      10,
    );
    expect(offscreenLineTarget(15, undefined, current, null, true).pos).toBe(
      30,
    );
  });

  it('passes the goal column through and never derives it from the column', async () => {
    expect(offscreenLineTarget(15, undefined, current, below, true)).toEqual({
      pos: 36,
      goalColumn: undefined,
    });
    expect(
      offscreenLineTarget(15, 123.5, current, below, true).goalColumn,
    ).toBe(123.5);
    expect(
      offscreenLineTarget(15, 123.5, current, null, false).goalColumn,
    ).toBe(123.5);
  });
});

class Atom extends RangeValue {}

describe('offscreen Up and Down commands', () => {
  // Ten lines "0123456789" (11 offsets each); the rendered range covers only
  // the first one unless a test says otherwise.
  const doc = Array.from({ length: 10 }, () => '0123456789').join('\n');
  const [up, down] = offscreenArrowKeys;
  const lineStart = (n: number): number => n * 11;
  let frames: (() => void)[] = [];
  beforeEach(() => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
      frames.push(callback);
      return frames.length;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  /** Run the animation frames requested so far, then the measures they asked for. */
  async function frame(flush: () => Promise<void>): Promise<void> {
    const due = frames;
    frames = [];
    due.forEach((callback) => callback());
    await flush();
  }

  interface Options {
    // CodeMirror's measure loop gave up with the request queued: it only runs
    // once requestMeasure() is called again.
    stalled?: boolean;
    viewport?: { from: number; to: number };
    // The viewport once the scroll has been measured.
    scrolledViewport?: { from: number; to: number };
    atoms?: [number, number][];
    // Measure passes that finish before the scrolled viewport takes effect.
    lateMeasures?: number;
  }
  /** A view stand-in. The stock move is replaced by "start of the next line",
   *  which no text-line move produces, so a test can tell the two apart. */
  function makeView(selection: EditorSelection, options: Options = {}) {
    const atoms = (options.atoms ?? []).map(([from, to]) =>
      new Atom().range(from, to),
    );
    let state = EditorState.create({
      doc,
      selection,
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        EditorView.atomicRanges.of(() => RangeSet.of(atoms, true)),
      ],
    });
    const log: string[] = [];
    const moves: Transaction[] = [];
    const pending: (() => void)[] = [];
    const stuck: (() => void)[] = [];
    let connected = true;
    // Like CodeMirror, refuse layout reads and updates during a measure write.
    let measuring = false;
    let viewport = options.viewport ?? { from: 0, to: 10 };
    let lateMeasures = options.lateMeasures ?? 0;
    const view = {
      get state() {
        return state;
      },
      get viewport() {
        return viewport;
      },
      dispatch: (tr: Transaction | TransactionSpec) => {
        if (measuring) {
          throw new Error('update during a measure');
        }
        if ('state' in tr) {
          log.push('move');
          moves.push(tr);
          state = tr.state;
        } else {
          log.push('scroll');
        }
      },
      dom: {
        get isConnected() {
          return connected;
        },
      },
      requestMeasure: (request?: { write?: () => void }) => {
        if (request === undefined) {
          log.push('rearm');
          pending.push(...stuck.splice(0));
          return;
        }
        log.push('requestMeasure');
        (options.stalled ? stuck : pending).push(() => {
          if (log.includes('scroll') && options.scrolledViewport) {
            if (lateMeasures > 0) {
              lateMeasures -= 1;
            } else {
              viewport = options.scrolledViewport;
            }
          }
          measuring = true;
          try {
            request.write?.();
          } finally {
            measuring = false;
          }
        });
      },
      moveVertically: (range: SelectionRange, forward: boolean) => {
        if (measuring) {
          throw new Error('layout read during a measure');
        }
        log.push('moveVertically');
        const line = state.doc.lineAt(range.head).number + (forward ? 1 : -1);
        return EditorSelection.cursor(lineStart(line - 1));
      },
      moveToLineBoundary: (range: SelectionRange, forward: boolean) => {
        log.push('moveToLineBoundary');
        const line = state.doc.lineAt(range.head);
        return EditorSelection.cursor(forward ? line.to : line.from);
      },
    } as unknown as EditorView;
    /** Run measure callbacks, and the microtasks they queue, until none is left. */
    const flush = async (): Promise<void> => {
      while (pending.length > 0) {
        pending.shift()?.();
        await Promise.resolve();
      }
    };
    return {
      view,
      log,
      moves,
      flush,
      selection: () => state.selection,
      disconnect: () => {
        connected = false;
      },
    };
  }

  async function press(
    binding: typeof up,
    shift: boolean,
    selection: EditorSelection,
    options: Options = {},
  ) {
    const harness = makeView(selection, options);
    const run = shift ? binding?.shift : binding?.run;
    const handled = run!(harness.view);
    await harness.flush();
    return { ...harness, handled };
  }

  it('moves a far-away caret by one visual row after scrolling it into view', async () => {
    const head = 11 * 6 + 4;
    const result = await press(down, false, EditorSelection.single(head), {
      scrolledViewport: { from: 55, to: 100 },
    });
    expect(result.handled).toBe(true);
    expect(result.log).toEqual([
      'scroll',
      'requestMeasure',
      'moveVertically',
      'move',
    ]);
    expect(result.selection().main.head).toBe(lineStart(7));
    expect(result.moves[0]?.scrollIntoView).toBe(true);
  });

  it('keeps the key handled and moves by text line when the scroll never renders the caret', async () => {
    const head = 11 * 6 + 4;
    const result = await press(down, false, EditorSelection.single(head));
    expect(result.handled).toBe(true);
    expect(result.log).toContain('scroll');
    expect(result.log).not.toContain('moveVertically');
    expect(result.selection().main.head).toBe(11 * 7 + 4);
    expect(result.moves[0]?.scrollIntoView).toBe(true);
    const upward = await press(up, false, EditorSelection.single(head));
    expect(upward.selection().main.head).toBe(11 * 5 + 4);
  });

  it('waits for a late measure before moving the main caret', async () => {
    const result = await press(
      down,
      false,
      EditorSelection.single(11 * 6 + 4),
      {
        scrolledViewport: { from: 55, to: 100 },
        lateMeasures: 1,
      },
    );
    expect(
      result.log.filter((entry) => entry === 'requestMeasure'),
    ).toHaveLength(2);
    expect(result.selection().main.head).toBe(lineStart(7));
  });

  it('extends the selection from its anchor and keeps the goal column', async () => {
    const anchor = 11 * 6 + 4;
    const range = EditorSelection.range(anchor, anchor, 77);
    const result = await press(down, true, EditorSelection.create([range]));
    expect(result.selection().main.anchor).toBe(anchor);
    expect(result.selection().main.head).toBe(11 * 7 + 4);
    expect(result.selection().main.goalColumn).toBe(77);
    const unset = await press(down, true, EditorSelection.single(anchor));
    expect(unset.selection().main.goalColumn).toBeUndefined();
  });

  it('collapses a selection to its edge without a vertical move', async () => {
    const result = await press(down, false, EditorSelection.single(40, 60));
    expect(result.selection().main.head).toBe(60);
    expect(result.selection().main.empty).toBe(true);
  });

  it('stops at the document edges', async () => {
    const last = 11 * 9 + 4;
    const forward = await press(down, true, EditorSelection.single(last));
    expect(forward.selection().main.head).toBe(doc.length);
    const first = EditorSelection.single(4);
    const backward = await press(up, true, first, {
      viewport: { from: 50, to: 90 },
    });
    expect(backward.selection().main.head).toBe(0);
  });

  it('leaves a caret inside the rendered range to the stock command', async () => {
    for (const shift of [false, true]) {
      for (const binding of [up, down]) {
        const result = await press(binding, shift, EditorSelection.single(4));
        expect(result.handled).toBe(false);
        expect(result.log).toEqual([]);
        expect(result.selection().main.head).toBe(4);
      }
    }
  });

  it('marks the move that ran after a measure and not one that ran at once', async () => {
    const late = await press(down, false, EditorSelection.single(11 * 6 + 4), {
      scrolledViewport: { from: 55, to: 100 },
    });
    expect(late.moves[0]?.annotation(offscreenMove)).toBe(true);
    const now = await press(down, false, EditorSelection.single(11 * 6 + 4), {
      viewport: { from: 55, to: 100 },
    });
    expect(now.moves[0]?.annotation(offscreenMove)).toBeUndefined();
  });

  it('keeps a deferred move known until it has run', async () => {
    const harness = makeView(EditorSelection.single(11 * 6 + 4), {
      scrolledViewport: { from: 55, to: 100 },
    });
    expect(deferredMove(harness.view)).toBeUndefined();
    expect(down?.run?.(harness.view)).toBe(true);
    const waiting = deferredMove(harness.view);
    expect(waiting).toBeInstanceOf(Promise);
    let done = false;
    void waiting?.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    expect(harness.selection().main.head).toBe(11 * 6 + 4);
    await harness.flush();
    await waiting;
    expect(done).toBe(true);
    expect(harness.selection().main.head).toBe(lineStart(7));
    expect(deferredMove(harness.view)).toBeUndefined();
  });

  it('asks for a measure each frame until a dropped request has run', async () => {
    const harness = makeView(EditorSelection.single(11 * 6 + 4), {
      scrolledViewport: { from: 55, to: 100 },
      stalled: true,
    });
    expect(down?.run?.(harness.view)).toBe(true);
    let done = false;
    void deferredMove(harness.view)?.then(() => {
      done = true;
    });
    await harness.flush();
    expect(harness.selection().main.head).toBe(11 * 6 + 4);
    await frame(harness.flush);
    expect(done).toBe(true);
    expect(harness.selection().main.head).toBe(lineStart(7));
    expect(deferredMove(harness.view)).toBeUndefined();
    await frame(harness.flush);
    expect(harness.log.filter((entry) => entry === 'rearm')).toHaveLength(1);
    expect(frames).toHaveLength(0);
  });

  it('stops asking for a measure once the view is disconnected', async () => {
    const harness = makeView(EditorSelection.single(11 * 6 + 4), {
      scrolledViewport: { from: 55, to: 100 },
      stalled: true,
    });
    down?.run?.(harness.view);
    harness.disconnect();
    await frame(harness.flush);
    expect(harness.log).not.toContain('rearm');
    expect(frames).toHaveLength(0);
  });

  it('waits for every deferred move of a view', async () => {
    const harness = makeView(EditorSelection.single(11 * 6 + 4), {
      scrolledViewport: { from: 55, to: 100 },
    });
    down?.run?.(harness.view);
    const first = deferredMove(harness.view);
    down?.run?.(harness.view);
    expect(deferredMove(harness.view)).toBe(first);
    await harness.flush();
    await first;
    expect(deferredMove(harness.view)).toBeUndefined();
  });

  it('resolves a deferred move of a view that goes away', async () => {
    const harness = makeView(EditorSelection.single(11 * 6 + 4), {
      scrolledViewport: { from: 55, to: 100 },
    });
    down?.run?.(harness.view);
    const waiting = deferredMove(harness.view);
    settleDeferredMove(harness.view);
    await waiting;
    expect(deferredMove(harness.view)).toBeUndefined();
    expect(harness.selection().main.head).toBe(11 * 6 + 4);
  });

  it('is still handled, without a move, when the caret is already at the end', async () => {
    const result = await press(down, false, EditorSelection.single(doc.length));
    expect(result.handled).toBe(true);
    expect(result.moves).toHaveLength(0);
  });

  describe('with several cursors', () => {
    const selection = (mainIndex: number) =>
      EditorSelection.create(
        [EditorSelection.cursor(4), EditorSelection.cursor(11 * 6 + 4)],
        mainIndex,
      );

    it('moves the off-screen head by text line and the rendered one by the stock move, in one transaction', async () => {
      const result = await press(down, false, selection(0));
      expect(result.handled).toBe(true);
      expect(result.log).not.toContain('scroll');
      expect(result.moves).toHaveLength(1);
      expect(result.selection().ranges.map((range) => range.head)).toEqual([
        lineStart(1),
        11 * 7 + 4,
      ]);
      expect(result.selection().mainIndex).toBe(0);
    });

    it('scrolls an off-screen main cursor and still moves the head left off-screen by text line', async () => {
      const result = await press(down, false, selection(1), {
        scrolledViewport: { from: 55, to: 100 },
      });
      expect(result.log.indexOf('scroll')).toBeLessThan(
        result.log.indexOf('moveVertically'),
      );
      expect(result.selection().ranges.map((range) => range.head)).toEqual([
        11 + 4,
        lineStart(7),
      ]);
      expect(result.selection().mainIndex).toBe(1);
    });

    it('extends each head the way its own path moves it', async () => {
      const result = await press(down, true, selection(0));
      expect(result.selection().ranges.map((range) => range.anchor)).toEqual([
        4,
        11 * 6 + 4,
      ]);
      expect(result.selection().ranges.map((range) => range.head)).toEqual([
        lineStart(1),
        11 * 7 + 4,
      ]);
    });
  });

  describe('with atomic ranges', () => {
    it('moves a head that lands inside one to its far edge', async () => {
      // Line 5 column 6 goes down to 72 (line 6 starts at 66), inside 70..80.
      const result = await press(
        down,
        false,
        EditorSelection.single(11 * 5 + 6),
        {
          atoms: [[70, 80]],
        },
      );
      expect(result.selection().main.head).toBe(80);
    });

    it('moves a head going up that lands inside one to its near edge', async () => {
      // Line 8 column 4 goes up to 81 (line 7 starts at 77), inside 78..86.
      const result = await press(
        up,
        false,
        EditorSelection.single(11 * 8 + 4),
        {
          atoms: [[78, 86]],
        },
      );
      expect(result.selection().main.head).toBe(78);
    });

    it('does the same when extending the selection', async () => {
      const result = await press(
        down,
        true,
        EditorSelection.single(11 * 5 + 6),
        {
          atoms: [[70, 80]],
        },
      );
      expect(result.selection().main.anchor).toBe(11 * 5 + 6);
      expect(result.selection().main.head).toBe(80);
    });
  });
});
