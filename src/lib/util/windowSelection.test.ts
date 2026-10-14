// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  gotoSelection,
  selectionAfterChange,
  selectionAfterSwap,
  toLiveSelection,
  type LineSelection,
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
