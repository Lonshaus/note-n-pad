// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  ChangeSet,
  EditorSelection,
  EditorState,
  type Transaction,
} from '@codemirror/state';
import {
  accumulate,
  capturedInput,
  captureStartAllowed,
  finishCapture,
  imeKeyAction,
  outsideInputAction,
  selectQueued,
  startCapture,
  toCaptureStart,
  updateActions,
} from './imeCapture';
// Runs a composition through states the way the editor does: each step is one
// transaction at the window edge, folded into the capture.
function compose(
  doc: string,
  steps: { from: number; to: number; insert: string }[],
  selection = EditorSelection.single(0),
): {
  start: EditorState;
  end: EditorState;
  capture: ReturnType<typeof startCapture>;
} {
  const start = EditorState.create({ doc, selection });
  let state = start;
  let capture = startCapture(state.doc.length);
  for (const step of steps) {
    const tr: Transaction = state.update({
      changes: step,
      userEvent: 'input.type.compose',
    });
    capture = accumulate(capture, tr.changes);
    state = tr.state;
  }
  return { start, end: state, capture };
}

describe('finishCapture', () => {
  it('commits the final text of a composition of several changes', () => {
    const { start, end, capture } = compose('abc\ndef', [
      { from: 0, to: 0, insert: 'n' },
      { from: 0, to: 1, insert: 'に' },
      { from: 0, to: 1, insert: 'にほ' },
      { from: 0, to: 2, insert: 'にほん' },
    ]);
    const done = finishCapture(start.doc, capture.changes);
    expect(done.committed).toBe('にほん');
    expect(end.doc.toString()).toBe('にほんabc\ndef');
    expect(end.update({ changes: done.revert }).state.doc.toString()).toBe(
      'abc\ndef',
    );
  });

  it('reverts a composition that replaced a selection', () => {
    const { start, end, capture } = compose(
      'abc\ndef',
      [{ from: 0, to: 3, insert: 'あ' }],
      EditorSelection.single(0, 3),
    );
    const done = finishCapture(start.doc, capture.changes);
    expect(done.committed).toBe('あ');
    expect(end.doc.toString()).toBe('あ\ndef');
    expect(end.update({ changes: done.revert }).state.doc.toString()).toBe(
      'abc\ndef',
    );
  });

  it('has nothing to commit or revert when Esc cancels the composition', () => {
    const { start, capture } = compose('abc', [
      { from: 0, to: 0, insert: 'n' },
      { from: 0, to: 1, insert: 'に' },
      { from: 0, to: 1, insert: '' },
    ]);
    const done = finishCapture(start.doc, capture.changes);
    expect(done.committed).toBe('');
    expect(done.revert.empty).toBe(true);
  });

  it('has nothing to commit before any change came', () => {
    const start = EditorState.create({ doc: 'abc' });
    const done = finishCapture(start.doc, startCapture(3).changes);
    expect(done.committed).toBe('');
    expect(done.revert.empty).toBe(true);
  });

  it('commits a full-width space composed with an empty preedit', () => {
    const { start, capture } = compose('abc', [
      { from: 0, to: 0, insert: '　' },
    ]);
    expect(finishCapture(start.doc, capture.changes).committed).toBe('　');
  });

  it('commits the text at the far end of the window as well', () => {
    const { start, end, capture } = compose(
      'abc\ndef',
      [{ from: 7, to: 7, insert: 'ん' }],
      EditorSelection.single(7),
    );
    const done = finishCapture(start.doc, capture.changes);
    expect(done.committed).toBe('ん');
    expect(end.update({ changes: done.revert }).state.doc.toString()).toBe(
      'abc\ndef',
    );
  });
});

describe('accumulate', () => {
  it('composes the changes into one set over the starting document', () => {
    const { capture } = compose('abc', [
      { from: 0, to: 0, insert: 'xy' },
      { from: 2, to: 2, insert: 'z' },
    ]);
    expect(capture.changes.length).toBe(3);
    expect(capture.changes.newLength).toBe(6);
  });
});

describe('imeKeyAction', () => {
  const cases: [string, Parameters<typeof imeKeyAction>[0], string][] = [
    [
      'input method key outside the window',
      { ime: true, wanted: true, capturing: false },
      'mark',
    ],
    [
      'input method key while composing',
      { ime: true, wanted: true, capturing: true },
      'keep',
    ],
    [
      'input method key while composing, view not wanted',
      { ime: true, wanted: false, capturing: true },
      'keep',
    ],
    [
      'input method key inside the window',
      { ime: true, wanted: false, capturing: false },
      'clear',
    ],
    [
      'ordinary key outside the window',
      { ime: false, wanted: true, capturing: false },
      'clear',
    ],
    [
      'ordinary key while composing',
      { ime: false, wanted: true, capturing: true },
      'clear',
    ],
    [
      'ordinary key inside the window',
      { ime: false, wanted: false, capturing: false },
      'clear',
    ],
  ];
  for (const [name, input, expected] of cases) {
    it(`${name} is '${expected}'`, () => {
      expect(imeKeyAction(input)).toBe(expected);
    });
  }
});

