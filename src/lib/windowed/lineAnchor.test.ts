// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { ChangeSet, Text } from '@codemirror/state';
import {
  anchorArms,
  anchorDisarms,
  anchorStep,
  docHasGapLine,
  gapLineAfter,
  hasGapLine,
  heldEnds,
  panelGrowthCovers,
  panelInset,
  swapAllowed,
  type AnchorEvent,
  type HeldEvent,
} from './lineAnchor';

describe('anchorArms', () => {
  const on = { wrapping: true, windowHasGapLine: true, scrolled: true };
  it('arms with wrapping, a gap line in the window and a scroll', () => {
    expect(anchorArms(on)).toBe(true);
  });
  it('does not arm without wrapping', () => {
    expect(anchorArms({ ...on, wrapping: false })).toBe(false);
  });
  it('does not arm without a scroll to the caret', () => {
    expect(anchorArms({ ...on, scrolled: false })).toBe(false);
  });
  it('does not arm when the window holds no gap line', () => {
    expect(anchorArms({ ...on, windowHasGapLine: false })).toBe(false);
  });
  it('arms for an anchor on a short line when the window holds a gap line', () => {
    const doc = Text.of(['a', 'x'.repeat(20000), 'b']);
    const windowHasGapLine = hasGapLine(doc, 0, doc.length);
    expect(doc.lineAt(0).length).toBe(1);
    expect(anchorArms({ ...on, windowHasGapLine })).toBe(true);
  });
  it('does not arm when no line of the window is a gap line', () => {
    const doc = Text.of(['a', 'x'.repeat(19999), 'b']);
    const windowHasGapLine = hasGapLine(doc, 0, doc.length);
    expect(anchorArms({ ...on, windowHasGapLine })).toBe(false);
  });
});

describe('hasGapLine', () => {
  const doc = (...lines: number[]): Text =>
    Text.of(lines.map((n) => 'x'.repeat(n)));
  it('finds a line of exactly 20,000 characters', () => {
    const d = doc(3, 20000, 5);
    expect(hasGapLine(d, 0, d.length)).toBe(true);
  });
  it('does not count a line of 19,999 characters', () => {
    const d = doc(3, 19999, 5);
    expect(hasGapLine(d, 0, d.length)).toBe(false);
  });
  it('looks only at the lines the range overlaps', () => {
    const d = doc(3, 20000, 5);
    expect(hasGapLine(d, 0, 2)).toBe(false);
    expect(hasGapLine(d, 4, 4)).toBe(true);
    expect(hasGapLine(d, d.length, d.length)).toBe(false);
  });
});

describe('panelInset', () => {
  it('is nothing while the panel is closed', () => {
    expect(panelInset(false, 120)).toBe(0);
  });
  it('is the panel height while it is open', () => {
    expect(panelInset(true, 120)).toBe(120);
  });
});

describe('panelGrowthCovers', () => {
  const view = { viewTop: 0, viewBottom: 500 };
  it('is true for a caret shown before and covered after', () => {
    expect(
      panelGrowthCovers({
        ...view,
        caretTop: 280,
        caretBottom: 298,
        before: 40,
        after: 350,
      }),
    ).toBe(true);
  });
  it('is false for a caret still shown after', () => {
    expect(
      panelGrowthCovers({
        ...view,
        caretTop: 100,
        caretBottom: 118,
        before: 40,
        after: 350,
      }),
    ).toBe(false);
  });
  it('is false for a caret already partly covered before', () => {
    expect(
      panelGrowthCovers({
        ...view,
        caretTop: 450,
        caretBottom: 468,
        before: 40,
        after: 350,
      }),
    ).toBe(false);
  });
  it('is false for a caret above the view top', () => {
    expect(
      panelGrowthCovers({
        ...view,
        caretTop: -10,
        caretBottom: 8,
        before: 40,
        after: 500,
      }),
    ).toBe(false);
  });
  it('is false for a caret not drawn', () => {
    expect(
      panelGrowthCovers({
        ...view,
        caretTop: null,
        caretBottom: null,
        before: 40,
        after: 350,
      }),
    ).toBe(false);
  });
  it('is false for a shrinking panel', () => {
    expect(
      panelGrowthCovers({
        ...view,
        caretTop: 280,
        caretBottom: 298,
        before: 350,
        after: 40,
      }),
    ).toBe(false);
  });
});

