// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  blockedWhileGlobal,
  clipboardBlocked,
  fitsWindow,
  gotoSelection,
  insideWindow,
  isEditingKey,
  isImeKey,
  isModifierKey,
  isNativeSelectAll,
  movedEnds,
  movesSelection,
  needsGlobalOp,
  queuedClipboardAction,
  queuedSelectEnds,
  replayKind,
  replayReady,
  selectAllTarget,
  selectionAfterChange,
  selectionAfterSwap,
  toLiveSelection,
  wholeFileAfter,
  wholeFileSelection,
  windowStartFor,
  type LineSelection,
  type ReplayKeyEvent,
  type SelectAllEntry,
  type SelectAllMode,
  type WholeFileEvent,
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

describe('replayReady', () => {
  it('needs both ends of a selection that fits one window inside it', () => {
    expect(replayReady(sel(5, 0, 6, 0), 0, 100)).toBe(true);
    expect(replayReady(sel(5, 0, 150, 0), 0, 100)).toBe(false);
    expect(replayReady(sel(150, 0, 150, 3), 0, 100)).toBe(false);
  });
  it('needs only the head inside for a selection no window holds', () => {
    // 1500 lines apart does not fit a 2000-line window with margins.
    expect(replayReady(sel(0, 0, 1500, 0), 1000, 2000)).toBe(true);
    expect(replayReady(sel(0, 0, 1500, 0), 0, 1000)).toBe(false);
    expect(replayReady(sel(1500, 0, 0, 0), 0, 1000)).toBe(true);
  });
});

describe('queuedSelectEnds', () => {
  const caret = { anchor: 900, head: 905 };
  const convert = (pos: number) => 1000 + pos;
  it('queues the converted position of both ends of a plain click', () => {
    expect(
      queuedSelectEnds(
        { anchor: 5, head: 5 },
        { anchor: 30, head: 30 },
        convert,
        caret,
      ),
    ).toEqual({ anchor: 1030, head: 1030 });
  });
  it('keeps the queued caret as the anchor of a shift-click', () => {
    expect(
      queuedSelectEnds(
        { anchor: 5, head: 5 },
        { anchor: 5, head: 40 },
        convert,
        caret,
      ),
    ).toEqual({ anchor: 900, head: 1040 });
  });
  it('tells which ends moved', () => {
    expect(movedEnds({ anchor: 1, head: 2 }, { anchor: 1, head: 3 })).toEqual({
      anchor: false,
      head: true,
    });
    expect(movedEnds({ anchor: 1, head: 2 }, { anchor: 4, head: 2 })).toEqual({
      anchor: true,
      head: false,
    });
  });
});

describe('needsGlobalOp', () => {
  // The window holds lines 100..149.
  it('is false with both ends inside the window', () => {
    expect(needsGlobalOp(sel(100, 0, 149, 5), 100, 50)).toBe(false);
    expect(needsGlobalOp(sel(120, 3, 120, 3), 100, 50)).toBe(false);
  });
  it('is false at exactly the last line and true one line past it', () => {
    expect(needsGlobalOp(sel(100, 0, 149, 10), 100, 50)).toBe(false);
    expect(needsGlobalOp(sel(100, 0, 150, 0), 100, 50)).toBe(true);
  });
  it('is true one line before the window', () => {
    expect(needsGlobalOp(sel(99, 0, 120, 0), 100, 50)).toBe(true);
  });
  it('looks at both ends, in either direction', () => {
    expect(needsGlobalOp(sel(120, 0, 900, 0), 100, 50)).toBe(true);
    expect(needsGlobalOp(sel(900, 0, 120, 0), 100, 50)).toBe(true);
    expect(needsGlobalOp(sel(149, 0, 100, 0), 100, 50)).toBe(false);
  });
});

describe('selectAllTarget', () => {
  const entries: SelectAllEntry[] = ['key', 'menu', 'native'];
  for (const entry of entries) {
    it(`takes what is on screen under "visible" (${entry})`, () => {
      expect(selectAllTarget('visible', entry)).toBe('visible');
    });
    it(`takes the file under "file" (${entry})`, () => {
      expect(selectAllTarget('file', entry)).toBe('file');
    });
  }
});

describe('wholeFileAfter', () => {
  const selectAll = (entry: SelectAllEntry): WholeFileEvent => ({
    type: 'selectAll',
    entry,
  });
  it('is set by a Select All under "file", through any entry', () => {
    for (const entry of ['key', 'menu', 'native'] as const) {
      expect(wholeFileAfter({ mode: 'file' }, selectAll(entry))).toBe(true);
    }
  });
  it('is not set by a Select All under "visible"', () => {
    for (const entry of ['key', 'menu', 'native'] as const) {
      expect(wholeFileAfter({ mode: 'visible' }, selectAll(entry))).toBe(false);
    }
  });
  it('is cleared by a click, a selection key or a new selection', () => {
    for (const mode of ['file', 'visible'] as SelectAllMode[]) {
      for (const type of ['click', 'key', 'select'] as const) {
        expect(wholeFileAfter({ mode }, { type })).toBe(false);
      }
    }
  });
});

describe('movesSelection', () => {
  it('is true for the arrow, Home, End, PageUp and PageDown keys', () => {
    for (const key of ['ArrowUp', 'Home', 'End', 'PageUp', 'PageDown']) {
      expect(movesSelection(key)).toBe(true);
    }
  });
  it('is false for other keys', () => {
    for (const key of ['a', 'Shift', 'Enter', 'c']) {
      expect(movesSelection(key)).toBe(false);
    }
  });
});

