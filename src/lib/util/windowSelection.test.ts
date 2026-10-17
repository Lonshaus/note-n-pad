// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  fitsWindow,
  gotoSelection,
  insideWindow,
  isEditingKey,
  isImeKey,
  replayKind,
  selectionAfterChange,
  selectionAfterSwap,
  toLiveSelection,
  windowStartFor,
  type LineSelection,
  type ReplayKeyEvent,
  type WindowShape,
} from './windowSelection';
// Every line is 10 characters long.
function win(startLine: number, lineCount: number): WindowShape {
  return { startLine, lineCount, lineLength: () => 10 };
}

function sel(
  anchorLine: number,
  anchorCol: number,
  headLine: number,
  headCol: number,
): LineSelection {
  return {
    anchor: { line: anchorLine, col: anchorCol },
    head: { line: headLine, col: headCol },
  };
}

describe('toLiveSelection', () => {
  it('keeps a selection inside the window, as window-local lines', () => {
    expect(toLiveSelection(sel(110, 2, 120, 5), win(100, 50))).toEqual(
      sel(10, 2, 20, 5),
    );
  });

  it('clamps an end before the window to its start', () => {
    expect(toLiveSelection(sel(10, 3, 120, 5), win(100, 50))).toEqual(
      sel(0, 0, 20, 5),
    );
  });

  it('clamps an end after the window to the end of its last line', () => {
    expect(toLiveSelection(sel(110, 2, 900, 5), win(100, 50))).toEqual(
      sel(10, 2, 49, 10),
    );
  });

  it('turns a selection entirely before the window into a caret at its start', () => {
    expect(toLiveSelection(sel(10, 3, 20, 5), win(100, 50))).toEqual(
      sel(0, 0, 0, 0),
    );
  });

  it('turns a selection entirely after the window into a caret at its end', () => {
    expect(toLiveSelection(sel(300, 3, 200, 5), win(100, 50))).toEqual(
      sel(49, 10, 49, 10),
    );
  });

  it('selects the whole window when the ends lie on both sides of it', () => {
    expect(toLiveSelection(sel(10, 0, 900, 0), win(100, 50))).toEqual(
      sel(0, 0, 49, 10),
    );
  });

  it('clamps a column to the line length', () => {
    expect(toLiveSelection(sel(110, 99, 111, 99), win(100, 50))).toEqual(
      sel(10, 10, 11, 10),
    );
  });
});

describe('selectionAfterSwap', () => {
  it('keeps the global selection through a swap away and applies it again unclamped on the way back', () => {
    const global = sel(10, 2, 20, 5);
    const away = selectionAfterSwap(global, win(1200, 2000));
    expect(away.live).toEqual(sel(0, 0, 0, 0));
    expect(away.global).toEqual(global);
    const back = selectionAfterSwap(away.global, win(0, 2000));
    expect(back.live).toEqual(sel(10, 2, 20, 5));
    expect(back.global).toEqual(global);
  });
});

describe('selectionAfterChange (selection only)', () => {
  it('replaces both ends when the user moved both', () => {
    const global = sel(10, 2, 20, 5);
    const next = selectionAfterChange(
      global,
      sel(10, 2, 20, 5),
      sel(30, 1, 31, 1),
      0,
      false,
    );
    expect(next).toEqual(sel(30, 1, 31, 1));
  });

  it('keeps the remembered anchor when only the head moved from a clamped anchor', () => {
    // Anchor was global line 10 but sits at the start of a window from 1200.
    const global = sel(10, 2, 1300, 5);
    const prevLive = sel(0, 0, 100, 5);
    const next = selectionAfterChange(
      global,
      prevLive,
      sel(0, 0, 160, 5),
      1200,
      false,
    );
    expect(next).toEqual(sel(10, 2, 1360, 5));
  });

  it('replaces a caret held at the window edge once the user moves it', () => {
    const global = sel(10, 2, 20, 5);
    const next = selectionAfterChange(
      global,
      sel(0, 0, 0, 0),
      sel(7, 3, 7, 3),
      1200,
      false,
    );
    expect(next).toEqual(sel(1207, 3, 1207, 3));
  });

  it('drops the remembered anchor when an arrow key collapses onto the clamped edge', () => {
    const global = sel(10, 2, 1300, 5);
    const next = selectionAfterChange(
      global,
      sel(0, 0, 100, 5),
      sel(0, 0, 0, 0),
      1200,
      false,
    );
    expect(next).toEqual(sel(1200, 0, 1200, 0));
  });

  it('keeps a selection outside the window through an update that moves nothing', () => {
    const global = sel(10, 2, 20, 5);
    const edge = sel(0, 0, 0, 0);
    const next = selectionAfterChange(global, edge, edge, 1200, false);
    expect(next).toEqual(global);
  });
});

