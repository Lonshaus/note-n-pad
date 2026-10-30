// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  EditorSelection,
  EditorState,
  type StateCommand,
  type Transaction,
} from '@codemirror/state';
import type { Command, KeyBinding } from '@codemirror/view';
import {
  cursorDocEnd,
  cursorDocStart,
  indentLess,
  indentMore,
  insertNewlineAndIndent,
  selectDocEnd,
  selectDocStart,
  selectLine,
  selectLineDown,
  selectLineUp,
  simplifySelection,
} from '@codemirror/commands';
import { REBINDABLE, buildKeymap } from '../editor/keymap';
import {
  afterShadowStop,
  classifyCommand,
  dequeueStep,
  globalItemAction,
  globalOpPath,
  globalSelectAction,
  globalStartAction,
  groupDecision,
  inputOutside,
  joinAfterStep,
  keepsInput,
  needsEndPos,
  normalizeBreaks,
  opText,
  selectionOutside,
  shadowStep,
  trackOf,
  undoSelection,
  type GlobalAction,
  type OwnCommands,
  type RoutedItem,
  type SelectSpec,
} from './globalRouting';
import {
  commandChain,
  copiedRange,
  coreKeyBindings,
  type KeyLayers,
} from './replayKeys';
import type { LinePos, LineSelection } from './windowSelection';
interface At {
  line: number;
  col: number;
}
type Op = 'indent' | 'outdent' | 'enter';
// One case of the shared fixture: the Rust tests read the same file, run the
// core commands on `input` (breaks as written) and compare the lines and the
// selection with what CodeMirror produced here.
interface Row {
  name: string;
  op: Op;
  input: string;
  anchor: At;
  head: At;
  lines: string[];
  resultAnchor: At;
  resultHead: At;
}
interface Case {
  name: string;
  op: Op;
  input: string;
  anchor: At;
  head: At;
}
const FIXTURE = new URL('./__fixtures__/cm-indent-enter.json', import.meta.url);
function at(line: number, col: number): At {
  return { line, col };
}
function pos(state: EditorState, p: At): number {
  return state.doc.line(p.line + 1).from + p.col;
}
function where(state: EditorState, offset: number): At {
  const line = state.doc.lineAt(offset);
  return { line: line.number - 1, col: offset - line.from };
}
const COMMANDS = {
  indent: indentMore,
  outdent: indentLess,
  enter: insertNewlineAndIndent,
};
function run(c: Case): Row {
  const state = EditorState.create({ doc: c.input });
  const selected = state.update({
    selection: EditorSelection.single(pos(state, c.anchor), pos(state, c.head)),
  }).state;
  let after = selected;
  COMMANDS[c.op]({
    state: selected,
    dispatch: (tr) => {
      after = tr.state;
    },
  });
  const range = after.selection.main;
  return {
    ...c,
    lines: after.doc.toJSON(),
    resultAnchor: where(after, range.anchor),
    resultHead: where(after, range.head),
  };
}
const long = (n: number): string => ' '.repeat(n);
const CASES: Case[] = [
  {
    name: 'indent: empty lines and a ragged text are all indented',
    op: 'indent',
    input: 'a\n\n  b\n\t\nc',
    anchor: at(0, 0),
    head: at(4, 1),
  },
  {
    name: 'indent: a selection ending at column 0 skips that line',
    op: 'indent',
    input: 'one\ntwo\nthree\nfour',
    anchor: at(0, 1),
    head: at(2, 0),
  },
  {
    name: 'indent: a reversed selection ending at column 0',
    op: 'indent',
    input: 'one\ntwo\nthree\nfour',
    anchor: at(2, 0),
    head: at(0, 2),
  },
  {
    name: 'indent: the anchor at the start of a tab-indented line',
    op: 'indent',
    input: '\tx\n\ty\n\tz',
    anchor: at(0, 0),
    head: at(2, 2),
  },
  {
    name: 'indent: a selection ending inside the last line',
    op: 'indent',
    input: 'ab\ncd\nef',
    anchor: at(0, 1),
    head: at(2, 1),
  },
  {
    name: 'indent: CJK, a surrogate pair and a CRLF line',
    op: 'indent',
    input: '日本語\r\n😀x\r\n\r\nend',
    anchor: at(0, 2),
    head: at(3, 2),
  },
  {
    name: 'indent: lone CR and mixed breaks',
    op: 'indent',
    input: 'a\rb\r\nc\nd\re',
    anchor: at(0, 0),
    head: at(4, 1),
  },
  {
    name: 'outdent: two tabs become six spaces',
    op: 'outdent',
    input: '\t\tx\ny',
    anchor: at(0, 0),
    head: at(1, 1),
  },
  {
    name: 'outdent: the anchor at the start of a tab-indented line',
    op: 'outdent',
    input: '\tx\n\ty\n\tz',
    anchor: at(0, 0),
    head: at(2, 2),
  },
  {
    name: 'outdent: the anchor inside a replaced indent',
    op: 'outdent',
    input: '     x\n   y\n z\nw',
    anchor: at(0, 3),
    head: at(3, 1),
  },
  {
    name: 'outdent: mixed indentation',
    op: 'outdent',
    input: ' \tx\n\t y\n  \t\tz\n    w\n   v',
    anchor: at(0, 0),
    head: at(4, 4),
  },
  {
    name: 'outdent: lines without indentation do not change',
    op: 'outdent',
    input: 'a\nb\nc',
    anchor: at(0, 0),
    head: at(2, 1),
  },
  {
    name: 'outdent: whitespace-only lines and empty lines',
    op: 'outdent',
    input: '    \n\n  \n \t\nx',
    anchor: at(0, 0),
    head: at(4, 1),
  },
  {
    name: 'outdent: U+3000, U+00A0 and U+FEFF indentation',
    op: 'outdent',
    input: '　a\n  b\n﻿c\n  d\nx',
    anchor: at(0, 0),
    head: at(4, 1),
  },
  {
    name: 'outdent: U+0085 is not whitespace',
    op: 'outdent',
    input: '\u0085  a\n  b\nc',
    anchor: at(0, 0),
    head: at(2, 1),
  },
  {
    name: 'outdent: a selection ending at column 0 skips that line',
    op: 'outdent',
    input: '  a\n  b\n  c',
    anchor: at(0, 1),
    head: at(2, 0),
  },
  {
    name: 'outdent: CRLF lines',
    op: 'outdent',
    input: '  a\r\n    b\r\n\t\tc\r\nd',
    anchor: at(0, 0),
    head: at(3, 1),
  },
  {
    name: 'outdent: a lone CR before an emptied line keeps its line',
    op: 'outdent',
    input: 'a\r  \nb\r  \n  c',
    anchor: at(0, 0),
    head: at(4, 1),
  },
  {
    name: 'outdent: a run of lone CR before an emptied line',
    op: 'outdent',
    input: 'a\r\r\r  \nb',
    anchor: at(0, 0),
    head: at(4, 1),
  },
  {
    name: 'outdent: lone CR lines with indentation',
    op: 'outdent',
    input: '  a\r  b\r c\r\n  d\re',
    anchor: at(1, 1),
    head: at(4, 0),
  },
  {
    name: 'outdent: a reversed selection',
    op: 'outdent',
    input: '    a\n    b\n    c',
    anchor: at(2, 3),
    head: at(0, 2),
  },
  {
    name: 'enter: the start inside the indent of the first line moves',
    op: 'enter',
    input: '  abc\ndef\nghi',
    anchor: at(0, 1),
    head: at(2, 1),
  },
  {
    name: 'enter: byte 0 takes no indentation',
    op: 'enter',
    input: '    abc\ndef\nghi',
    anchor: at(0, 0),
    head: at(1, 2),
  },
  {
    name: 'enter: a first line start after text keeps the text',
    op: 'enter',
    input: '  abc\ndef\nghi',
    anchor: at(0, 4),
    head: at(2, 1),
  },
  {
    name: 'enter: a later line starting inside its indent does not move',
    op: 'enter',
    input: 'x\n  abc\ndef\nghi',
    anchor: at(1, 1),
    head: at(3, 1),
  },
  {
    name: 'enter: a later all-whitespace line moves',
    op: 'enter',
    input: 'x\n   \nabc\nghi',
    anchor: at(1, 2),
    head: at(3, 1),
  },
  {
    name: 'enter: the second line from column 1 with a longer indent moves',
    op: 'enter',
    input: 'x\n    y\nz\nw',
    anchor: at(1, 1),
    head: at(3, 1),
  },
  {
    name: 'enter: the lower bound, CJK before the line',
    op: 'enter',
    input: '日本語日本語\n  abc\ndef\nghi',
    anchor: at(1, 1),
    head: at(3, 1),
  },
  {
    name: 'enter: the upper bound, a short line start and a long indent',
    op: 'enter',
    input: 'ab\n      abc\ndef\nghi',
    anchor: at(1, 2),
    head: at(3, 1),
  },
  {
    name: 'enter: exact count moves, CJK before the line',
    op: 'enter',
    input: '日日日\n      x\ny\nz',
    anchor: at(1, 1),
    head: at(3, 1),
  },
  {
    name: 'enter: exact count does not move, CJK and ASCII before the line',
    op: 'enter',
    input: '日日a\n    x\ny\nz',
    anchor: at(1, 1),
    head: at(3, 1),
  },
  {
    name: 'enter: exact count does not move, a surrogate pair and a CRLF',
    op: 'enter',
    input: '😀\r\n   x\ny\nz',
    anchor: at(1, 1),
    head: at(3, 1),
  },
  {
    name: 'enter: exact count moves, a surrogate pair and a CRLF',
    op: 'enter',
    input: '😀\r\n    x\ny\nz',
    anchor: at(1, 1),
    head: at(3, 1),
  },
  {
    name: 'enter: exact count with lone CR breaks before the line',
    op: 'enter',
    input: '日\r日\r     x\ny\nz',
    anchor: at(2, 1),
    head: at(4, 0),
  },
  {
    name: 'enter: the start at column 100 or later does not move',
    op: 'enter',
    input: `${long(150)}abc\ndef\nghi`,
    anchor: at(0, 100),
    head: at(2, 1),
  },
  {
    name: 'enter: the start at column 99 of a blank first line moves',
    op: 'enter',
    input: `${long(150)}abc\ndef\nghi`,
    anchor: at(0, 99),
    head: at(2, 1),
  },
  {
    name: 'enter: tabs count to the next multiple of 4',
    op: 'enter',
    input: 'a\n \t\t foo\nbar\nbaz',
    anchor: at(1, 5),
    head: at(3, 1),
  },
  {
    name: 'enter: U+3000 and U+00A0 are whitespace',
    op: 'enter',
    input: 'x\n　 　y\nz\nw',
    anchor: at(1, 1),
    head: at(3, 0),
  },
  {
    name: 'enter: a start after non-whitespace text',
    op: 'enter',
    input: 'ab  cd\n  ef\ngh',
    anchor: at(0, 3),
    head: at(2, 1),
  },
  {
    name: 'enter: a reversed selection',
    op: 'enter',
    input: '  abc\ndef\nghi',
    anchor: at(2, 1),
    head: at(0, 1),
  },
  {
    name: 'enter: a lone CR before the line start',
    op: 'enter',
    input: 'a\r  b\nc\nd',
    anchor: at(1, 1),
    head: at(3, 0),
  },
  {
    name: 'enter: a run of lone CR before the line start',
    op: 'enter',
    input: 'a\r\r\r   b\nc\nd',
    anchor: at(3, 1),
    head: at(5, 0),
  },
  {
    name: 'enter: CRLF lines',
    op: 'enter',
    input: 'x\r\n  y\r\nz\r\nw',
    anchor: at(1, 1),
    head: at(3, 1),
  },
  {
    name: 'enter: an empty line start in the middle of the file',
    op: 'enter',
    input: 'ab\n\ncd\nef',
    anchor: at(1, 0),
    head: at(3, 1),
  },
];
describe('cm-indent-enter fixture', () => {
  it('has a row for every case, with names that are unique', () => {
    expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length);
  });
  it('holds what CodeMirror does for every case', () => {
    const rows = CASES.map(run);
    if (process.env['UPDATE_FIXTURE'] === '1') {
      writeFileSync(FIXTURE, `${JSON.stringify(rows, null, 2)}\n`);
    }
    // Parsed values are compared, never the formatting.
    const stored: unknown = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    expect(stored).toEqual(rows);
  });
  it('changes something in the indent and enter cases', () => {
    for (const row of CASES.map(run)) {
      const same = row.lines.join('\n') === row.input.replace(/\r\n?/g, '\n');
      if (row.op !== 'outdent' || !row.name.includes('do not change')) {
        expect(same, row.name).toBe(false);
      }
    }
  });
});
// --- Routing -----------------------------------------------------------------
const sel = (
  anchorLine: number,
  anchorCol: number,
  headLine: number,
  headCol: number,
): LineSelection => ({
  anchor: { line: anchorLine, col: anchorCol },
  head: { line: headLine, col: headCol },
});
const caret = (line: number, col: number): LineSelection =>
  sel(line, col, line, col);
