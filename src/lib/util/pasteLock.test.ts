// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, redo, undo } from '@codemirror/commands';
import { PasteLocks, editableWith, pasteLockOwner } from './pasteLock';
/** A state with the lock on, after one typed edit that history can undo; the
 *  lock goes in through the compartment the editors use. */
function locked(phase: 'wait' | 'full', editable = true) {
  const locks = new PasteLocks();
  const compartment = new Compartment();
  let state = EditorState.create({
    doc: 'abc',
    extensions: [history(), compartment.of(editableWith(editable, undefined))],
  });
  state = state.update({
    changes: { from: 3, insert: 'd' },
    userEvent: 'input.type',
  }).state;
  const lock = locks.begin('tab', phase);
  state = state.update({
    effects: compartment.reconfigure(editableWith(editable, lock)),
  }).state;
  return { state, lock, locks };
}
const run = (
  state: EditorState,
  command: (target: {
    state: EditorState;
    dispatch: (tr: ReturnType<EditorState['update']>) => void;
  }) => boolean,
): EditorState => {
  let current = state;
  command({
    state,
    dispatch: (tr) => {
      current = tr.state;
    },
  });
  return current;
};

describe('editableWith', () => {
  it('is editable as the editor says when nothing locks the tab', () => {
    const on = EditorState.create({
      extensions: editableWith(true, undefined),
    });
    const off = EditorState.create({
      extensions: editableWith(false, undefined),
    });
    expect(on.facet(EditorView.editable)).toBe(true);
    expect(off.facet(EditorView.editable)).toBe(false);
    expect(on.readOnly).toBe(false);
  });

  it('keeps the editor editable while the paste waits, but read-only', () => {
    const { state } = locked('wait');
    expect(state.facet(EditorView.editable)).toBe(true);
    expect(state.readOnly).toBe(true);
  });

  it('refuses a document change sent straight in while the paste waits', () => {
    const { state } = locked('wait');
    const next = state.update({ changes: { from: 0, insert: 'X' } }).state;
    expect(next.doc.toString()).toBe('abcd');
  });

  it('lets a selection through while the paste waits', () => {
    const { state } = locked('wait');
    const next = state.update({ selection: { anchor: 2 } }).state;
    expect(next.selection.main.head).toBe(2);
  });

  it('takes the change of the paste that owns the lock, as one undo step', () => {
    const { state, lock } = locked('wait');
    const next = state.update({
      changes: { from: 0, insert: 'XY' },
      annotations: pasteLockOwner.of(lock.id),
    }).state;
    expect(next.doc.toString()).toBe('XYabcd');
  });

  it('refuses the change of a paste that does not own the lock', () => {
    const { state, lock } = locked('wait');
    const next = state.update({
      changes: { from: 0, insert: 'XY' },
      annotations: pasteLockOwner.of(lock.id + 1),
    }).state;
    expect(next.doc.toString()).toBe('abcd');
  });

  it('makes the editor not editable once a dialog has the tab', () => {
    const { state } = locked('full');
    expect(state.facet(EditorView.editable)).toBe(false);
    expect(state.readOnly).toBe(true);
  });

  it('is not editable while hidden, even with the wait lock', () => {
    const { state } = locked('wait', false);
    expect(state.facet(EditorView.editable)).toBe(false);
  });

  it('changes nothing for undo and redo', () => {
    const { state } = locked('wait');
    expect(run(state, undo).doc.toString()).toBe('abcd');
    expect(run(state, redo).doc.toString()).toBe('abcd');
  });
});

describe('PasteLocks', () => {
  it('begins, upgrades and ends the lock of a tab', () => {
    const locks = new PasteLocks();
    expect(locks.any()).toBe(false);
    const a = locks.begin('t1', 'wait');
    expect(locks.has('t1')).toBe(true);
    expect(locks.any()).toBe(true);
    expect(locks.upgrade('t1', a.id)?.phase).toBe('full');
    expect(locks.get('t1')?.phase).toBe('full');
    expect(locks.end('t1', a.id)).toBe(true);
    expect(locks.has('t1')).toBe(false);
  });

  it('keeps a lock apart per tab', () => {
    const locks = new PasteLocks();
    const a = locks.begin('t1', 'wait');
    locks.begin('t2', 'wait');
    locks.end('t1', a.id);
    expect(locks.has('t1')).toBe(false);
    expect(locks.has('t2')).toBe(true);
  });

  it('ignores an end or upgrade by a lock that is not the tab’s any more', () => {
    const locks = new PasteLocks();
    const a = locks.begin('t1', 'wait');
    locks.end('t1', a.id);
    const b = locks.begin('t1', 'wait');
    expect(locks.end('t1', a.id)).toBe(false);
    expect(locks.upgrade('t1', a.id)).toBeNull();
    expect(locks.get('t1')?.id).toBe(b.id);
  });

  it('forgets the lock of a closed tab', () => {
    const locks = new PasteLocks();
    locks.begin('t1', 'full');
    locks.drop('t1');
    expect(locks.any()).toBe(false);
  });
});
