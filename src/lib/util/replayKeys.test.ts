// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import type { Command, KeyBinding } from '@codemirror/view';
import { toggleTabFocusMode } from '@codemirror/commands';
import { buildKeymap } from '../editor/keymap';
import {
  altGrText,
  chordReplaysAtEdge,
  commandChain,
  copiedRange,
  coreKeyBindings,
  decideKey,
  EDGE_COMMANDS,
  linewiseAfterCopy,
  drainStep,
  matchesBinding,
  needsCaret,
  parkedUndoKey,
  pasteSpec,
  pushSelect,
  replayStartAction,
  resumeAction,
  replayWanted,
  swapEndAction,
  type AltGrTable,
  type ReplayItemKind,
  type KeyLayers,
  type ReplayState,
} from './replayKeys';

interface Ev {
  key: string;
  code: string;
  keyCode: number;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
}

function ev(
  key: string,
  mods: Partial<Ev> & { keyCode?: number; code?: string } = {},
): Ev {
  return {
    key,
    code: '',
    keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    ...mods,
  };
}

const state = (over: Partial<ReplayState> = {}): ReplayState => ({
  locked: false,
  focusElsewhere: false,
  dropHold: false,
  queueHold: false,
  swapping: false,
  replayPending: false,
  outside: false,
  ...over,
});

describe('replayWanted', () => {
  it('wants input while the selection is outside the window', () => {
    expect(replayWanted(state({ outside: true }))).toBe(true);
  });

  it('does not want it for a selection inside the window', () => {
    expect(replayWanted(state())).toBe(false);
  });

  it('queues input typed while an undo or redo is under way, selection inside', () => {
    expect(replayWanted(state({ queueHold: true }))).toBe(true);
  });

  it('queues it in a swap the undo or redo caused, too', () => {
    expect(replayWanted(state({ queueHold: true, swapping: true }))).toBe(true);
  });

  it('drops input typed while a replace all pass runs', () => {
    expect(replayWanted(state({ dropHold: true, outside: true }))).toBe(false);
    expect(replayWanted(state({ dropHold: true, replayPending: true }))).toBe(
      false,
    );
  });

  it('refuses input during a swap that is not a replay', () => {
    expect(replayWanted(state({ swapping: true, outside: true }))).toBe(false);
  });

  it('keeps queueing during a replay swap', () => {
    expect(replayWanted(state({ swapping: true, replayPending: true }))).toBe(
      true,
    );
  });

  it('is off for a locked editor and for focus in another element', () => {
    expect(replayWanted(state({ locked: true, outside: true }))).toBe(false);
    expect(replayWanted(state({ focusElsewhere: true, outside: true }))).toBe(
      false,
    );
    expect(replayWanted(state({ focusElsewhere: true, queueHold: true }))).toBe(
      false,
    );
  });
});