const LARGE = sel(0, 0, 5000, 0);
const SMALL = sel(100, 0, 110, 0);
const TOTAL = 9000;
const win = { startLine: 1000, lineCount: 2000 };

describe('inputOutside', () => {
  it('is true for a selection one window holds that lies outside the loaded one', () => {
    expect(selectionOutside(SMALL, win)).toBe(true);
    expect(inputOutside(SMALL, win)).toBe(true);
  });
  it('is false for a selection one window holds that lies inside the loaded one', () => {
    const inside = sel(1500, 0, 1510, 0);
    expect(inputOutside(inside, win)).toBe(false);
    expect(inputOutside(caret(1500, 3), win)).toBe(false);
  });
  it('is true for a selection no window holds, wherever the window is', () => {
    expect(globalOpPath(LARGE)).toBe(true);
    for (const startLine of [0, 1000, 3000, 4500, 10000]) {
      expect(inputOutside(LARGE, { startLine, lineCount: 2000 })).toBe(true);
    }
  });
  it('is false for a selection no window holds only through selectionOutside', () => {
    expect(selectionOutside(LARGE, win)).toBe(false);
  });
});

describe('keepsInput', () => {
  const base = {
    swapping: true,
    replaySwap: true,
    locked: false,
    holds: 0,
    gateReadOnly: false,
    ownGlobalOp: false,
  };
  it('keeps the editor open to a composition during the swap back to the caret', () => {
    expect(keepsInput(base)).toBe(true);
  });
  it('keeps it while this editor own global operation holds the gate', () => {
    expect(keepsInput({ ...base, gateReadOnly: true, ownGlobalOp: true })).toBe(
      true,
    );
  });
  it('does not when the gate is read-only for work of another kind', () => {
    expect(
      keepsInput({ ...base, gateReadOnly: true, ownGlobalOp: false }),
    ).toBe(false);
  });
  it('does not outside a replay swap, when locked or while a hold runs', () => {
    expect(keepsInput({ ...base, swapping: false })).toBe(false);
    expect(keepsInput({ ...base, replaySwap: false })).toBe(false);
    expect(keepsInput({ ...base, locked: true })).toBe(false);
    expect(keepsInput({ ...base, holds: 1 })).toBe(false);
  });
});

