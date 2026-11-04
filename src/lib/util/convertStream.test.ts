// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import type { ClipInfo } from './clipRouting';
import { CONVERT_CHUNK, convertOps, type ConvertOp } from './convertStream';
import { pasteRanges } from './pasteFlow';
import { pastedSize, utf8Length, type PasteSource } from './pasteRouting';
import { pasteSpec } from './replayKeys';

const info = (over: Partial<ClipInfo> = {}): ClipInfo => ({
  id: 'c1',
  bytes: 0,
  lines: 1,
  utf16_len: 0,
  crlf: 0,
  linewise: false,
  ...over,
});
/** A state of `doc` with these selections: [anchor, head] pairs. */
function stateOf(doc: string, selections: [number, number?][]): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.create(
      selections.map(([a, h]) => EditorSelection.range(a, h ?? a)),
    ),
    extensions: EditorState.allowMultipleSelections.of(true),
  });
}
/** What the core writes for the blocks it is sent: every break an LF, a CR at
 *  the end of a block kept back until the next block shows what follows it. */
function written(ops: Iterable<ConvertOp>, clip = ''): string {
  let out = '';
  let pending = false;
  const feed = (chunk: string): void => {
    let text = pending ? `\r${chunk}` : chunk;
    pending = text.endsWith('\r');
    if (pending) {
      text = text.slice(0, -1);
    }
    out += text.replace(/\r\n?/g, '\n');
  };
  for (const op of ops) {
    feed(
      op.kind === 'text'
        ? op.text
        : op.kind === 'clip'
          ? clip
          : (clip.split('\n')[op.line] ?? ''),
    );
  }
  return pending ? `${out}\n` : out;
}
const plan = (
  state: EditorState,
  source: PasteSource,
  remembered: string | null = null,
) => {
  const where = pasteRanges(state, source, remembered);
  return {
    ...where,
    ops: [
      ...convertOps({
        doc: state.doc,
        ranges: where.ranges,
        linewise: where.linewise,
        source,
      }),
    ],
  };
};
const text = (t: string): PasteSource => ({ kind: 'text', text: t });
/** The document CodeMirror's paste of `t` leaves. */
const reference = (
  state: EditorState,
  t: string,
  remembered: string | null = null,
): string => state.update(pasteSpec(state, t, remembered)).state.doc.toString();

describe('the conversion of a paste of text equals the paste CodeMirror makes', () => {
  const doc = 'one\ntwo\nthree\nfour';
  const cases: {
    name: string;
    sel: [number, number?][];
    text: string;
    remembered?: string | null;
  }[] = [
    { name: 'one caret', sel: [[3]], text: 'XY' },
    { name: 'a selection replaced', sel: [[0, 3]], text: 'XY' },
    { name: 'the whole text at every caret', sel: [[3], [7], [13]], text: 'Q' },
    {
      name: 'a multi-line text at two carets',
      sel: [[3], [7]],
      text: 'a\nb\nc',
    },
    {
      name: 'one line to each selection when the lines match the selections',
      sel: [[3], [7], [13]],
      text: 'a\nb\nc',
    },
    {
      name: 'one line to each replaced selection',
      sel: [
        [0, 3],
        [4, 7],
      ],
      text: 'AA\nBB',
    },
    {
      name: 'a line-wise paste above the caret line',
      sel: [[5]],
      text: 'whole',
      remembered: 'whole',
    },
    {
      name: 'a line-wise paste above each caret line, once for a line',
      sel: [[1], [2], [5], [13]],
      text: 'whole',
      remembered: 'whole',
    },
    {
      name: 'a line-wise paste of as many lines as there are carets',
      sel: [[1], [5], [13]],
      text: 'x\ny\nz',
      remembered: 'x\ny\nz',
    },
    {
      name: 'a line-wise paste with two carets on a line and as many lines as carets',
      sel: [[1], [2], [5]],
      text: 'x\ny\nz',
      remembered: 'x\ny\nz',
    },
    {
      name: 'a remembered copy with a selection is no line-wise paste',
      sel: [[0, 3]],
      text: 'whole',
      remembered: 'whole',
    },
    { name: 'a CR that ends the text', sel: [[3]], text: 'x\r' },
    {
      name: 'a CR that ends the text, before a break',
      sel: [[3]],
      text: 'x\r\r',
    },
    { name: 'mixed breaks', sel: [[3], [7]], text: 'a\r\nb\rc' },
    { name: 'an empty text', sel: [[3], [7]], text: '' },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const state = stateOf(doc, c.sel);
      const p = plan(state, text(c.text), c.remembered ?? null);
      expect(written(p.ops)).toBe(reference(state, c.text, c.remembered));
    });
    it(`${c.name}: the size counts the file that is written`, () => {
      const state = stateOf(doc, c.sel);
      const p = plan(state, text(c.text), c.remembered ?? null);
      const expected = reference(state, c.text, c.remembered);
      const lf = pastedSize({
        dest: 'document',
        doc: state.doc,
        ranges: p.ranges,
        eol: '\n',
        source: text(c.text),
        linewise: p.linewise,
        limit: 0,
      });
      expect(lf).toEqual({ size: utf8Length(expected), exact: true });
      const crlf = pastedSize({
        dest: 'document',
        doc: state.doc,
        ranges: p.ranges,
        eol: '\r\n',
        source: text(c.text),
        linewise: p.linewise,
        limit: 0,
      });
      expect(crlf.size).toBe(
        utf8Length(expected) + (expected.split('\n').length - 1),
      );
      const note = pastedSize({
        dest: 'sticky',
        doc: state.doc,
        ranges: p.ranges,
        eol: '\n',
        source: text(c.text),
        linewise: p.linewise,
      });
      expect(note.size).toBe(expected.length);
    });
  }
  it('sends the document before, the pasted text and the document after, in that order', () => {
    const state = stateOf('aa\nbb\ncc', [[2], [5]]);
    const p = plan(state, text('X'));
    expect(p.ops.map((o) => (o.kind === 'text' ? o.text : '#'))).toEqual([
      'aa',
      'X',
      '\nbb',
      'X',
      '\ncc',
    ]);
  });
});