describe('altGrText', () => {
  const german: AltGrTable = {
    KeyQ: { ctrl_alt: '@', ctrl_alt_shift: '' },
    KeyE: { ctrl_alt: '€', ctrl_alt_shift: '' },
  };
  const polish: AltGrTable = {
    KeyA: { ctrl_alt: 'ą', ctrl_alt_shift: 'Ą' },
  };
  const us: AltGrTable = {};

  it('types the character of German AltGr+Q', () => {
    const e = ev('@', { code: 'KeyQ', ctrlKey: true, altKey: true });
    expect(altGrText(e, true, german)).toBe('@');
  });

  it('keeps US Ctrl+Alt+F a shortcut', () => {
    const e = ev('f', { code: 'KeyF', ctrlKey: true, altKey: true });
    expect(altGrText(e, true, us)).toBeNull();
  });

  it('keeps US Ctrl+Alt+Shift+1 a shortcut: its key is the shifted base character', () => {
    const e = ev('!', {
      code: 'Digit1',
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
    });
    expect(altGrText(e, true, us)).toBeNull();
  });

  it('keeps Ctrl+Alt+Shift+F a shortcut', () => {
    const e = ev('F', {
      code: 'KeyF',
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
    });
    expect(altGrText(e, true, us)).toBeNull();
  });

  it('keeps Ctrl+Alt+Shift+2 a shortcut on a layout that types ² with AltGr alone', () => {
    const e = ev('"', {
      code: 'Digit2',
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
    });
    const table: AltGrTable = { Digit2: { ctrl_alt: '²', ctrl_alt_shift: '' } };
    expect(altGrText(e, true, table)).toBeNull();
  });

  it('types the Shift character of Polish AltGr+Shift+A', () => {
    const e = ev('Ą', {
      code: 'KeyA',
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
    });
    expect(altGrText(e, true, polish)).toBe('Ą');
  });

  it('keeps a Ctrl+Alt key whose character is not the layout one a shortcut', () => {
    const e = ev('q', { code: 'KeyQ', ctrlKey: true, altKey: true });
    expect(altGrText(e, true, german)).toBeNull();
  });

  it('is a shortcut without a table, off Windows, and without both modifiers', () => {
    const e = ev('@', { code: 'KeyQ', ctrlKey: true, altKey: true });
    expect(altGrText(e, true, null)).toBeNull();
    expect(altGrText(e, false, german)).toBeNull();
    expect(
      altGrText(ev('@', { code: 'KeyQ', altKey: true }), true, german),
    ).toBeNull();
    expect(
      altGrText(ev('@', { code: 'KeyQ', ctrlKey: true }), true, german),
    ).toBeNull();
  });
});
// The editor-scope defaults the tests need: id, macOS, Windows.
const DEFAULTS: [string, string, string][] = [
  ['editor.outdent', 'Cmd+[', 'Ctrl+['],
  ['editor.indent', 'Cmd+]', 'Ctrl+]'],
  ['editor.delete-line', 'Shift+Cmd+K', 'Ctrl+Shift+K'],
  ['editor.go-to-bracket', 'Shift+Cmd+\\', 'Ctrl+Shift+\\'],
  ['editor.toggle-tab-focus', 'Ctrl+Shift+M', 'Ctrl+M'],
];

const undo: Command = () => true;
const redo: Command = () => true;
const NEVER: ReadonlySet<Command> = new Set([toggleTabFocusMode, undo, redo]);

function layersFor(
  os: 'macos' | 'windows',
  overrides: Record<string, string | null> = {},
): KeyLayers {
  const accel = (id: string): string | null => {
    if (id in overrides) {
      return overrides[id] ?? null;
    }
    const row = DEFAULTS.find(([rowId]) => rowId === id);
    return row === undefined ? null : os === 'macos' ? row[1] : row[2];
  };
  const { normal, offscreen } = buildKeymap('windowed', os, accel);
  const core: KeyBinding[] = coreKeyBindings({
    closeBox: () => false,
    selectVisible: () => true,
    undo,
    redo,
  });
  return [offscreen, core, normal];
}