describe('swapAllowed', () => {
  const free = {
    armed: false,
    anchoredOnGapLine: false,
    gapLineInViewport: false,
    scrollbarHeld: false,
    gapLineInWindow: false,
    wrapping: true,
  };
  it('refuses while a scroll bar press is held over a gap line with wrap on', () => {
    expect(
      swapAllowed({ ...free, scrollbarHeld: true, gapLineInWindow: true }),
    ).toBe(false);
  });
  it('allows a held press when the window has no gap line', () => {
    expect(swapAllowed({ ...free, scrollbarHeld: true })).toBe(true);
  });
  it('allows a held press with word wrap off', () => {
    expect(
      swapAllowed({
        ...free,
        scrollbarHeld: true,
        gapLineInWindow: true,
        wrapping: false,
      }),
    ).toBe(true);
  });
  it('allows an unheld press with a gap line in the window and on screen', () => {
    expect(
      swapAllowed({ ...free, gapLineInWindow: true, gapLineInViewport: true }),
    ).toBe(true);
  });
  it('allows an armed anchor on a short line with no gap line on screen', () => {
    expect(swapAllowed({ ...free, armed: true })).toBe(true);
  });
  it('refuses while the anchor is armed on a gap line', () => {
    expect(swapAllowed({ ...free, armed: true, anchoredOnGapLine: true })).toBe(
      false,
    );
  });
  it('refuses while armed with a gap line on screen', () => {
    expect(swapAllowed({ ...free, armed: true, gapLineInViewport: true })).toBe(
      false,
    );
  });
  it('is never held back by a gap line while unarmed', () => {
    expect(swapAllowed({ ...free, gapLineInViewport: true })).toBe(true);
  });
});

describe('heldEnds', () => {
  const ending: HeldEvent[] = [
    'pointerup',
    'pointercancel',
    'wheel',
    'keydown',
    'pointerdown',
    'idle',
  ];
  for (const event of ending) {
    it(`ends the hold on ${event}`, () => {
      expect(heldEnds(event)).toBe(true);
    });
  }
  it('keeps the hold on a scroll', () => {
    expect(heldEnds('scroll')).toBe(false);
  });
});

describe('anchorStep', () => {
  const base = {
    armed: true,
    caretTop: 300,
    caretBottom: 320,
    viewTop: 100,
    viewBottom: 700,
    margin: 5,
  };
  it('does nothing when unarmed', () => {
    expect(
      anchorStep({ ...base, armed: false, caretTop: -900, caretBottom: -880 }),
    ).toEqual({ kind: 'none' });
  });
  it('does nothing for a caret inside the margins', () => {
    expect(anchorStep(base)).toEqual({ kind: 'none' });
  });
  it('scrolls up by the overflow for a caret above the top', () => {
    expect(anchorStep({ ...base, caretTop: 40, caretBottom: 60 })).toEqual({
      kind: 'scroll',
      by: -65,
    });
  });
  it('scrolls down by the overflow for a caret below the bottom', () => {
    expect(anchorStep({ ...base, caretTop: 790, caretBottom: 810 })).toEqual({
      kind: 'scroll',
      by: 115,
    });
  });
  it('keeps the margin at the top edge', () => {
    expect(anchorStep({ ...base, caretTop: 103, caretBottom: 123 })).toEqual({
      kind: 'scroll',
      by: -2,
    });
  });
  it('keeps the margin at the bottom edge', () => {
    expect(anchorStep({ ...base, caretTop: 680, caretBottom: 697 })).toEqual({
      kind: 'scroll',
      by: 2,
    });
  });
  it('does nothing for a caret exactly on the margin', () => {
    expect(anchorStep({ ...base, caretTop: 105, caretBottom: 125 })).toEqual({
      kind: 'none',
    });
    expect(anchorStep({ ...base, caretTop: 675, caretBottom: 695 })).toEqual({
      kind: 'none',
    });
  });
  it('asks to reveal a caret that is not drawn', () => {
    expect(anchorStep({ ...base, caretTop: null, caretBottom: null })).toEqual({
      kind: 'reveal',
    });
  });
});