describe('the conversion of a paste of a clip equals the paste of its text', () => {
  const doc = 'one\ntwo\nthree';
  /** A clip holding `body`, as the core describes it. */
  const clipOf = (body: string, linewise = false): ClipInfo =>
    info({ lines: body.split('\n').length, linewise });
  const cases: {
    name: string;
    sel: [number, number?][];
    body: string;
    linewise?: boolean;
    pieces: 'whole' | 'lines';
  }[] = [
    {
      name: 'the clip at every selection, replacing what is selected',
      sel: [[0, 3], [8]],
      body: 'CLIP\nLINES\nMORE',
      pieces: 'whole',
    },
    {
      name: 'one line of the clip to each selection when the lines match',
      sel: [[3], [7], [13]],
      body: 'a\nb\nc',
      pieces: 'lines',
    },
    {
      name: 'one line to each replaced selection',
      sel: [
        [0, 3],
        [4, 7],
      ],
      body: 'AA\nBB',
      pieces: 'lines',
    },
    {
      name: 'a line-wise clip above each caret line, once for a line',
      sel: [[1], [2], [5], [10]],
      body: 'CLIP\nLINES',
      linewise: true,
      pieces: 'whole',
    },
    {
      name: 'a line-wise clip of as many lines as there are carets, a line to each',
      sel: [[1], [5], [10]],
      body: 'x\ny\nz',
      linewise: true,
      pieces: 'lines',
    },
    {
      name: 'a line-wise clip with two carets on a line, the lines to the carets that are used',
      sel: [[1], [2], [5]],
      body: 'x\ny\nz',
      linewise: true,
      pieces: 'lines',
    },
    {
      name: 'one selection and one line is the whole clip',
      sel: [[3]],
      body: 'only',
      pieces: 'whole',
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const state = stateOf(doc, c.sel);
      const p = plan(state, {
        kind: 'clip',
        info: clipOf(c.body, c.linewise === true),
      });
      const kinds = new Set(
        p.ops.filter((o) => o.kind !== 'text').map((o) => o.kind),
      );
      expect(kinds).toEqual(
        new Set([c.pieces === 'whole' ? 'clip' : 'clipLine']),
      );
      expect(written(p.ops, c.body)).toBe(
        reference(state, c.body, c.linewise === true ? c.body : null),
      );
    });
  }
  it('counts a clip in lines for the size, as it is written', () => {
    for (const c of cases) {
      const state = stateOf(doc, c.sel);
      const clipInfo = clipOf(c.body, c.linewise === true);
      const source: PasteSource = {
        kind: 'clip',
        info: { ...clipInfo, bytes: c.body.length, utf16_len: c.body.length },
      };
      const p = plan(state, source);
      const expected = reference(
        state,
        c.body,
        c.linewise === true ? c.body : null,
      );
      const size = pastedSize({
        dest: 'sticky',
        doc: state.doc,
        ranges: p.ranges,
        eol: '\n',
        source,
        linewise: p.linewise,
      });
      // With a line unused (two carets on a line) the size is a little over.
      expect(size.size).toBeGreaterThanOrEqual(expected.length);
      if (!c.name.includes('two carets')) {
        expect(size.size, c.name).toBe(expected.length);
      }
    }
  });
  it('is no line-wise paste with a selection', () => {
    const state = stateOf(doc, [[0, 3], [5]]);
    const p = plan(state, { kind: 'clip', info: info({ linewise: true }) });
    expect(p.linewise).toBe(false);
  });
});