describe('chordReplaysAtEdge', () => {
  const mac = layersFor('macos');
  const replays = (
    layers: KeyLayers,
    e: Ev,
    os: 'macos' | 'windows' = 'macos',
  ): boolean => chordReplaysAtEdge(layers, e, os, NEVER);

  it('replays the macOS Emacs keys', () => {
    expect(
      replays(mac, ev('h', { keyCode: 72, ctrlKey: true, altKey: true })),
    ).toBe(true);
    expect(replays(mac, ev('v', { keyCode: 86, ctrlKey: true }))).toBe(true);
    expect(
      replays(mac, ev('N', { keyCode: 78, ctrlKey: true, shiftKey: true })),
    ).toBe(true);
  });

  it('reads Ctrl-Alt-h whatever character Option makes of it', () => {
    expect(
      replays(mac, ev('˙', { keyCode: 72, ctrlKey: true, altKey: true })),
    ).toBe(true);
  });

  it('replays Ctrl-n and Ctrl-p through the whole chain, Shift variants included', () => {
    // The off-screen move comes first and is not an edge command; the stock
    // move behind it is.
    const chain = commandChain(
      mac,
      ev('n', { keyCode: 78, ctrlKey: true }),
      'macos',
    );
    expect(chain.length).toBeGreaterThan(1);
    const [first] = chain;
    expect(first !== undefined && EDGE_COMMANDS.has(first)).toBe(false);
    expect(replays(mac, ev('n', { keyCode: 78, ctrlKey: true }))).toBe(true);
    expect(replays(mac, ev('p', { keyCode: 80, ctrlKey: true }))).toBe(true);
    expect(
      replays(mac, ev('N', { keyCode: 78, ctrlKey: true, shiftKey: true })),
    ).toBe(true);
    expect(
      replays(mac, ev('P', { keyCode: 80, ctrlKey: true, shiftKey: true })),
    ).toBe(true);
  });

  it('replays the indent keys and the bracket jumps where they are bound', () => {
    expect(replays(mac, ev('[', { keyCode: 219, metaKey: true }))).toBe(true);
    expect(replays(mac, ev(']', { keyCode: 221, metaKey: true }))).toBe(true);
    // Command+Shift+\ arrives as the shifted character.
    expect(
      replays(mac, ev('|', { keyCode: 220, metaKey: true, shiftKey: true })),
    ).toBe(true);
  });

  it('replays the key the outdent command is rebound to, and not the old one', () => {
    const rebound = layersFor('macos', { 'editor.outdent': 'Cmd+Alt+O' });
    expect(
      replays(rebound, ev('o', { keyCode: 79, metaKey: true, altKey: true })),
    ).toBe(true);
    expect(replays(rebound, ev('[', { keyCode: 219, metaKey: true }))).toBe(
      false,
    );
  });

  it('never replays the tab-focus toggle, on whichever key it is bound', () => {
    const swapped = layersFor('macos', {
      'editor.toggle-tab-focus': 'Cmd+[',
      'editor.outdent': 'Cmd+Alt+O',
    });
    expect(replays(swapped, ev('[', { keyCode: 219, metaKey: true }))).toBe(
      false,
    );
    const onEditingKey = layersFor('macos', {
      'editor.toggle-tab-focus': 'Cmd+ArrowLeft',
    });
    expect(
      replays(onEditingKey, ev('ArrowLeft', { keyCode: 37, metaKey: true })),
    ).toBe(false);
  });

  it('never replays undo or redo', () => {
    expect(replays(mac, ev('z', { keyCode: 90, metaKey: true }))).toBe(false);
    expect(
      replays(mac, ev('Z', { keyCode: 90, metaKey: true, shiftKey: true })),
    ).toBe(false);
    const win = layersFor('windows');
    expect(
      replays(win, ev('z', { keyCode: 90, ctrlKey: true }), 'windows'),
    ).toBe(false);
  });

  it('keeps replaying an editing key held with Ctrl or Meta', () => {
    expect(replays(mac, ev('ArrowLeft', { keyCode: 37, altKey: true }))).toBe(
      true,
    );
    expect(
      replays(
        layersFor('windows'),
        ev('Backspace', { keyCode: 8, ctrlKey: true }),
        'windows',
      ),
    ).toBe(true);
  });

  it('does not replay a key that runs no edge command', () => {
    expect(replays(mac, ev('s', { keyCode: 83, metaKey: true }))).toBe(false);
    expect(replays(mac, ev('l', { keyCode: 76, ctrlKey: true }))).toBe(false);
  });

  it('reads the keys of the platform it is asked about', () => {
    const win = layersFor('windows');
    expect(
      replays(win, ev('n', { keyCode: 78, ctrlKey: true }), 'windows'),
    ).toBe(false);
    expect(
      replays(
        win,
        ev('h', { keyCode: 72, ctrlKey: true, altKey: true }),
        'windows',
      ),
    ).toBe(false);
  });
});