describe('globalStartAction', () => {
  const idle = {
    gone: false,
    locked: false,
    swapping: false,
    capturing: false,
    composing: false,
    holds: 0,
  };
  it('waits for a composition no capture covers', () => {
    expect(globalStartAction({ ...idle, composing: true })).toBe('wait');
  });
  it('runs with a captured composition open, or none', () => {
    expect(
      globalStartAction({ ...idle, composing: true, capturing: true }),
    ).toBe('run');
    expect(globalStartAction(idle)).toBe('run');
  });
  it('waits for a swap or a hold and drops for a locked editor', () => {
    expect(globalStartAction({ ...idle, swapping: true })).toBe('wait');
    expect(globalStartAction({ ...idle, holds: 1 })).toBe('wait');
    expect(globalStartAction({ ...idle, locked: true })).toBe('drop');
  });
});

describe('normalizeBreaks', () => {
  const text = 'a\r\nb\rc\n';
  it('writes the breaks of a CRLF file', () => {
    expect(normalizeBreaks(text, '\r\n')).toBe('a\r\nb\r\nc\r\n');
  });
  it('writes the breaks of an LF file', () => {
    expect(normalizeBreaks(text, '\n')).toBe('a\nb\nc\n');
  });
});

describe('opText', () => {
  const text = 'a\r\nb\rc\n';
  it('writes a replace with the breaks of a CRLF file', () => {
    expect(opText('replace', text, '\r\n')).toBe('a\r\nb\r\nc\r\n');
  });
  it('writes a replace with the breaks of an LF file', () => {
    expect(opText('replace', text, '\n')).toBe('a\nb\nc\n');
  });
  it('writes a split line as the file separator', () => {
    expect(opText('split', 'ignored', '\r\n')).toBe('\r\n');
    expect(opText('split', 'ignored', '\n')).toBe('\n');
  });
  it('writes nothing for a delete', () => {
    expect(opText('delete', 'typed', '\n')).toBe('');
  });
});

describe('trackOf', () => {
  it('hands over both ends of a selection too large for a window only', () => {
    expect(trackOf(LARGE)).toEqual([LARGE.anchor, LARGE.head]);
    expect(trackOf(SMALL)).toBeUndefined();
  });
});

describe('groupDecision', () => {
  const prev = { time: 1000, kind: 'input', composing: false };
  const current = {
    time: 1100,
    kind: 'input',
    composing: false,
    compositionStart: false,
  };
  it('joins the group of the global delete before it', () => {
    expect(
      groupDecision({
        joinNextApply: true,
        forceNewGroup: false,
        prev,
        current,
      }),
    ).toBe(false);
  });
  it('joins even where the kind changed', () => {
    expect(
      groupDecision({
        joinNextApply: true,
        forceNewGroup: false,
        prev,
        current: { ...current, kind: 'delete' },
      }),
    ).toBe(false);
  });
  it('follows the usual rules without the flag', () => {
    expect(
      groupDecision({
        joinNextApply: false,
        forceNewGroup: false,
        prev,
        current: { ...current, kind: 'delete' },
      }),
    ).toBe(true);
    expect(
      groupDecision({
        joinNextApply: false,
        forceNewGroup: false,
        prev,
        current,
      }),
    ).toBe(false);
    expect(
      groupDecision({
        joinNextApply: false,
        forceNewGroup: true,
        prev,
        current,
      }),
    ).toBe(true);
  });
  it('clears the flag when anything but the edit comes first', () => {
    for (const step of [
      'select',
      'undo',
      'global',
      'keySelect',
      'drop',
      'done',
    ] as const) {
      expect(joinAfterStep(true, step), step).toBe(false);
    }
    for (const step of ['run', 'wait', 'swap', 'map'] as const) {
      expect(joinAfterStep(true, step), step).toBe(true);
    }
    expect(joinAfterStep(false, 'run')).toBe(false);
  });
});

describe('undoSelection', () => {
  const tracked: [LinePos, LinePos] = [
    { line: 3, col: 1 },
    { line: 9000, col: 4 },
  ];
  const want = { anchor: tracked[0], head: tracked[1] };
  it('gives the tracked selection to the mirror branch', () => {
    expect(undoSelection({ tracked, branch: 'mirror' })).toEqual({
      sel: want,
      mode: 'none',
    });
  });
  it('gives it to the reload-only branch, which reads the window again', () => {
    expect(undoSelection({ tracked, branch: 'reload_only' })).toEqual({
      sel: want,
      mode: 'reload',
    });
  });
  it('reveals the tracked head after a jump, not a caret at the change', () => {
    expect(undoSelection({ tracked, branch: 'goto' })).toEqual({
      sel: want,
      mode: 'reveal',
    });
  });
  it('jumps to the change when nothing was tracked', () => {
    expect(undoSelection({ tracked: undefined, branch: 'goto' })).toEqual({
      sel: null,
      mode: 'goto',
    });
    expect(
      undoSelection({ tracked: undefined, branch: 'mirror' }).sel,
    ).toBeNull();
  });
});
// --- The command table -------------------------------------------------------
const own: OwnCommands = {
  closeBox: () => false,
  selectVisible: () => true,
  undo: () => true,
  redo: () => true,
};
// The editor-scope defaults of the shortcut registry: id, macOS, Windows.
const DEFAULTS: [string, string, string][] = [
  ['editor.move-line-up', 'Alt+ArrowUp', 'Alt+ArrowUp'],
  ['editor.move-line-down', 'Alt+ArrowDown', 'Alt+ArrowDown'],
  ['editor.copy-line-up', 'Alt+Shift+ArrowUp', 'Alt+Shift+ArrowUp'],
  ['editor.copy-line-down', 'Alt+Shift+ArrowDown', 'Alt+Shift+ArrowDown'],
  ['editor.add-cursor-above', 'Alt+Cmd+ArrowUp', 'Ctrl+Alt+ArrowUp'],
  ['editor.add-cursor-below', 'Alt+Cmd+ArrowDown', 'Ctrl+Alt+ArrowDown'],
  ['editor.insert-line-below', 'Cmd+Enter', 'Ctrl+Enter'],
  ['editor.select-line', 'Ctrl+L', 'Alt+L'],
  ['editor.expand-selection', 'Cmd+I', 'Ctrl+I'],
  ['editor.outdent', 'Cmd+[', 'Ctrl+['],
  ['editor.indent', 'Cmd+]', 'Ctrl+]'],
  ['editor.reindent', 'Alt+Cmd+\\', 'Ctrl+Alt+\\'],
  ['editor.delete-line', 'Shift+Cmd+K', 'Ctrl+Shift+K'],
  ['editor.go-to-bracket', 'Shift+Cmd+\\', 'Ctrl+Shift+\\'],
  ['editor.toggle-line-comment', 'Cmd+/', 'Ctrl+/'],
  ['editor.toggle-block-comment', 'Ctrl+Shift+A', 'Alt+Shift+A'],
  ['editor.toggle-tab-focus', 'Ctrl+Shift+M', 'Ctrl+M'],
];
const OSES = ['macos', 'windows', 'linux'] as const;
function layersFor(os: string): KeyLayers {
  const mac = os === 'macos';
  const { offscreen, normal } = buildKeymap('windowed', os, (id) => {
    const row = DEFAULTS.find(([rowId]) => rowId === id);
    return row === undefined ? null : mac ? row[1] : row[2];
  });
  return [offscreen, coreKeyBindings(own), normal];
}
interface Ev {
  key: string;
  keyCode: number;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}