describe('selectionAfterChange (document change)', () => {
  it('replaces a clamped selection with the live one, dropping the remembered ends', () => {
    const global = sel(10, 2, 1300, 5);
    const live = sel(0, 0, 100, 5);
    const next = selectionAfterChange(global, live, live, 1200, true);
    expect(next).toEqual(sel(1200, 0, 1300, 5));
  });
});

describe('gotoSelection', () => {
  it('is a caret at the start of the target line', () => {
    expect(gotoSelection(4200)).toEqual(sel(4200, 0, 4200, 0));
  });
});

describe('insideWindow', () => {
  it('holds a selection with both ends on window lines', () => {
    expect(insideWindow(sel(110, 2, 120, 5), 100, 50)).toBe(true);
  });

  it('holds the first and the last line of the window', () => {
    expect(insideWindow(sel(100, 0, 149, 3), 100, 50)).toBe(true);
  });

  it('rejects a selection entirely before the window', () => {
    expect(insideWindow(sel(10, 0, 20, 0), 100, 50)).toBe(false);
  });

  it('rejects a selection entirely after the window', () => {
    expect(insideWindow(sel(150, 0, 300, 0), 100, 50)).toBe(false);
  });

  it('rejects a selection straddling either window edge', () => {
    expect(insideWindow(sel(90, 0, 110, 0), 100, 50)).toBe(false);
    expect(insideWindow(sel(110, 0, 150, 0), 100, 50)).toBe(false);
  });

  it('is independent of the direction of the selection', () => {
    expect(insideWindow(sel(120, 5, 110, 2), 100, 50)).toBe(true);
    expect(insideWindow(sel(120, 5, 10, 2), 100, 50)).toBe(false);
  });
});

describe('fitsWindow', () => {
  it('fits a caret', () => {
    expect(fitsWindow(sel(5, 3, 5, 3))).toBe(true);
  });

  it('fits a span of exactly the window minus both margins', () => {
    expect(fitsWindow(sel(100, 0, 1100, 0))).toBe(true);
    expect(fitsWindow(sel(1100, 0, 100, 0))).toBe(true);
  });

  it('does not fit a span one line over that', () => {
    expect(fitsWindow(sel(100, 0, 1101, 0))).toBe(false);
    expect(fitsWindow(sel(1101, 0, 100, 0))).toBe(false);
  });
});

describe('windowStartFor', () => {
  const total = 1_200_000;

  it('puts a margin above the first selected line', () => {
    expect(windowStartFor(sel(3600, 0, 3600, 0), total)).toBe(3100);
    expect(windowStartFor(sel(3700, 0, 3650, 0), total)).toBe(3150);
  });

  it('clamps to the start of the file', () => {
    expect(windowStartFor(sel(10, 0, 20, 0), total)).toBe(0);
  });

  it('clamps to the last full window at the end of the file', () => {
    expect(windowStartFor(sel(total - 5, 0, total - 5, 0), total)).toBe(
      total - 2000,
    );
  });

  it('yields a window holding a widest fitting selection with margins', () => {
    const wide = sel(5000, 0, 6000, 0);
    const start = windowStartFor(wide, total);
    expect(insideWindow(wide, start, 2000)).toBe(true);
    expect(5000 - start).toBe(500);
    expect(start + 2000 - 6000).toBe(500);
  });

  it('holds a widest fitting selection that ends at the end of the file', () => {
    const wide = sel(total - 1001, 0, total - 1, 0);
    const start = windowStartFor(wide, total);
    expect(insideWindow(wide, start, 2000)).toBe(true);
  });

  it('starts a short file at its first line', () => {
    expect(windowStartFor(sel(300, 0, 300, 0), 800)).toBe(0);
  });
});

function key(init: Partial<ReplayKeyEvent> & { key: string }): ReplayKeyEvent {
  return {
    keyCode: 0,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    ...init,
  };
}