describe('commandChain', () => {
  it('lists every binding a key falls through, highest precedence first', () => {
    const a: Command = () => false;
    const b: Command = () => false;
    const c: Command = () => false;
    const layers: KeyLayers = [
      [{ key: 'Ctrl-n', run: a }],
      [{ key: 'Ctrl-n', run: b, shift: c }],
    ];
    const plain = commandChain(layers, ev('n', { ctrlKey: true }), 'macos');
    expect(plain).toEqual([a, b]);
    const shifted = commandChain(
      layers,
      ev('N', { keyCode: 78, ctrlKey: true, shiftKey: true }),
      'macos',
    );
    expect(shifted).toEqual([c]);
  });

  it('reads Mod as Meta on macOS and Ctrl elsewhere', () => {
    const a: Command = () => false;
    const layers: KeyLayers = [[{ key: 'Mod-k', run: a }]];
    expect(commandChain(layers, ev('k', { metaKey: true }), 'macos')).toEqual([
      a,
    ]);
    expect(commandChain(layers, ev('k', { ctrlKey: true }), 'macos')).toEqual(
      [],
    );
    expect(commandChain(layers, ev('k', { ctrlKey: true }), 'windows')).toEqual(
      [a],
    );
  });

  it('skips the bindings of other scopes and of other platforms', () => {
    const a: Command = () => false;
    const layers: KeyLayers = [
      [
        { key: 'Ctrl-k', run: a, scope: 'editor search-panel' },
        { key: 'Ctrl-j', run: a, scope: 'search-panel' },
        { key: 'Ctrl-i', mac: 'Ctrl-o', run: a },
      ],
    ];
    expect(commandChain(layers, ev('k', { ctrlKey: true }), 'macos')).toEqual([
      a,
    ]);
    expect(commandChain(layers, ev('j', { ctrlKey: true }), 'macos')).toEqual(
      [],
    );
    expect(commandChain(layers, ev('o', { ctrlKey: true }), 'macos')).toEqual([
      a,
    ]);
    expect(commandChain(layers, ev('i', { ctrlKey: true }), 'macos')).toEqual(
      [],
    );
  });
});

describe('matchesBinding', () => {
  const win = layersFor('windows');

  it('matches the shortcuts the editor installs', () => {
    expect(
      matchesBinding(
        win,
        ev('K', { keyCode: 75, ctrlKey: true, shiftKey: true }),
        'windows',
      ),
    ).toBe(true);
    expect(
      matchesBinding(win, ev('a', { keyCode: 65, ctrlKey: true }), 'windows'),
    ).toBe(true);
    expect(
      matchesBinding(win, ev('z', { keyCode: 90, ctrlKey: true }), 'windows'),
    ).toBe(true);
  });

  it('does not match a menu accelerator', () => {
    expect(
      matchesBinding(win, ev('s', { keyCode: 83, ctrlKey: true }), 'windows'),
    ).toBe(false);
    expect(
      matchesBinding(
        layersFor('macos'),
        ev('s', { keyCode: 83, metaKey: true }),
        'macos',
      ),
    ).toBe(false);
  });
});