function ev(key: string, keyCode: number, mods: Partial<Ev> = {}): Ev {
  return {
    key,
    keyCode,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...mods,
  };
}
const KEYS = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
} as const;
function keyEv(name: keyof typeof KEYS, mods: Partial<Ev> = {}): Ev {
  return ev(name, KEYS[name], mods);
}
function actionOf(
  os: string,
  e: Ev,
  over: { panelOpen?: boolean; sel?: LineSelection; item?: RoutedItem } = {},
): GlobalAction {
  return globalItemAction({
    item: over.item ?? { kind: 'key' },
    sel: over.sel ?? LARGE,
    commands: commandChain(layersFor(os), e, os),
    panelOpen: over.panelOpen ?? false,
    own,
    totalLines: TOTAL,
  });
}
const op = (o: string): GlobalAction => ({ type: 'op', op: o }) as GlobalAction;
const select = (select: SelectSpec): GlobalAction => ({
  type: 'select',
  select,
});

describe('the command table', () => {
  it('has a row for every command of the windowed keymap on every platform', () => {
    for (const os of OSES) {
      const layers = layersFor(os);
      for (const layer of layers) {
        for (const binding of layer as readonly KeyBinding[]) {
          for (const command of [binding.run, binding.shift]) {
            if (command === undefined) {
              continue;
            }
            expect(
              classifyCommand(command as Command, own),
              `${os} ${binding.key ?? binding.mac ?? binding.linux ?? binding.win}`,
            ).not.toBeUndefined();
          }
        }
      }
    }
  });

  it('has a row for every command a user can bind in the windowed editor', () => {
    for (const command of REBINDABLE) {
      if (command.profiles.includes('windowed')) {
        expect(
          classifyCommand(command.run, own),
          command.id,
        ).not.toBeUndefined();
      }
    }
  });

  it('keeps the syntax moves as normal for now', () => {
    expect(actionOf('macos', keyEv('ArrowLeft', { ctrlKey: true }))).toEqual({
      type: 'normal',
    });
    expect(
      actionOf(
        'windows',
        keyEv('ArrowRight', { altKey: true, shiftKey: true }),
      ),
    ).toEqual({ type: 'normal' });
  });
});

describe('globalItemAction', () => {
  it('answers normal for every item when one window holds the selection', () => {
    const items: RoutedItem[] = [
      { kind: 'text', userEvent: 'input.type' },
      { kind: 'text', userEvent: 'input.paste' },
      { kind: 'key' },
    ];
    for (const item of items) {
      expect(actionOf('macos', keyEv('Delete'), { sel: SMALL, item })).toEqual({
        type: 'normal',
      });
    }
  });

  it('deletes first for typed text and for the text a composition committed', () => {
    const item: RoutedItem = { kind: 'text', userEvent: 'input.type' };
    expect(actionOf('macos', keyEv('Enter'), { item })).toEqual({
      type: 'deleteFirst',
    });
  });

  it('replaces the selection with pasted text', () => {
    const item: RoutedItem = { kind: 'text', userEvent: 'input.paste' };
    expect(actionOf('macos', keyEv('Enter'), { item })).toEqual(op('replace'));
  });

  it('runs a handled selection key on the window as it is', () => {
    const item: RoutedItem = { kind: 'key', handled: true };
    expect(
      actionOf('macos', keyEv('ArrowRight', { shiftKey: true }), { item }),
    ).toEqual({ type: 'normal' });
  });

  it('leaves the other kinds of item to the drain', () => {
    for (const kind of ['select', 'undo', 'redo', 'slot'] as const) {
      expect(
        actionOf('macos', keyEv('Delete'), { item: { kind } }),
        kind,
      ).toEqual({ type: 'normal' });
    }
  });

  it('deletes the selection for every delete key', () => {
    const mac: Ev[] = [
      keyEv('Backspace'),
      keyEv('Backspace', { shiftKey: true }),
      keyEv('Delete'),
      keyEv('Backspace', { altKey: true }),
      keyEv('Delete', { altKey: true }),
      keyEv('Backspace', { metaKey: true }),
      keyEv('Delete', { metaKey: true }),
      ev('d', 68, { ctrlKey: true }),
      ev('h', 72, { ctrlKey: true }),
      ev('k', 75, { ctrlKey: true }),
      ev('h', 72, { ctrlKey: true, altKey: true }),
    ];
    for (const e of mac) {
      expect(actionOf('macos', e), JSON.stringify(e)).toEqual(op('delete'));
    }
    for (const os of ['windows', 'linux']) {
      const others: Ev[] = [
        keyEv('Backspace'),
        keyEv('Delete'),
        keyEv('Backspace', { ctrlKey: true }),
        keyEv('Delete', { ctrlKey: true }),
      ];
      for (const e of others) {
        expect(actionOf(os, e), `${os} ${JSON.stringify(e)}`).toEqual(
          op('delete'),
        );
      }
    }
  });

  it('turns Enter and Shift+Enter into the global Enter', () => {
    for (const os of OSES) {
      expect(actionOf(os, keyEv('Enter'))).toEqual(op('enter'));
      expect(actionOf(os, keyEv('Enter', { shiftKey: true }))).toEqual(
        op('enter'),
      );
    }
  });

  it('splits the line with the Emacs key on macOS', () => {
    expect(actionOf('macos', ev('o', 79, { ctrlKey: true }))).toEqual(
      op('split'),
    );
  });

  it('indents and outdents with Tab, the bracket keys and their Shift forms', () => {
    for (const os of OSES) {
      const mod = os === 'macos' ? { metaKey: true } : { ctrlKey: true };
      expect(actionOf(os, keyEv('Tab'))).toEqual(op('indent'));
      expect(actionOf(os, ev(']', 221, mod))).toEqual(op('indent'));
      expect(actionOf(os, keyEv('Tab', { shiftKey: true }))).toEqual(
        op('outdent'),
      );
      expect(actionOf(os, ev('[', 219, mod))).toEqual(op('outdent'));
    }
  });

  it('turns the undo and redo keys into undo and redo items', () => {
    expect(actionOf('macos', ev('z', 90, { metaKey: true }))).toEqual({
      type: 'undo',
    });
    expect(
      actionOf('macos', ev('z', 90, { metaKey: true, shiftKey: true })),
    ).toEqual({ type: 'redo' });
    expect(actionOf('windows', ev('z', 90, { ctrlKey: true }))).toEqual({
      type: 'undo',
    });
  });

  it('drops the edits that are no goal of the global path', () => {
    expect(actionOf('macos', keyEv('ArrowUp', { altKey: true }))).toEqual({
      type: 'drop',
    });
    expect(actionOf('macos', keyEv('Enter', { metaKey: true }))).toEqual({
      type: 'drop',
    });
    expect(
      actionOf('windows', ev('k', 75, { ctrlKey: true, shiftKey: true })),
    ).toEqual({ type: 'drop' });
    expect(actionOf('windows', ev('i', 73, { ctrlKey: true }))).toEqual({
      type: 'drop',
    });
  });

  it('drops a key that no command of the table answers', () => {
    expect(
      actionOf('macos', ev('q', 81, { altKey: true, metaKey: true })),
    ).toEqual({ type: 'drop' });
  });

  it('leaves the tab-focus toggle, Select All and the visible Select All as they are', () => {
    expect(actionOf('windows', ev('m', 77, { ctrlKey: true }))).toEqual({
      type: 'normal',
    });
    for (const os of OSES) {
      const mod = os === 'macos' ? { metaKey: true } : { ctrlKey: true };
      expect(actionOf(os, ev('a', 65, mod))).toEqual({ type: 'normal' });
    }
  });

  describe('Escape', () => {
    it('collapses the selection to its head when no panel is open', () => {
      expect(actionOf('macos', keyEv('Escape'))).toEqual(
        select({ type: 'simplify' }),
      );
    });
    it('closes the panel when one is open', () => {
      expect(actionOf('macos', keyEv('Escape'), { panelOpen: true })).toEqual({
        type: 'normal',
      });
    });
  });

  it('moves the selection with the arrows, Home, End and the page keys', () => {
    expect(actionOf('macos', keyEv('ArrowRight'))).toEqual(
      select({ type: 'collapse', forward: true }),
    );
    expect(actionOf('macos', keyEv('ArrowLeft'))).toEqual(
      select({ type: 'collapse', forward: false }),
    );
    expect(actionOf('macos', keyEv('ArrowDown'))).toEqual(
      select({ type: 'collapse', forward: true }),
    );
    expect(actionOf('macos', keyEv('End'))).toEqual(
      select({ type: 'lineBoundary' }),
    );
    expect(actionOf('macos', keyEv('ArrowRight', { shiftKey: true }))).toEqual(
      select({ type: 'extend', forward: true }),
    );
    expect(actionOf('macos', keyEv('ArrowUp', { shiftKey: true }))).toEqual(
      select({ type: 'extend', forward: false }),
    );
    expect(actionOf('macos', keyEv('ArrowUp', { metaKey: true }))).toEqual(
      select({ type: 'docEdge', end: false }),
    );
    expect(
      actionOf('macos', keyEv('ArrowDown', { metaKey: true, shiftKey: true })),
    ).toEqual(select({ type: 'extendDoc', end: true }));
    expect(actionOf('windows', keyEv('Home', { ctrlKey: true }))).toEqual(
      select({ type: 'docEdge', end: false }),
    );
    expect(
      actionOf('windows', keyEv('End', { ctrlKey: true, shiftKey: true })),
    ).toEqual(select({ type: 'extendDoc', end: true }));
    expect(actionOf('windows', ev('l', 76, { altKey: true }))).toEqual(
      select({ type: 'line' }),
    );
  });
});