describe('anchorDisarms', () => {
  const ending: AnchorEvent[] = [
    'wheel',
    'touch',
    'scrollbar',
    'pointer',
    'install',
    'blur',
    'wrapOff',
    'leftLine',
    'rearmFalse',
  ];
  for (const event of ending) {
    it(`disarms on ${event}`, () => {
      expect(anchorDisarms(event)).toBe(true);
    });
  }
  it('stays armed on a viewport change', () => {
    expect(anchorDisarms('viewport')).toBe(false);
  });
  it('stays armed on a height change', () => {
    expect(anchorDisarms('height')).toBe(false);
  });
});

describe('docHasGapLine', () => {
  it('is false at 19,999 characters', () => {
    expect(docHasGapLine(Text.of(['a', 'x'.repeat(19999)]))).toBe(false);
  });
  it('is true at 20,000 characters', () => {
    expect(docHasGapLine(Text.of(['a', 'x'.repeat(20000), 'b']))).toBe(true);
  });
  it('is true for a gap line as the last line', () => {
    expect(docHasGapLine(Text.of(['a', 'b', 'x'.repeat(20000)]))).toBe(true);
  });
});

describe('gapLineAfter', () => {
  function run(
    before: boolean,
    lines: string[],
    spec: Parameters<typeof ChangeSet.of>[0],
  ) {
    const oldDoc = Text.of(lines);
    const changes = ChangeSet.of(spec, oldDoc.length);
    const newDoc = changes.apply(oldDoc);
    let calls = 0;
    const answer = gapLineAfter({
      before,
      oldDoc,
      newDoc,
      changes,
      rescan: (doc) => {
        calls++;
        return docHasGapLine(doc);
      },
    });
    return { answer, calls };
  }
  const big = 'x'.repeat(20000);
  it('answers true for an inserted gap line without a rescan', () => {
    const r = run(false, ['a', 'b'], { from: 1, insert: '\n' + big });
    expect(r).toEqual({ answer: true, calls: 0 });
  });
  it('rescans once when the gap line is deleted whole', () => {
    const r = run(true, ['a', big, 'b'], { from: 1, to: 20002 });
    expect(r).toEqual({ answer: false, calls: 1 });
  });
  it('rescans once when the gap line shrinks below the threshold', () => {
    const r = run(true, ['a', big, 'b'], { from: 5, to: 6 });
    expect(r).toEqual({ answer: false, calls: 1 });
  });
  it('does not rescan while the edited gap line stays a gap line', () => {
    const ins = run(true, ['a', big, 'b'], { from: 5, insert: 'yy' });
    expect(ins).toEqual({ answer: true, calls: 0 });
    const del = run(true, ['a', big + 'x', 'b'], { from: 5, to: 6 });
    expect(del).toEqual({ answer: true, calls: 0 });
  });
  it('does not rescan for an edit on a short line far from the gap line', () => {
    const r = run(true, ['a', 'b', big], { from: 1, insert: 'z' });
    expect(r).toEqual({ answer: true, calls: 0 });
  });
  it('does not scan a 1,000,000-line document for a short edit', () => {
    const r = run(
      false,
      Array.from({ length: 1000000 }, () => 'ab'),
      {
        from: 1,
        insert: 'z',
      },
    );
    expect(r).toEqual({ answer: false, calls: 0 });
  });
  it('sees a gap line produced by the second changed range', () => {
    const r = run(
      false,
      ['a', 'b', 'c'],
      [
        { from: 0, insert: 'q' },
        { from: 3, insert: big },
      ],
    );
    expect(r).toEqual({ answer: true, calls: 0 });
  });
});