describe('outsideInputAction', () => {
  const base = { capturing: false, pending: false, late: false };
  const cases: [string, Parameters<typeof outsideInputAction>[0], string][] = [
    [
      'composition text during a capture',
      { ...base, capturing: true, userEvent: 'input.type.compose' },
      'capture',
    ],
    [
      'first composition text during a capture',
      { ...base, capturing: true, userEvent: 'input.type.compose.start' },
      'capture',
    ],
    [
      'plain text during a capture',
      { ...base, capturing: true, userEvent: 'input.type' },
      'capture',
    ],
    [
      'the composition start deletion during a capture',
      { ...base, capturing: true, userEvent: 'input' },
      'capture',
    ],
    [
      'a paste during a capture',
      { ...base, capturing: true, userEvent: 'input.paste' },
      'reject',
    ],
    [
      'a deletion during a capture',
      { ...base, capturing: true, userEvent: 'delete.backward' },
      'reject',
    ],
    [
      'plain text after an input method key',
      { ...base, pending: true, userEvent: 'input.type' },
      'queue',
    ],
    [
      'plain text with no input method key',
      { ...base, userEvent: 'input.type' },
      'queue',
    ],
    [
      'plain text just after a capture ended',
      { ...base, late: true, userEvent: 'input.type' },
      'queue',
    ],
    [
      'labelled composition text after an input method key',
      { ...base, pending: true, userEvent: 'input.type.compose' },
      'queue',
    ],
    [
      'labelled composition text just after a capture ended',
      { ...base, late: true, userEvent: 'input.type.compose' },
      'queue',
    ],
    [
      'first labelled composition text just after a capture ended',
      { ...base, late: true, userEvent: 'input.type.compose.start' },
      'queue',
    ],
    [
      'labelled composition text no capture covers',
      { ...base, userEvent: 'input.type.compose' },
      'reject',
    ],
    [
      'a paste with no capture',
      { ...base, userEvent: 'input.paste' },
      'reject',
    ],
    [
      'a deletion after an input method key',
      { ...base, pending: true, userEvent: 'delete.backward' },
      'reject',
    ],
    [
      'an edit with no user event',
      { ...base, pending: true, late: true, userEvent: undefined },
      'reject',
    ],
  ];
  for (const [name, input, expected] of cases) {
    it(`${name} is '${expected}'`, () => {
      expect(outsideInputAction(input)).toBe(expected);
    });
  }
});

describe('updateActions', () => {
  const idle = {
    docChanged: false,
    selectionSet: false,
    swapping: false,
    applyingRemote: false,
    capturing: false,
  };
  it('keeps a capture out of the core and out of the global selection', () => {
    expect(
      updateActions({ ...idle, docChanged: true, capturing: true }),
    ).toEqual({ accumulate: true, edit: false, track: false });
  });
  it('does not track a selection change made during a capture', () => {
    expect(
      updateActions({ ...idle, selectionSet: true, capturing: true }),
    ).toEqual({ accumulate: false, edit: false, track: false });
  });
  it('treats an ordinary edit as an edit and tracks it', () => {
    expect(updateActions({ ...idle, docChanged: true })).toEqual({
      accumulate: false,
      edit: true,
      track: true,
    });
  });
  it('tracks a selection change outside a capture', () => {
    expect(updateActions({ ...idle, selectionSet: true })).toEqual({
      accumulate: false,
      edit: false,
      track: true,
    });
  });
  it('ignores a swap', () => {
    expect(
      updateActions({ ...idle, docChanged: true, swapping: true }),
    ).toEqual({ accumulate: false, edit: false, track: false });
  });
  it('tracks but does not send a change mirrored from the core', () => {
    expect(
      updateActions({ ...idle, docChanged: true, applyingRemote: true }),
    ).toEqual({ accumulate: false, edit: false, track: true });
  });
});