describe('replayKind', () => {
  it('replays a letter, a Shift letter, a digit and a space as text', () => {
    expect(replayKind(key({ key: 'a' }), false)).toBe('text');
    expect(replayKind(key({ key: 'A', shiftKey: true }), false)).toBe('text');
    expect(replayKind(key({ key: '7' }), true)).toBe('text');
    expect(replayKind(key({ key: ' ' }), true)).toBe('text');
  });

  it('replays a character outside the BMP as text', () => {
    expect(replayKind(key({ key: '\u{1F600}' }), false)).toBe('text');
  });

  it('replays an Option character on macOS as text', () => {
    expect(replayKind(key({ key: 'å', altKey: true }), false)).toBe('text');
  });

  it('treats Alt plus a character on Windows as a chord, not text', () => {
    expect(replayKind(key({ key: 'f', altKey: true }), true)).toBe('chord');
  });

  it('treats Ctrl+Alt plus a character as a chord on both platforms', () => {
    const find = key({ key: 'f', ctrlKey: true, altKey: true });
    expect(replayKind(find, true)).toBe('chord');
    expect(replayKind(find, false)).toBe('chord');
    const altGr = key({ key: '@', ctrlKey: true, altKey: true });
    expect(replayKind(altGr, true)).toBe('chord');
  });

  it('replays editing and navigation keys as keys', () => {
    for (const name of [
      'Enter',
      'Backspace',
      'Delete',
      'Tab',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
      'PageUp',
      'PageDown',
    ]) {
      expect(replayKind(key({ key: name }), false)).toBe('key');
      expect(replayKind(key({ key: name }), true)).toBe('key');
    }
  });

  it('keeps the Alt and Shift variants of those keys as keys', () => {
    expect(replayKind(key({ key: 'ArrowUp', altKey: true }), false)).toBe(
      'key',
    );
    expect(replayKind(key({ key: 'ArrowUp', altKey: true }), true)).toBe('key');
    expect(replayKind(key({ key: 'ArrowDown', shiftKey: true }), true)).toBe(
      'key',
    );
    expect(replayKind(key({ key: 'Tab', shiftKey: true }), false)).toBe('key');
    expect(
      replayKind(key({ key: 'PageDown', shiftKey: true, altKey: true }), true),
    ).toBe('key');
  });

  it('treats any other Ctrl or Meta combination as a chord', () => {
    expect(replayKind(key({ key: 'c', metaKey: true }), false)).toBe('chord');
    expect(replayKind(key({ key: 's', ctrlKey: true }), true)).toBe('chord');
    expect(
      replayKind(key({ key: 'K', metaKey: true, shiftKey: true }), false),
    ).toBe('chord');
    expect(replayKind(key({ key: 'Tab', ctrlKey: true }), true)).toBe('chord');
    expect(replayKind(key({ key: 'F5', ctrlKey: true }), true)).toBe('chord');
  });

  it('treats an editing key with Ctrl or Meta as a chord', () => {
    expect(replayKind(key({ key: 'Backspace', ctrlKey: true }), true)).toBe(
      'chord',
    );
    expect(replayKind(key({ key: 'ArrowLeft', metaKey: true }), false)).toBe(
      'chord',
    );
  });

  it('tells editing keys other than Tab apart', () => {
    expect(isEditingKey('Backspace')).toBe(true);
    expect(isEditingKey('PageDown')).toBe(true);
    expect(isEditingKey('Tab')).toBe(false);
    expect(isEditingKey('s')).toBe(false);
  });

  it('ignores bare modifiers', () => {
    for (const name of ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph']) {
      expect(
        replayKind(
          key({ key: name, shiftKey: true, ctrlKey: true, altKey: true }),
          true,
        ),
      ).toBe('ignore');
    }
    expect(replayKind(key({ key: 'CapsLock' }), false)).toBe('ignore');
  });

  it('ignores Escape, function keys and dead keys without Ctrl or Meta', () => {
    expect(replayKind(key({ key: 'Escape' }), false)).toBe('ignore');
    expect(replayKind(key({ key: 'F5' }), true)).toBe('ignore');
    expect(replayKind(key({ key: 'Dead' }), false)).toBe('ignore');
  });

  it('ignores IME process keys, keyCode 229 and composing keys', () => {
    expect(replayKind(key({ key: 'Process' }), true)).toBe('ignore');
    expect(replayKind(key({ key: 'a', keyCode: 229 }), true)).toBe('ignore');
    expect(replayKind(key({ key: 'a', isComposing: true }), false)).toBe(
      'ignore',
    );
    expect(replayKind(key({ key: 'Enter', isComposing: true }), false)).toBe(
      'ignore',
    );
  });
});

describe('isImeKey', () => {
  it('is true for Process, keyCode 229 and isComposing only', () => {
    expect(isImeKey(key({ key: 'Process' }))).toBe(true);
    expect(isImeKey(key({ key: 'a', keyCode: 229 }))).toBe(true);
    expect(isImeKey(key({ key: 'a', isComposing: true }))).toBe(true);
    expect(isImeKey(key({ key: 'a', keyCode: 65 }))).toBe(false);
  });
});