describe('dequeueStep', () => {
  const base = {
    sel: LARGE,
    commands: [] as Command[],
    panelOpen: false,
    own,
    swapping: false,
    holds: 0,
    headMapping: false,
    ready: false,
    totalLines: TOTAL,
  };
  it('runs typed text as a global delete, not a swap, when the head is outside the window', () => {
    const r = dequeueStep({
      ...base,
      item: { kind: 'text', userEvent: 'input.type' },
    });
    expect(r.step).toBe('global');
    expect(r.action).toEqual({ type: 'deleteFirst' });
  });
  it('would swap for the same text under a selection one window holds', () => {
    expect(
      dequeueStep({
        ...base,
        sel: SMALL,
        item: { kind: 'text', userEvent: 'input.type' },
      }).step,
    ).toBe('swap');
  });
  it('waits for a swap or a hold before a global operation', () => {
    const item: RoutedItem = { kind: 'text', userEvent: 'input.paste' };
    expect(dequeueStep({ ...base, item, swapping: true }).step).toBe('wait');
    expect(dequeueStep({ ...base, item, holds: 1 }).step).toBe('wait');
  });
  it('applies a selection key and drops what has no meaning', () => {
    const chain = (e: Ev) => commandChain(layersFor('macos'), e, 'macos');
    expect(
      dequeueStep({
        ...base,
        item: { kind: 'key' },
        commands: chain(keyEv('ArrowRight', { shiftKey: true })),
      }).step,
    ).toBe('keySelect');
    expect(
      dequeueStep({
        ...base,
        item: { kind: 'key' },
        commands: chain(keyEv('ArrowUp', { altKey: true })),
      }).step,
    ).toBe('drop');
  });
  it('runs an undo key as an undo', () => {
    const commands = commandChain(
      layersFor('macos'),
      ev('z', 90, { metaKey: true }),
      'macos',
    );
    const r = dequeueStep({ ...base, item: { kind: 'key' }, commands });
    expect(r.step).toBe('undo');
    expect(r.action).toEqual({ type: 'undo' });
  });
  it('is the drain step for an item that stays on the window', () => {
    expect(
      dequeueStep({
        ...base,
        item: { kind: 'key', handled: true },
        ready: true,
      }).step,
    ).toBe('run');
    expect(dequeueStep({ ...base, item: undefined, ready: true }).step).toBe(
      'done',
    );
    expect(dequeueStep({ ...base, item: undefined, ready: false }).step).toBe(
      'swap',
    );
  });
});