describe('wholeFileSelection', () => {
  const end = { line: 5000, col: 7 };
  it('selects from the start of the file to its end', () => {
    expect(wholeFileSelection(end, win(100, 50)).globalSel).toEqual(
      sel(0, 0, 5000, 7),
    );
  });
  it('clamps the live selection to the window edges', () => {
    expect(wholeFileSelection(end, win(100, 50)).live).toEqual(
      sel(0, 0, 49, 10),
    );
  });
  it('keeps the end inside the window when the window holds it', () => {
    expect(wholeFileSelection(end, win(4990, 11)).live).toEqual(
      sel(0, 0, 10, 7),
    );
  });
  it('makes the last live selection the live one', () => {
    const w = wholeFileSelection(end, win(100, 50));
    expect(w.lastLive).toBe(w.live);
  });
  it('keeps the global ends through an update that only moves the selection', () => {
    const w = wholeFileSelection(end, win(100, 50));
    // The next update reports the same live selection.
    const next = selectionAfterChange(
      w.globalSel,
      w.lastLive,
      w.live,
      100,
      false,
    );
    expect(next.head).toEqual(end);
    expect(next.anchor).toEqual({ line: 0, col: 0 });
  });
});

describe('blockedWhileGlobal', () => {
  const small = sel(100, 0, 110, 0);
  const large = sel(0, 0, 5000, 0);
  const userEvents = [
    'input.type',
    'input.type.compose',
    'input.paste',
    'input.drop',
    'move.drop',
    'delete.backward',
    'delete.line',
    'delete.cut',
    'move.line',
    'input.comment',
    'indent',
    'replace',
    'anything.else',
  ];
  for (const userEvent of userEvents) {
    it(`blocks ${userEvent} that changes the document under a large selection`, () => {
      expect(blockedWhileGlobal({ docChanged: true, userEvent }, large)).toBe(
        true,
      );
    });
    it(`lets ${userEvent} through under a selection one window holds`, () => {
      expect(blockedWhileGlobal({ docChanged: true, userEvent }, small)).toBe(
        false,
      );
    });
  }
  it('lets a change through that no user action made', () => {
    expect(
      blockedWhileGlobal({ docChanged: true, userEvent: undefined }, large),
    ).toBe(false);
  });
  it('lets a change of the selection alone through', () => {
    expect(
      blockedWhileGlobal({ docChanged: false, userEvent: 'select' }, large),
    ).toBe(false);
    expect(
      blockedWhileGlobal({ docChanged: false, userEvent: undefined }, large),
    ).toBe(false);
  });
  it('allows the selection that fits at exactly the limit', () => {
    expect(
      blockedWhileGlobal(
        { docChanged: true, userEvent: 'input.type' },
        sel(0, 0, 1000, 0),
      ),
    ).toBe(false);
    expect(
      blockedWhileGlobal(
        { docChanged: true, userEvent: 'input.type' },
        sel(0, 0, 1001, 0),
      ),
    ).toBe(true);
  });
});

describe('clipboardBlocked', () => {
  const small = sel(100, 0, 110, 0);
  const large = sel(0, 0, 5000, 0);
  for (const kind of ['copy', 'cut'] as const) {
    it(`does not block ${kind} under a large selection: it goes through a clip`, () => {
      expect(clipboardBlocked(kind, large, 'editor')).toBe(false);
      expect(clipboardBlocked(kind, large, 'none')).toBe(false);
    });
  }
  it('does not block a paste under a large selection: it replaces the selection', () => {
    expect(clipboardBlocked('paste', large, 'editor')).toBe(false);
    expect(clipboardBlocked('paste', large, 'none')).toBe(false);
  });
  for (const kind of ['copy', 'cut', 'paste'] as const) {
    it(`lets ${kind} through in another element, such as a search field`, () => {
      expect(clipboardBlocked(kind, large, 'other')).toBe(false);
    });
    it(`lets ${kind} through under a selection one window holds`, () => {
      expect(clipboardBlocked(kind, small, 'editor')).toBe(false);
      expect(clipboardBlocked(kind, small, 'none')).toBe(false);
    });
  }
});

describe('queuedClipboardAction', () => {
  it('goes through a clip when the copy is made of the session', () => {
    expect(queuedClipboardAction('session')).toBe('clip');
  });
  it('supplies the web clipboard for any other way of copying', () => {
    expect(queuedClipboardAction('text')).toBe('supply');
    expect(queuedClipboardAction('file')).toBe('supply');
  });
});

describe('isNativeSelectAll', () => {
  const native = {
    docChanged: false,
    isSelect: true,
    isPointer: false,
    keyActive: false,
    from: 0,
    to: 900,
    viewportFrom: 0,
    viewportTo: 900,
  };
  it('is a selection of the whole rendered range that no key or pointer made', () => {
    expect(isNativeSelectAll(native)).toBe(true);
    expect(isNativeSelectAll({ ...native, from: 0, to: 1000 })).toBe(true);
  });
  it('is not one made by a key command, a pointer or a change', () => {
    expect(isNativeSelectAll({ ...native, keyActive: true })).toBe(false);
    expect(isNativeSelectAll({ ...native, isPointer: true })).toBe(false);
    expect(isNativeSelectAll({ ...native, docChanged: true })).toBe(false);
    expect(isNativeSelectAll({ ...native, isSelect: false })).toBe(false);
  });
  it('is not one that leaves part of the rendered range out', () => {
    expect(isNativeSelectAll({ ...native, from: 1 })).toBe(false);
    expect(isNativeSelectAll({ ...native, to: 899 })).toBe(false);
  });
});

describe('isModifierKey', () => {
  it('knows the modifiers pressed on their own', () => {
    for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph']) {
      expect(isModifierKey(key)).toBe(true);
    }
    expect(isModifierKey('a')).toBe(false);
    expect(isModifierKey('ArrowLeft')).toBe(false);
  });
});