describe('decideKey', () => {
  const win = layersFor('windows');
  const mac = layersFor('macos');
  const decide = (
    event: Ev,
    over: Partial<ReplayState> = {},
    extra: {
      os?: string;
      draining?: boolean;
      altGr?: AltGrTable | null;
      layers?: KeyLayers;
    } = {},
  ) =>
    decideKey({
      event,
      os: extra.os ?? 'macos',
      state: state(over),
      draining: extra.draining ?? false,
      altGr: extra.altGr ?? null,
      layers: () => extra.layers ?? mac,
    });

  it('queues an ordinary key for the replay', () => {
    expect(decide(ev('a'), { outside: true })).toEqual({
      type: 'text',
      text: 'a',
    });
    expect(decide(ev('Enter'), { outside: true })).toEqual({ type: 'key' });
  });

  it('leaves an input method key to the component, outside the window too', () => {
    expect(decide(ev('Process', { keyCode: 229 }), { outside: true })).toEqual({
      type: 'none',
    });
  });

  it('leaves an input method key alone while the selection is inside the window', () => {
    expect(decide(ev('Process', { keyCode: 229 }))).toEqual({ type: 'none' });
  });

  it('queues a key typed while an undo runs, selection inside the window', () => {
    expect(decide(ev('a'), { queueHold: true })).toEqual({
      type: 'text',
      text: 'a',
    });
  });

  it('drops a key typed during a replace all pass', () => {
    expect(decide(ev('a'), { dropHold: true, outside: true })).toEqual({
      type: 'none',
    });
  });

  it('types an AltGr character that arrives while the replay is pending', () => {
    const german: AltGrTable = { KeyQ: { ctrl_alt: '@', ctrl_alt_shift: '' } };
    const e = ev('@', { code: 'KeyQ', ctrlKey: true, altKey: true });
    expect(
      decide(
        e,
        { outside: true, swapping: true, replayPending: true },
        { os: 'windows', altGr: german, layers: win },
      ),
    ).toEqual({ type: 'text', text: '@' });
    expect(
      decide(
        ev('f', { code: 'KeyF', ctrlKey: true, altKey: true }),
        { outside: true, swapping: true, replayPending: true },
        { os: 'windows', altGr: german, layers: win },
      ),
    ).toEqual({ type: 'none' });
  });

  it('leaves the first AltGr character to the input event', () => {
    const german: AltGrTable = { KeyQ: { ctrl_alt: '@', ctrl_alt_shift: '' } };
    const e = ev('@', { code: 'KeyQ', ctrlKey: true, altKey: true });
    expect(
      decide(
        e,
        { outside: true },
        { os: 'windows', altGr: german, layers: win },
      ),
    ).toEqual({ type: 'none' });
  });

  describe('a chord pressed while the queue drains', () => {
    const draining = { os: 'windows', draining: true, layers: win };
    const pending = { outside: true, replayPending: true };

    it('waits behind the queued items when the editor binds it', () => {
      const shiftK = ev('K', { keyCode: 75, ctrlKey: true, shiftKey: true });
      const selectAll = ev('a', { keyCode: 65, ctrlKey: true });
      const undoKey = ev('z', { keyCode: 90, ctrlKey: true });
      for (const e of [shiftK, selectAll, undoKey]) {
        expect(decide(e, pending, draining), e.key).toEqual({ type: 'key' });
      }
    });

    it('is left to the menu when it is an accelerator', () => {
      expect(
        decide(ev('s', { keyCode: 83, ctrlKey: true }), pending, draining),
      ).toEqual({ type: 'none' });
    });

    it('waits for an undo under way, another undo included', () => {
      const undoKey = ev('z', { keyCode: 90, ctrlKey: true });
      expect(
        decide(undoKey, { queueHold: true }, { ...draining, draining: false }),
      ).toEqual({ type: 'key' });
      expect(
        decide(
          ev('s', { keyCode: 83, ctrlKey: true }),
          { queueHold: true },
          { ...draining, draining: false },
        ),
      ).toEqual({ type: 'none' });
    });

    it('is left alone when nothing drains', () => {
      expect(
        decide(
          ev('K', { keyCode: 75, ctrlKey: true, shiftKey: true }),
          pending,
          { ...draining, draining: false },
        ),
      ).toEqual({ type: 'none' });
    });
  });
});