describe('shadowStep', () => {
  const base = {
    sel: LARGE,
    commands: [] as Command[],
    panelOpen: false,
    own,
    headMapping: false,
    ready: false,
    totalLines: TOTAL,
  };
  it('stops for the operations the read loop runs', () => {
    expect(
      shadowStep({
        ...base,
        item: { kind: 'text', userEvent: 'input.type' },
      }).step,
    ).toBe('global');
    expect(
      shadowStep({
        ...base,
        item: { kind: 'text', userEvent: 'input.paste' },
      }).step,
    ).toBe('global');
    expect(
      shadowStep({
        ...base,
        item: { kind: 'key' },
        commands: commandChain(layersFor('macos'), keyEv('Delete'), 'macos'),
      }).step,
    ).toBe('global');
  });
  it('runs a selection key itself', () => {
    expect(
      shadowStep({
        ...base,
        item: { kind: 'key' },
        commands: commandChain(
          layersFor('macos'),
          keyEv('End', { shiftKey: true }),
          'macos',
        ),
      }).step,
    ).toBe('keySelect');
  });
  it('judges by the selection it is given', () => {
    const item: RoutedItem = { kind: 'text', userEvent: 'input.type' };
    expect(shadowStep({ ...base, item, sel: SMALL, ready: true }).step).toBe(
      'run',
    );
    expect(shadowStep({ ...base, item, sel: LARGE, ready: true }).step).toBe(
      'global',
    );
  });
});
describe('a copy or cut through a clip', () => {
  const route = (
    item: RoutedItem,
    from: LineSelection,
    totalLines = TOTAL,
  ): GlobalAction =>
    globalItemAction({
      item,
      sel: from,
      commands: [],
      panelOpen: false,
      own,
      totalLines,
    });
  const clipCopy = { kind: 'copy', clip: true } as const;
  const clipCut = { kind: 'cut', clip: true } as const;
  const supplyCopy = { kind: 'copy' } as const;
  const supplyCut = { kind: 'cut' } as const;
  const copyOf = (from: LineSelection) => ({
    anchor: from.anchor,
    head: from.head,
  });

  it('copies through a clip whatever the size of the selection', () => {
    for (const from of [LARGE, SMALL]) {
      expect(route(clipCopy, from)).toEqual({
        type: 'clipCopy',
        copy: copyOf(from),
        linewise: false,
        refuseSupply: false,
      });
    }
  });
  it('cuts through a clip whatever the size of the selection', () => {
    for (const from of [LARGE, SMALL]) {
      expect(route(clipCut, from)).toEqual({
        type: 'op',
        op: 'clipCut',
        cut: {
          copy: copyOf(from),
          remove: copyOf(from),
          linewise: false,
          refuseSupply: false,
        },
      });
    }
  });
  it('turns a copy that supplies the web clipboard into a clip once the selection outgrew a window, and refuses the supply', () => {
    expect(route(supplyCopy, LARGE)).toEqual({
      type: 'clipCopy',
      copy: copyOf(LARGE),
      linewise: false,
      refuseSupply: true,
    });
    expect(route(supplyCut, LARGE)).toEqual({
      type: 'op',
      op: 'clipCut',
      cut: {
        copy: copyOf(LARGE),
        remove: copyOf(LARGE),
        linewise: false,
        refuseSupply: true,
      },
    });
  });
  it('leaves a copy that supplies the web clipboard as it is while one window holds the selection', () => {
    expect(route(supplyCopy, SMALL)).toEqual({ type: 'normal' });
    expect(route(supplyCut, SMALL)).toEqual({ type: 'normal' });
  });
  it('takes the same range for a cut that turned into a clip as for a queued clip', () => {
    const queued = route(clipCut, LARGE);
    const grown = route(supplyCut, LARGE);
    if (queued.type !== 'op' || grown.type !== 'op') {
      throw new Error('not an operation');
    }
    if (queued.op !== 'clipCut' || grown.op !== 'clipCut') {
      throw new Error('not a cut');
    }
    expect({ ...grown.cut, refuseSupply: false }).toEqual(queued.cut);
  });

  describe('with a caret, against CodeMirror', () => {
    const text = 'abc\ndef\nghi';
    const base = EditorState.create({ doc: text });
    const total = base.doc.lines;
    const caretAt = (line: number): LineSelection => sel(line, 1, line, 1);
    const stateAt = (line: number): EditorState =>
      base.update({
        selection: EditorSelection.cursor(base.doc.line(line + 1).from + 1),
      }).state;
    // The offset of a position, a column past the end standing for the end of
    // the line as the core reads it.
    const offset = (p: LinePos): number => {
      const line = base.doc.line(p.line + 1);
      return Math.min(line.from + p.col, line.to);
    };

    for (let line = 0; line < total; line += 1) {
      it(`copies the text of line ${line + 1} without its break, as a line`, () => {
        const action = route(clipCopy, caretAt(line), total);
        const cm = copiedRange(stateAt(line));
        if (action.type !== 'clipCopy') {
          throw new Error('not a clip copy');
        }
        expect(
          text.slice(offset(action.copy.anchor), offset(action.copy.head)),
        ).toBe(cm.text);
        expect(action.linewise).toBe(cm.linewise);
        expect(action.linewise).toBe(true);
      });
      it(`cuts line ${line + 1} and the break after it, the last line to the end`, () => {
        const action = route(clipCut, caretAt(line), total);
        const cm = copiedRange(stateAt(line));
        if (action.type !== 'op' || action.op !== 'clipCut') {
          throw new Error('not a clip cut');
        }
        const { cut } = action;
        expect(text.slice(offset(cut.copy.anchor), offset(cut.copy.head))).toBe(
          cm.text,
        );
        const head =
          cut.remove.head === 'end' ? base.doc.length : offset(cut.remove.head);
        expect([offset(cut.remove.anchor), head]).toEqual([
          cm.ranges[0]?.from,
          cm.ranges[0]?.to,
        ]);
        expect(cut.remove.head === 'end').toBe(line === total - 1);
        expect(cut.linewise).toBe(true);
      });
    }
    it('copies and cuts the line of a caret that stands in a file of one line', () => {
      const action = route(clipCut, caretAt(0), 1);
      if (action.type !== 'op' || action.op !== 'clipCut') {
        throw new Error('not a clip cut');
      }
      expect(action.cut.remove.head).toBe('end');
    });
    it('copies the text of a range with the same ends it was given', () => {
      const from = sel(0, 1, 2, 2);
      const action = route(clipCopy, from, total);
      if (action.type !== 'clipCopy') {
        throw new Error('not a clip copy');
      }
      const cmState = base.update({
        selection: EditorSelection.single(
          offset(from.anchor),
          offset(from.head),
        ),
      }).state;
      expect(
        text.slice(offset(action.copy.anchor), offset(action.copy.head)),
      ).toBe(copiedRange(cmState).text);
      expect(action.linewise).toBe(false);
    });
  });
});

describe('the steps of a copy through a clip', () => {
  const base = {
    sel: LARGE,
    commands: [] as Command[],
    panelOpen: false,
    own,
    headMapping: false,
    ready: false,
    totalLines: TOTAL,
  };
  const copy: RoutedItem = { kind: 'copy', clip: true };
  const cut: RoutedItem = { kind: 'cut', clip: true };
  it('is a step of its own, which does not wait for the window to hold the selection', () => {
    const r = dequeueStep({ ...base, item: copy, swapping: false, holds: 0 });
    expect(r.step).toBe('clipCopy');
    expect(r.action.type).toBe('clipCopy');
  });
  it('waits for a swap or a hold', () => {
    expect(
      dequeueStep({ ...base, item: copy, swapping: true, holds: 0 }).step,
    ).toBe('wait');
    expect(
      dequeueStep({ ...base, item: copy, swapping: false, holds: 1 }).step,
    ).toBe('wait');
  });
  it('makes a cut a whole-file operation', () => {
    const r = dequeueStep({ ...base, item: cut, swapping: false, holds: 0 });
    expect(r.step).toBe('global');
    expect(r.action).toMatchObject({ type: 'op', op: 'clipCut' });
  });
  it('stops the shadow for a copy and for a cut', () => {
    expect(shadowStep({ ...base, item: copy }).step).toBe('global');
    expect(shadowStep({ ...base, item: cut }).step).toBe('global');
    expect(shadowStep({ ...base, item: copy }).action.type).toBe('clipCopy');
  });
  it('does not keep the flag that joins the next edit to a delete', () => {
    expect(joinAfterStep(true, 'clipCopy')).toBe(false);
  });
});

describe('afterShadowStop', () => {
  it('reads the window again after a copy through a clip, a cut and any other whole-file operation', () => {
    const copy = actionFor({ kind: 'copy', clip: true });
    const cut = actionFor({ kind: 'cut', clip: true });
    expect(afterShadowStop(copy)).toBe('reread');
    expect(afterShadowStop(cut)).toBe('reread');
    expect(afterShadowStop({ type: 'op', op: 'delete' })).toBe('reread');
    expect(afterShadowStop({ type: 'op', op: 'indent' })).toBe('reread');
    expect(afterShadowStop({ type: 'deleteFirst' })).toBe('reread');
  });
  it('has nothing to read again for an action that is none', () => {
    expect(afterShadowStop({ type: 'normal' })).toBe('end');
    expect(afterShadowStop({ type: 'drop' })).toBe('end');
  });
});

describe('opText of a cut through a clip', () => {
  it('puts nothing in place of the selection', () => {
    expect(opText('clipCut', 'abc', '\n')).toBe('');
  });
});

