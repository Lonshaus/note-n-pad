// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  clipCopyRoute,
  clipFileRange,
  runClipCut,
  viewerFocus,
  type ClipOutcome,
  type ClipRoute,
  type LoadedRows,
} from './clipRouting';
import type { LineSelection } from './windowSelection';

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
// A stand-in for an element: what is inside it is listed.
class Box {
  constructor(private readonly inside: readonly object[] = []) {}
  contains(node: object): boolean {
    return node === this || this.inside.includes(node);
  }
}

describe('viewerFocus', () => {
  const body = new Box();
  const rows = new Box();
  const field = new Box();
  const rowButton = new Box();
  const roots = {
    content: new Box([rowButton]),
    wrap: new Box([rows, field, rowButton]),
    body,
  };
  it('is the editor when focus is in the rows', () => {
    expect(viewerFocus<object>(rowButton, roots)).toBe('editor');
  });
  it('is nowhere without a focused element or with the page body', () => {
    expect(viewerFocus<object>(null, roots)).toBe('none');
    expect(viewerFocus<object>(body, roots)).toBe('none');
  });
  it('is another element in the viewer but outside the rows, such as a find field', () => {
    expect(viewerFocus<object>(field, roots)).toBe('other');
  });
  it('is another element outside the viewer', () => {
    expect(viewerFocus<object>(new Box(), roots)).toBe('other');
  });
  it('is another element when the rows are not there', () => {
    expect(viewerFocus<object>(rowButton, { ...roots, content: null })).toBe(
      'other',
    );
  });
});

describe('clipCopyRoute', () => {
  const rows: LoadedRows = { startLine: 1000, count: 800 };
  type Input = Parameters<typeof clipCopyRoute>[0];
  const base: Input = {
    mode: 'view',
    focus: 'editor',
    globalSel: null,
    wholeFile: false,
    domSelection: false,
    sel: null,
    loadedRows: rows,
  };
  const route = (over: Partial<Input>): ClipRoute =>
    clipCopyRoute({ ...base, ...over });
  const routeEdit = (over: Partial<Input>): ClipRoute =>
    clipCopyRoute({ ...base, mode: 'edit', loadedRows: null, ...over });

  describe('editing', () => {
    it('copies the session when the selection is too large for a window', () => {
      expect(routeEdit({ globalSel: sel(0, 0, 5000, 0) })).toBe('session');
      expect(routeEdit({ globalSel: sel(0, 0, 5000, 0), focus: 'none' })).toBe(
        'session',
      );
    });
    it('leaves a selection one window holds to the web clipboard', () => {
      expect(routeEdit({ globalSel: sel(100, 0, 110, 0) })).toBe('text');
      expect(routeEdit({ globalSel: sel(100, 3, 100, 3) })).toBe('text');
    });
    it('leaves a text field to itself under a selection too large for a window', () => {
      expect(routeEdit({ globalSel: sel(0, 0, 5000, 0), focus: 'other' })).toBe(
        'text',
      );
    });
    it('has nothing to copy without a selection', () => {
      expect(routeEdit({ globalSel: null })).toBe('text');
    });
  });

  describe('viewing', () => {
    it('copies the file when Select All stands for the whole file', () => {
      expect(route({ wholeFile: true })).toBe('file');
      expect(route({ wholeFile: true, focus: 'none' })).toBe('file');
    });
    it('copies the file lines of a range that reaches past the loaded rows', () => {
      expect(route({ sel: { start: 10, end: 2000000 } })).toBe('file');
      expect(route({ sel: { start: 999, end: 1100 } })).toBe('file');
      expect(route({ sel: { start: 1100, end: 1800 } })).toBe('file');
      expect(route({ sel: { start: 5, end: 5 } })).toBe('file');
    });
    it('copies the file lines of a range when no row is loaded', () => {
      expect(route({ sel: { start: 5, end: 6 }, loadedRows: null })).toBe(
        'file',
      );
    });
    it('leaves a range inside the loaded rows to the rows on screen', () => {
      expect(route({ sel: { start: 1000, end: 1799 } })).toBe('text');
      expect(route({ sel: { start: 1200, end: 1200 } })).toBe('text');
    });
    it('has nothing to copy beyond the screen without a selection', () => {
      expect(route({})).toBe('text');
    });
    it('copies what the browser selected over a range outside the loaded rows', () => {
      expect(
        route({ sel: { start: 10, end: 2000000 }, domSelection: true }),
      ).toBe('text');
    });
    it('copies the whole file over a browser selection', () => {
      expect(route({ wholeFile: true, domSelection: true })).toBe('file');
    });
    it('leaves a text field to itself', () => {
      expect(route({ wholeFile: true, focus: 'other' })).toBe('text');
      expect(route({ sel: { start: 10, end: 2000000 }, focus: 'other' })).toBe(
        'text',
      );
    });
  });
});

describe('clipFileRange', () => {
  it('is the whole file for a whole-file selection, whatever the range', () => {
    expect(clipFileRange({ wholeFile: true, sel: null })).toEqual({
      kind: 'whole',
    });
    expect(
      clipFileRange({ wholeFile: true, sel: { start: 3, end: 4 } }),
    ).toEqual({ kind: 'whole' });
  });
  it('is the lines of the range otherwise', () => {
    expect(
      clipFileRange({ wholeFile: false, sel: { start: 9, end: 1999999 } }),
    ).toEqual({ kind: 'lines', start: 9, end: 1999999 });
  });
  it('is nothing without either', () => {
    expect(clipFileRange({ wholeFile: false, sel: null })).toBeNull();
  });
});

describe('runClipCut', () => {
  const offered: ClipOutcome = {
    kind: 'offered',
    id: '1-0-1',
    bytes: 3,
    lines: 1,
    utf16_len: 3,
    crlf: 0,
    linewise: false,
  };
  function run(outcome: ClipOutcome) {
    const calls: string[] = [];
    const result = runClipCut({
      offer: async () => {
        calls.push('offer');
        return outcome;
      },
      remove: async () => {
        calls.push('remove');
        return 'removed';
      },
    });
    return { calls, result };
  }
  it('removes the selection after the clip was offered, and not before', async () => {
    const { calls, result } = run(offered);
    expect(await result).toEqual({ outcome: offered, removed: 'removed' });
    expect(calls).toEqual(['offer', 'remove']);
  });
  it('does not remove it when a later copy came first', async () => {
    const { calls, result } = run({ kind: 'superseded' });
    expect(await result).toEqual({
      outcome: { kind: 'superseded' },
      removed: null,
    });
    expect(calls).toEqual(['offer']);
  });
  it('does not remove it when the clipboard refused the clip', async () => {
    const { calls, result } = run({ kind: 'offer_failed' });
    expect(await result).toEqual({
      outcome: { kind: 'offer_failed' },
      removed: null,
    });
    expect(calls).toEqual(['offer']);
  });
  it('does not call remove while the offer is still under way', async () => {
    const calls: string[] = [];
    let finish: (o: ClipOutcome) => void = () => {};
    const result = runClipCut({
      offer: () =>
        new Promise<ClipOutcome>((resolve) => {
          finish = resolve;
        }),
      remove: async () => {
        calls.push('remove');
        return 1;
      },
    });
    await Promise.resolve();
    expect(calls).toEqual([]);
    finish(offered);
    await result;
    expect(calls).toEqual(['remove']);
  });
});