describe('copiedRange', () => {
  const doc = 'one\ntwo\nthree';
  const at = (pos: number | number[]): EditorState =>
    EditorState.create({
      doc,
      extensions: [EditorState.allowMultipleSelections.of(true)],
      selection: EditorSelection.create(
        (Array.isArray(pos) ? pos : [pos]).map((p) =>
          EditorSelection.cursor(p),
        ),
      ),
    });

  it('copies the caret line without its break and cuts it with the break', () => {
    const copied = copiedRange(at(5));
    expect(copied.text).toBe('two');
    expect(copied.linewise).toBe(true);
    expect(copied.ranges).toEqual([{ from: 4, to: 8 }]);
  });

  it('cuts a last line without a break to the end, keeping the break before it', () => {
    const copied = copiedRange(at(10));
    expect(copied.text).toBe('three');
    expect(copied.ranges).toEqual([{ from: 8, to: 13 }]);
    const cut = at(10).update({ changes: copied.ranges }).state;
    expect(cut.doc.toString()).toBe('one\ntwo\n');
  });

  it('takes each caret line once', () => {
    const copied = copiedRange(at([1, 2, 5]));
    expect(copied.text).toBe('one\ntwo');
    expect(copied.ranges).toEqual([
      { from: 0, to: 4 },
      { from: 4, to: 8 },
    ]);
  });

  it('copies the selection, not the line, when something is selected', () => {
    const state = EditorState.create({
      doc,
      selection: EditorSelection.single(1, 6),
    });
    const copied = copiedRange(state);
    expect(copied.text).toBe('ne\ntw');
    expect(copied.linewise).toBe(false);
    expect(linewiseAfterCopy(copied)).toBeNull();
  });

  it('remembers the line text of an empty-caret copy only', () => {
    expect(linewiseAfterCopy(copiedRange(at(5)))).toBe('two');
  });
});

describe('pasteSpec', () => {
  const caretAt = (doc: string, pos: number): EditorState =>
    EditorState.create({ doc, selection: EditorSelection.cursor(pos) });
  const apply = (s: EditorState, spec: ReturnType<typeof pasteSpec>): string =>
    s.update(spec).state.doc.toString();

  it('inserts the remembered line above the caret line', () => {
    const s = caretAt('one\ntwo\nthree', 9);
    expect(apply(s, pasteSpec(s, 'two', 'two'))).toBe('one\ntwo\ntwo\nthree');
  });

  it('puts the caret after the inserted line, on the same text', () => {
    const s = caretAt('one\ntwo', 5);
    const next = s.update(pasteSpec(s, 'x', 'x')).state;
    expect(next.doc.toString()).toBe('one\nx\ntwo');
    expect(next.selection.main.head).toBe(7);
  });

  it('matches an in-window copy and paste of the same state', () => {
    // Copy the caret line, then paste it with the caret on another line.
    const copy = caretAt('one\ntwo\nthree', 5);
    const copied = copiedRange(copy);
    const remembered = linewiseAfterCopy(copied);
    const target = caretAt('one\ntwo\nthree', 9);
    expect(apply(target, pasteSpec(target, copied.text, remembered))).toBe(
      'one\ntwo\ntwo\nthree',
    );
  });

  it('inserts the text at the caret when it is not the remembered one', () => {
    const s = caretAt('one\ntwo', 2);
    expect(apply(s, pasteSpec(s, 'XY', 'two'))).toBe('onXYe\ntwo');
  });

  it('inserts the text at the caret when the last copy was not line-wise', () => {
    const s = caretAt('one\ntwo', 2);
    expect(apply(s, pasteSpec(s, 'two', null))).toBe('ontwoe\ntwo');
  });

  it('replaces a selection even when the text is the remembered one', () => {
    const s = EditorState.create({
      doc: 'one\ntwo',
      selection: EditorSelection.single(0, 3),
    });
    expect(apply(s, pasteSpec(s, 'two', 'two'))).toBe('two\ntwo');
  });
});