describe('captureStartAllowed', () => {
  const ready = {
    capturing: false,
    locked: false,
    swapping: false,
    replaySwap: false,
    draining: false,
    holds: 0,
    wanted: true,
    outside: true,
    selectAllPending: false,
  };
  it('captures a composition that starts with the caret outside', () => {
    expect(captureStartAllowed(ready)).toBe(true);
  });
  it('captures a composition that starts while the window swaps back to the caret', () => {
    expect(
      captureStartAllowed({ ...ready, swapping: true, replaySwap: true }),
    ).toBe(true);
    expect(
      captureStartAllowed({
        ...ready,
        swapping: true,
        replaySwap: true,
        outside: false,
      }),
    ).toBe(true);
  });
  const blockedInReplaySwap: [string, Partial<typeof ready>][] = [
    ['one is already running', { capturing: true }],
    ['the editor is locked', { locked: true }],
    ['the queue is being replayed', { draining: true }],
    ['an undo or redo runs', { holds: 1 }],
    ['the replay does not want the input', { wanted: false }],
    ['a select all waits to run', { selectAllPending: true }],
  ];
  for (const [name, over] of blockedInReplaySwap) {
    it(`does not capture during the swap back when ${name}`, () => {
      expect(
        captureStartAllowed({
          ...ready,
          swapping: true,
          replaySwap: true,
          ...over,
        }),
      ).toBe(false);
    });
  }
  const blocked: [string, Partial<typeof ready>][] = [
    ['one is already running', { capturing: true }],
    ['the editor is locked', { locked: true }],
    ['a swap is running', { swapping: true }],
    ['the queue is being replayed', { draining: true }],
    ['an undo or redo runs', { holds: 1 }],
    ['the replay does not want the input', { wanted: false }],
    ['the caret is inside the window', { outside: false }],
    ['a select all waits to run', { selectAllPending: true }],
  ];
  for (const [name, over] of blocked) {
    it(`does not capture when ${name}`, () => {
      expect(captureStartAllowed({ ...ready, ...over })).toBe(false);
    });
  }
});

describe('selectQueued', () => {
  it('queues a pointer selection while input is pending or a composition is open', () => {
    expect(
      selectQueued({ pointer: true, replayPending: true, capturing: false }),
    ).toBe(true);
    expect(
      selectQueued({ pointer: true, replayPending: false, capturing: true }),
    ).toBe(true);
  });
  it('does not queue it when nothing is pending, or for any other selection', () => {
    expect(
      selectQueued({ pointer: true, replayPending: false, capturing: false }),
    ).toBe(false);
    expect(
      selectQueued({ pointer: false, replayPending: true, capturing: true }),
    ).toBe(false);
  });
});

describe('toCaptureStart', () => {
  // The composition replaced "ab" at 3..5 of "012ab56" with "にほん".
  const start = EditorState.create({ doc: '012ab56' }).doc;
  const changes = ChangeSet.of({ from: 3, to: 5, insert: 'にほん' }, 7);
  it('keeps a position before the composition', () => {
    expect(toCaptureStart(changes, start, 2)).toBe(2);
  });
  it('shifts a position after it back by the length it added', () => {
    // "012にほん56": the 5 sits at 6 in the composed document, 5 in the start.
    expect(toCaptureStart(changes, start, 6)).toBe(5);
    expect(toCaptureStart(changes, start, 7)).toBe(6);
  });
  it('puts a position inside the composition where it began', () => {
    expect(toCaptureStart(changes, start, 3)).toBe(3);
    expect(toCaptureStart(changes, start, 4)).toBe(3);
    expect(toCaptureStart(changes, start, 5)).toBe(3);
  });
  it('is the identity when the composition changed nothing', () => {
    expect(toCaptureStart(ChangeSet.empty(7), start, 4)).toBe(4);
  });
});

describe('the shadow leaves the capture and late-input rules as they were', () => {
  // The shadow never sets `draining` and never takes a hold, so the editor
  // looks during it as it does during the swap back to the caret.
  const duringShadow = {
    capturing: false,
    locked: false,
    swapping: true,
    replaySwap: true,
    draining: false,
    holds: 0,
    wanted: true,
    outside: false,
    selectAllPending: false,
  };
  it('captures the next composition of the run', () => {
    expect(captureStartAllowed(duringShadow)).toBe(true);
  });
  it('is stopped by the flags the shadow must not set', () => {
    expect(captureStartAllowed({ ...duringShadow, draining: true })).toBe(
      false,
    );
    expect(captureStartAllowed({ ...duringShadow, holds: 1 })).toBe(false);
  });
  it('queues the last text of a composition that just ended', () => {
    expect(
      outsideInputAction({
        capturing: false,
        pending: false,
        late: true,
        userEvent: 'input.type.compose',
      }),
    ).toBe('queue');
  });
});

describe('capturedInput', () => {
  it('is the typing and composition input of a running capture', () => {
    expect(capturedInput(true, 'input.type')).toBe(true);
    expect(capturedInput(true, 'input.type.compose')).toBe(true);
    expect(capturedInput(true, 'input')).toBe(true);
  });
  it('is nothing without a capture', () => {
    expect(capturedInput(false, 'input.type.compose')).toBe(false);
  });
  it('is no deletion, paste or untagged change', () => {
    expect(capturedInput(true, 'delete.line')).toBe(false);
    expect(capturedInput(true, 'input.paste')).toBe(false);
    expect(capturedInput(true, undefined)).toBe(false);
  });
});