describe('the blocks of a conversion', () => {
  const limit = CONVERT_CHUNK;
  const noSplit = (blocks: string[]): void => {
    for (const b of blocks) {
      expect(b.length).toBeLessThanOrEqual(limit);
      const first = b.charCodeAt(0);
      const last = b.charCodeAt(b.length - 1);
      expect(first >= 0xdc00 && first < 0xe000).toBe(false);
      expect(last >= 0xd800 && last < 0xdc00).toBe(false);
    }
  };
  it('holds at most a mebi-unit and never cuts a surrogate pair in the document', () => {
    const doc = `${'a'.repeat(limit - 1)}😀${'b'.repeat(10)}\n${'c'.repeat(limit * 2)}`;
    const state = stateOf(doc, [[0]]);
    const p = plan(state, text(''));
    const blocks = p.ops.map((o) => (o.kind === 'text' ? o.text : ''));
    noSplit(blocks);
    expect(written(p.ops)).toBe(doc);
    expect(blocks.length).toBeGreaterThan(3);
  });
  it('holds at most a mebi-unit and never cuts a pair or a CRLF in the pasted text', () => {
    const pasted = `${'x'.repeat(limit - 1)}😀${'y'.repeat(limit - 2)}\r\n${'z'.repeat(50)}`;
    const state = stateOf('head', [[4]]);
    const p = plan(state, text(pasted));
    const blocks = p.ops.map((o) => (o.kind === 'text' ? o.text : ''));
    noSplit(blocks);
    for (const b of blocks.slice(0, -1)) {
      expect(b.endsWith('\r')).toBe(false);
    }
    expect(written(p.ops)).toBe(`head${pasted.replace(/\r\n/g, '\n')}`);
  });
  it('sends a clip as a clip and the text around it as blocks', () => {
    const state = stateOf('ab', [[1]]);
    const p = plan(state, { kind: 'clip', info: info({ id: 'zz' }) });
    expect(p.ops).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'clip' },
      { kind: 'text', text: 'b' },
    ]);
  });
  it('sends the document in blocks even when nothing is pasted', () => {
    const state = stateOf('x'.repeat(limit * 2 + 5), [[0]]);
    const ops = [
      ...convertOps({
        doc: state.doc,
        ranges: [],
        linewise: false,
        source: text(''),
      }),
    ];
    expect(ops).toHaveLength(3);
  });
});

describe('pastedSize over several ranges', () => {
  it('takes every replaced range out', () => {
    const state = stateOf('héllo\nwörld\nend', [
      [0, 5],
      [6, 11],
    ]);
    const r = pastedSize({
      dest: 'document',
      doc: state.doc,
      ranges: [
        { from: 0, to: 5, line: null },
        { from: 6, to: 11, line: null },
      ],
      eol: '\n',
      source: text('xy'),
      limit: 0,
    });
    // 'xy\nxy\nend'
    expect(r.size).toBe(9);
  });
  it('does not read the document when the worst case is under the limit', () => {
    const state = stateOf('abc\ndef', [[1], [5]]);
    const r = pastedSize({
      dest: 'document',
      doc: state.doc,
      ranges: [
        { from: 1, to: 1, line: null },
        { from: 5, to: 5, line: null },
      ],
      eol: '\n',
      source: text('Q'),
      limit: 10_000,
    });
    expect(r.exact).toBe(false);
  });
});