describe('replayStartAction', () => {
  const idle = {
    gone: false,
    locked: false,
    swapping: false,
    capturing: false,
    composing: false,
    holds: 0,
  };
  it('swaps back to the selection when nothing holds the view', () => {
    expect(replayStartAction(idle)).toBe('swap');
  });
  it('waits for a window swap that is already running, keeping the queue', () => {
    expect(replayStartAction({ ...idle, swapping: true })).toBe('wait');
  });
  it('swaps while a capture runs: the queue drains in a shadow meanwhile', () => {
    expect(replayStartAction({ ...idle, capturing: true })).toBe('swap');
    expect(
      replayStartAction({ ...idle, capturing: true, composing: true }),
    ).toBe('swap');
  });
  it('waits for a composition that no capture covers', () => {
    expect(replayStartAction({ ...idle, composing: true })).toBe('wait');
  });
  it('waits for an undo or redo even with a capture running', () => {
    expect(replayStartAction({ ...idle, capturing: true, holds: 1 })).toBe(
      'wait',
    );
    expect(
      replayStartAction({ ...idle, capturing: true, swapping: true }),
    ).toBe('wait');
  });
  it('waits for an undo or redo', () => {
    expect(replayStartAction({ ...idle, holds: 1 })).toBe('wait');
  });
  it('drops the queue when the editor is locked or gone', () => {
    expect(replayStartAction({ ...idle, locked: true })).toBe('drop');
    expect(replayStartAction({ ...idle, gone: true })).toBe('drop');
    expect(replayStartAction({ ...idle, locked: true, swapping: true })).toBe(
      'drop',
    );
  });
});

describe('swapEndAction', () => {
  it('does nothing when nothing is queued', () => {
    expect(
      swapEndAction({
        replayPending: false,
        replaySwap: false,
        capturing: false,
      }),
    ).toBe('none');
  });
  it('waits for a captured composition, whose end carries on', () => {
    expect(
      swapEndAction({ replayPending: true, replaySwap: true, capturing: true }),
    ).toBe('none');
    expect(
      swapEndAction({
        replayPending: true,
        replaySwap: false,
        capturing: true,
      }),
    ).toBe('none');
  });
  it('drains after the swap that brought the window back to the selection', () => {
    expect(
      swapEndAction({
        replayPending: true,
        replaySwap: true,
        capturing: false,
      }),
    ).toBe('drain');
  });
  it('resumes after another swap, which may have left the selection outside', () => {
    expect(
      swapEndAction({
        replayPending: true,
        replaySwap: false,
        capturing: false,
      }),
    ).toBe('resume');
  });
});

describe('needsCaret', () => {
  it('is true for the items that act at the caret', () => {
    for (const kind of ['text', 'key', 'copy', 'cut'] as const) {
      expect(needsCaret(kind)).toBe(true);
    }
  });
  it('is false for a pointer selection, an undo, a redo and a slot', () => {
    for (const kind of ['select', 'undo', 'redo', 'slot'] as const) {
      expect(needsCaret(kind)).toBe(false);
    }
  });
});

describe('drainStep', () => {
  const at = (
    head: ReplayItemKind | null,
    over: Partial<Parameters<typeof drainStep>[0]> = {},
  ) =>
    drainStep({
      swapping: false,
      holds: 0,
      head,
      headMapping: false,
      ready: true,
      ...over,
    });
  it('runs a caret item when the window holds the selection', () => {
    for (const kind of ['text', 'key', 'copy', 'cut'] as const) {
      expect(at(kind)).toBe('run');
    }
  });
  it('stops for a swap when a caret item finds the selection outside', () => {
    expect(at('text', { ready: false })).toBe('swap');
    expect(at('cut', { ready: false })).toBe('swap');
  });
  it('runs a pointer selection, an undo and a redo wherever the window is', () => {
    expect(at('select', { ready: false })).toBe('select');
    expect(at('undo', { ready: false })).toBe('undo');
    expect(at('redo', { ready: false })).toBe('undo');
  });
  it('waits for a pointer selection whose mapping is under way', () => {
    expect(at('select', { headMapping: true })).toBe('map');
  });
  it('waits at a slot, for a swap and for an undo or redo in flight', () => {
    expect(at('slot')).toBe('wait');
    expect(at('text', { swapping: true })).toBe('wait');
    expect(at('select', { holds: 1 })).toBe('wait');
    expect(at(null, { swapping: true, ready: false })).toBe('wait');
  });
  it('ends with the queue empty, or swaps to reveal an outside selection', () => {
    expect(at(null)).toBe('done');
    expect(at(null, { ready: false })).toBe('swap');
  });
});