function actionFor(item: RoutedItem): GlobalAction {
  return globalItemAction({
    item,
    sel: LARGE,
    commands: [],
    panelOpen: false,
    own,
    totalLines: TOTAL,
  });
}
// --- Selection keys ----------------------------------------------------------
const END: LinePos = { line: 9000, col: 12 };
const act = (spec: SelectSpec, from: LineSelection) =>
  globalSelectAction(spec, from, END);

describe('globalSelectAction', () => {
  const FROM = sel(2000, 5, 4000, 7);
  const BACK = sel(4000, 7, 2000, 5);

  it('collapses a move to the later end going forward and the earlier going back', () => {
    for (const from of [FROM, BACK]) {
      expect(act({ type: 'collapse', forward: true }, from)).toEqual({
        sel: caret(4000, 7),
        replay: false,
        restore: null,
      });
      expect(act({ type: 'collapse', forward: false }, from).sel).toEqual(
        caret(2000, 5),
      );
    }
  });

  it('matches the end CodeMirror takes with a range collapsed by an arrow key', () => {
    const range = EditorSelection.range(30, 10);
    expect(range.to).toBe(30);
    expect(range.from).toBe(10);
  });

  it('puts a line boundary move at the head and replays it there', () => {
    expect(act({ type: 'lineBoundary' }, FROM)).toEqual({
      sel: caret(4000, 7),
      replay: true,
      restore: null,
    });
    expect(act({ type: 'lineBoundary' }, BACK).sel).toEqual(caret(2000, 5));
  });

  it('leaves the caret at the head when End finds the head at the end of its line', () => {
    const all = sel(0, 0, 9000, 12);
    expect(act({ type: 'lineBoundary' }, all).sel).toEqual(caret(9000, 12));
  });

  it('moves a document edge without a replay', () => {
    expect(act({ type: 'docEdge', end: false }, FROM)).toEqual({
      sel: caret(0, 0),
      replay: false,
      restore: null,
    });
    expect(act({ type: 'docEdge', end: true }, FROM).sel).toEqual(
      caret(9000, 12),
    );
  });

  it('moves the head to a document edge and keeps the anchor', () => {
    expect(act({ type: 'extendDoc', end: false }, FROM)).toEqual({
      sel: sel(2000, 5, 0, 0),
      replay: false,
      restore: null,
    });
    expect(act({ type: 'extendDoc', end: true }, BACK).sel).toEqual(
      sel(4000, 7, 9000, 12),
    );
  });

  it('replays a Shift move on the window of the head, anchor unchanged', () => {
    expect(act({ type: 'extend', forward: true }, FROM)).toEqual({
      sel: FROM,
      replay: true,
      restore: null,
    });
  });

  it('collapses at the head on Escape', () => {
    expect(act({ type: 'simplify' }, FROM)).toEqual({
      sel: caret(4000, 7),
      replay: false,
      restore: null,
    });
    expect(act({ type: 'simplify' }, BACK).sel).toEqual(caret(2000, 5));
  });

  it('puts the caret at the head for a jump to a bracket and restores the selection when it finds none', () => {
    expect(act({ type: 'restore' }, FROM)).toEqual({
      sel: caret(4000, 7),
      replay: true,
      restore: FROM,
    });
  });

  it('knows which keys need the end of the file', () => {
    expect(needsEndPos({ type: 'line' })).toBe(true);
    expect(needsEndPos({ type: 'docEdge', end: true })).toBe(true);
    expect(needsEndPos({ type: 'extendDoc', end: true })).toBe(true);
    expect(needsEndPos({ type: 'docEdge', end: false })).toBe(false);
    expect(needsEndPos({ type: 'simplify' })).toBe(false);
  });

  describe('Select Line', () => {
    const text = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5'].join('\n');
    const state = (from: LinePos, to: LinePos): EditorState => {
      const base = EditorState.create({ doc: text });
      const pos = (p: LinePos): number =>
        base.doc.line(p.line + 1).from + p.col;
      return base.update({
        selection: EditorSelection.single(pos(from), pos(to)),
      }).state;
    };
    const cm = (from: LinePos, to: LinePos) => {
      let after = state(from, to);
      selectLine({
        state: after,
        dispatch: (tr) => {
          after = tr.state;
        },
      });
      const r = after.selection.main;
      const at = (p: number): LinePos => {
        const line = after.doc.lineAt(p);
        return { line: line.number - 1, col: p - line.from };
      };
      return { anchor: at(r.anchor), head: at(r.head), un: r.undirectional };
    };
    const end: LinePos = { line: 5, col: 2 };
    const mine = (from: LinePos, to: LinePos) =>
      globalSelectAction({ type: 'line' }, { anchor: from, head: to }, end).sel;

    it('selects the lines of the range, as CodeMirror does', () => {
      const cases: [LinePos, LinePos][] = [
        [
          { line: 1, col: 1 },
          { line: 3, col: 1 },
        ],
        [
          { line: 3, col: 1 },
          { line: 1, col: 1 },
        ],
        [
          { line: 2, col: 0 },
          { line: 2, col: 1 },
        ],
        [
          { line: 1, col: 0 },
          { line: 4, col: 2 },
        ],
        [
          { line: 2, col: 1 },
          { line: 5, col: 2 },
        ],
      ];
      for (const [from, to] of cases) {
        const want = cm(from, to);
        const got = mine(from, to);
        expect(got.anchor, JSON.stringify([from, to])).toEqual(want.anchor);
        expect(got.head, JSON.stringify([from, to])).toEqual(want.head);
        expect(got.undirectional).toBe(want.un);
      }
    });

    it('leaves out a last line the selection only reaches the start of', () => {
      const from = { line: 1, col: 1 };
      const to = { line: 4, col: 0 };
      const want = cm(from, to);
      expect(want.head).toEqual({ line: 4, col: 0 });
      expect(mine(from, to).head).toEqual(want.head);
      expect(mine(from, to).anchor).toEqual({ line: 1, col: 0 });
    });

    it('ends at the end of the file when the last line is the last of the file', () => {
      expect(mine({ line: 3, col: 1 }, { line: 5, col: 1 }).head).toEqual(end);
      expect(cm({ line: 3, col: 1 }, { line: 5, col: 1 }).head).toEqual(end);
    });

    it('marks the result undirectional', () => {
      expect(act({ type: 'line' }, sel(10, 3, 5000, 0)).sel.undirectional).toBe(
        true,
      );
    });

    it('turns toward Shift+Up, and again toward Shift+Down', () => {
      const lines = act({ type: 'line' }, sel(0, 0, 9000, 12)).sel;
      expect(lines).toEqual({
        anchor: { line: 0, col: 0 },
        head: { line: 9000, col: 12 },
        undirectional: true,
      });
      // Up: the head is after the anchor and the key goes back, so the ends swap.
      const up = act({ type: 'extend', forward: false }, lines);
      expect(up.sel.anchor).toEqual({ line: 9000, col: 12 });
      expect(up.sel.head).toEqual({ line: 0, col: 0 });
      expect(up.replay).toBe(true);
      // Down: the head is after the anchor and the key goes on, nothing swaps.
      const down = act({ type: 'extend', forward: true }, lines);
      expect(down.sel.anchor).toEqual({ line: 0, col: 0 });
      expect(down.sel.head).toEqual({ line: 9000, col: 12 });
    });

    it('turns a selection whose head lies before the anchor toward Shift+Down', () => {
      const back: LineSelection = {
        anchor: { line: 50, col: 0 },
        head: { line: 10, col: 0 },
        undirectional: true,
      };
      const down = act({ type: 'extend', forward: true }, back);
      expect(down.sel.anchor).toEqual({ line: 10, col: 0 });
      expect(down.sel.head).toEqual({ line: 50, col: 0 });
    });

    it('leaves a plain selection and a bracket extension unturned', () => {
      expect(act({ type: 'extend', forward: false }, FROM_PLAIN).sel).toEqual(
        FROM_PLAIN,
      );
      const lines: LineSelection = {
        anchor: { line: 0, col: 0 },
        head: { line: 100, col: 0 },
        undirectional: true,
      };
      expect(act({ type: 'extend', forward: null }, lines).sel).toBe(lines);
    });
  });

  describe('Shift+Up and Shift+Down after Select All and Select Line, against CodeMirror', () => {
    const text = ['l0', 'l1', 'l2', 'l3', 'l4'].join('\n');
    // CodeMirror's own selectLineUp and selectLineDown on a view that moves the
    // head to a fixed place: the anchor they keep is what is compared.
    const cmAnchor = (down: boolean, head: number): [number, number] => {
      let state = EditorState.create({
        doc: text,
        selection: EditorSelection.single(0, text.length),
      });
      selectLine({
        state,
        dispatch: (tr: Transaction) => {
          state = tr.state;
        },
      });
      const lines = state.selection.main;
      expect(lines.undirectional).toBe(true);
      const view = {
        get state() {
          return state;
        },
        dispatch: (tr: Transaction) => {
          state = tr.state;
        },
        moveVertically: () => EditorSelection.cursor(head),
      };
      (down ? selectLineDown : selectLineUp)(view as never);
      const range = state.selection.main;
      return [range.anchor, range.head];
    };
    const at = (state: EditorState, p: number): LinePos => {
      const line = state.doc.lineAt(p);
      return { line: line.number - 1, col: p - line.from };
    };
    const base = EditorState.create({ doc: text });
    const endOfDoc = at(base, base.doc.length);
    const lines = globalSelectAction(
      { type: 'line' },
      { anchor: { line: 0, col: 0 }, head: endOfDoc },
      endOfDoc,
    ).sel;

    it('keeps the anchor CodeMirror keeps going up', () => {
      const [anchor] = cmAnchor(false, 0);
      const mine = globalSelectAction(
        { type: 'extend', forward: false },
        lines,
        endOfDoc,
      );
      expect(mine.sel.anchor).toEqual(at(base, anchor));
      expect(mine.replay).toBe(true);
    });

    it('keeps the anchor CodeMirror keeps going down', () => {
      const [anchor] = cmAnchor(true, text.length);
      const mine = globalSelectAction(
        { type: 'extend', forward: true },
        lines,
        endOfDoc,
      );
      expect(mine.sel.anchor).toEqual(at(base, anchor));
    });
  });

  describe('against CodeMirror', () => {
    const text = 'abc\ndef\nghi\njkl';
    const run = (command: StateCommand, anchor: number, head: number) => {
      let state = EditorState.create({
        doc: text,
        selection: EditorSelection.single(anchor, head),
      });
      command({
        state,
        dispatch: (tr: Transaction) => {
          state = tr.state;
        },
      });
      return state.selection.main;
    };
    const at = (state: EditorState, p: number): LinePos => {
      const line = state.doc.lineAt(p);
      return { line: line.number - 1, col: p - line.from };
    };
    const base = EditorState.create({ doc: text });
    const pos = (p: LinePos): number => base.doc.line(p.line + 1).from + p.col;
    const endOfDoc = at(base, base.doc.length);

    it('puts the caret where the document-edge commands do', () => {
      const from = sel(0, 2, 3, 2);
      const mineStart = globalSelectAction(
        { type: 'docEdge', end: false },
        from,
        endOfDoc,
      );
      const cmStart = run(cursorDocStart, pos(from.anchor), pos(from.head));
      expect(pos(mineStart.sel.head)).toBe(cmStart.head);
      expect(pos(mineStart.sel.anchor)).toBe(cmStart.anchor);
      const mineEnd = globalSelectAction(
        { type: 'docEdge', end: true },
        from,
        endOfDoc,
      );
      const cmEnd = run(cursorDocEnd, pos(from.anchor), pos(from.head));
      expect(pos(mineEnd.sel.head)).toBe(cmEnd.head);
    });

    it('moves the head of a range the way the Shift document-edge commands do', () => {
      const from = sel(1, 1, 2, 2);
      const mine1 = globalSelectAction(
        { type: 'extendDoc', end: false },
        from,
        endOfDoc,
      );
      const cm1 = run(selectDocStart, pos(from.anchor), pos(from.head));
      expect([pos(mine1.sel.anchor), pos(mine1.sel.head)]).toEqual([
        cm1.anchor,
        cm1.head,
      ]);
      const mine2 = globalSelectAction(
        { type: 'extendDoc', end: true },
        from,
        endOfDoc,
      );
      const cm2 = run(selectDocEnd, pos(from.anchor), pos(from.head));
      expect([pos(mine2.sel.anchor), pos(mine2.sel.head)]).toEqual([
        cm2.anchor,
        cm2.head,
      ]);
    });

    it('collapses at the head the way Escape does', () => {
      for (const [a, h] of [
        [2, 11],
        [11, 2],
      ] as const) {
        const cmSel = run(simplifySelection, a, h);
        const from: LineSelection = {
          anchor: at(base, a),
          head: at(base, h),
        };
        const mine = globalSelectAction({ type: 'simplify' }, from, endOfDoc);
        expect(pos(mine.sel.head)).toBe(cmSel.head);
        expect(pos(mine.sel.anchor)).toBe(cmSel.anchor);
      }
    });
  });
});