describe('resumeAction', () => {
  it('swaps when an item that needs the caret finds the selection outside', () => {
    expect(resumeAction('text', false)).toBe('swap');
    expect(resumeAction('key', false)).toBe('swap');
    expect(resumeAction('text', true)).toBe('drain');
  });
  it('drains at once for an undo, a redo, a pointer selection and a slot', () => {
    for (const kind of ['undo', 'redo', 'select', 'slot'] as const) {
      expect(resumeAction(kind, false)).toBe('drain');
    }
  });
  it('swaps for an empty queue only to bring an outside selection into view', () => {
    expect(resumeAction(null, false)).toBe('swap');
    expect(resumeAction(null, true)).toBe('drain');
  });
});

describe('pushSelect', () => {
  const sel = (n: number) => ({ kind: 'select', n });
  it('replaces a pointer selection directly behind another (a drag)', () => {
    const q: { kind: string; n?: number }[] = [{ kind: 'text' }, sel(1)];
    pushSelect(q, sel(2));
    expect(q).toEqual([{ kind: 'text' }, sel(2)]);
  });
  it('does not replace across a slot or another item', () => {
    const q: { kind: string; n?: number }[] = [sel(1), { kind: 'slot' }];
    pushSelect(q, sel(2));
    expect(q).toEqual([sel(1), { kind: 'slot' }, sel(2)]);
    pushSelect(q, sel(3));
    expect(q).toEqual([sel(1), { kind: 'slot' }, sel(3)]);
    q.push({ kind: 'undo' });
    pushSelect(q, sel(4));
    expect(q.map((i) => i.kind)).toEqual([
      'select',
      'slot',
      'select',
      'undo',
      'select',
    ]);
  });
  it('queues the first pointer selection', () => {
    const q: { kind: string }[] = [];
    pushSelect(q, sel(1));
    expect(q).toHaveLength(1);
  });
});

describe('parkedUndoKey', () => {
  const undo: Command = () => true;
  const redo: Command = () => true;
  const bindings = coreKeyBindings({
    closeBox: () => true,
    selectVisible: () => true,
    undo,
    redo,
  });
  const key = (e: Ev, os: string) => parkedUndoKey(bindings, e, os, undo, redo);
  it('turns Ctrl+Z and Ctrl+Shift+Z on Windows into an undo and a redo', () => {
    expect(key(ev('z', { keyCode: 90, ctrlKey: true }), 'windows')).toBe(
      'undo',
    );
    expect(
      key(ev('Z', { keyCode: 90, ctrlKey: true, shiftKey: true }), 'windows'),
    ).toBe('redo');
  });
  it('does the same for the command keys on macOS', () => {
    expect(key(ev('z', { keyCode: 90, metaKey: true }), 'macos')).toBe('undo');
    expect(
      key(ev('Z', { keyCode: 90, metaKey: true, shiftKey: true }), 'macos'),
    ).toBe('redo');
  });
  it('leaves Ctrl+Y and every other chord to the decision it had', () => {
    expect(key(ev('y', { keyCode: 89, ctrlKey: true }), 'windows')).toBeNull();
    expect(key(ev('s', { keyCode: 83, ctrlKey: true }), 'windows')).toBeNull();
    expect(key(ev('z', { keyCode: 90 }), 'windows')).toBeNull();
    expect(key(ev('a', { keyCode: 65, ctrlKey: true }), 'windows')).toBeNull();
  });
});