const FROM_PLAIN = sel(2000, 5, 4000, 7);

describe('a queued clip paste', () => {
  const paste: RoutedItem = { kind: 'clipPaste' };
  const base = {
    commands: [] as Command[],
    panelOpen: false,
    own,
    headMapping: false,
    ready: false,
    totalLines: TOTAL,
  };

  it('is its own action whatever the selection, since what it holds is not known', () => {
    expect(actionFor(paste)).toEqual({ type: 'clipPaste' });
    expect(
      globalItemAction({
        item: paste,
        sel: SMALL,
        commands: [],
        panelOpen: false,
        own,
        totalLines: TOTAL,
      }),
    ).toEqual({ type: 'clipPaste' });
  });

  it('is a whole-file step, taken without the window holding the selection', () => {
    for (const sel of [LARGE, SMALL]) {
      const r = dequeueStep({
        ...base,
        sel,
        item: paste,
        swapping: false,
        holds: 0,
      });
      expect(r.step).toBe('global');
      expect(r.action).toEqual({ type: 'clipPaste' });
    }
  });

  it('waits for a swap or a hold, as a whole-file operation does', () => {
    expect(
      dequeueStep({
        ...base,
        sel: LARGE,
        item: paste,
        swapping: true,
        holds: 0,
      }).step,
    ).toBe('wait');
    expect(
      dequeueStep({
        ...base,
        sel: LARGE,
        item: paste,
        swapping: false,
        holds: 1,
      }).step,
    ).toBe('wait');
  });

  it('stops the shadow like a whole-file operation', () => {
    const r = shadowStep({ ...base, sel: LARGE, item: paste });
    expect(r.step).toBe('global');
    expect(r.action).toEqual({ type: 'clipPaste' });
  });

  it('has the read loop read the window again once it has run', () => {
    expect(afterShadowStop({ type: 'clipPaste' })).toBe('reread');
  });
});
