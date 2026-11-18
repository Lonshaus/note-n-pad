// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// What an editor keeps of a tab besides its text, carried to another window:
// the selection, the undo history and the scroll position.

import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import {
  editorPayload,
  scrollRecord,
  scrollRecordOf,
  scrollTargetTop,
  seededState,
} from './editorSeed';
import { textFromString } from '../util/text';
/** A state with history over `doc`, to which the edits are applied one by one,
 *  far enough apart in time that each is an undo step of its own. */
function edited(doc: string, edits: { from: number; insert: string }[]) {
  let state = EditorState.create({ doc, extensions: [history()] });
  edits.forEach((edit, i) => {
    state = state.update({
      changes: edit,
      annotations: Transaction.time.of(i * 10_000),
    }).state;
  });
  return state;
}
/** The state after one `undo`. */
function undone(state: EditorState): EditorState {
  let next = state;
  undo({
    state,
    dispatch: (tr) => {
      next = tr.state;
    },
  });
  return next;
}

describe('the editor state of a tab on its way', () => {
  it('keeps the history, the selection and the document', () => {
    const state = edited('abc', [
      { from: 0, insert: '1' },
      { from: 4, insert: '2' },
    ]);
    const selected = state.update({
      selection: EditorSelection.single(1, 3),
    }).state;
    expect(selected.doc.toString()).toBe('1abc2');

    const json = editorPayload(selected, selected.doc);
    expect(json).not.toBeNull();
    // Through the wire as plain data, without the document.
    const sent = JSON.parse(JSON.stringify(json));
    expect(sent.doc).toBeUndefined();

    const seeded = seededState(sent, textFromString('1abc2'), [history()]);
    expect(seeded.doc.toString()).toBe('1abc2');
    expect(seeded.selection.main.from).toBe(1);
    expect(seeded.selection.main.to).toBe(3);
    // One undo reverts only the last change; a second only the one before.
    const once = undone(seeded);
    expect(once.doc.toString()).toBe('1abc');
    expect(undone(once).doc.toString()).toBe('abc');
  });

  it("has none for a state whose document is not the tab's text", () => {
    const state = edited('abc', [{ from: 0, insert: '1' }]);
    expect(editorPayload(state, textFromString('something else'))).toBeNull();
    expect(editorPayload(state, state.doc)).not.toBeNull();
  });

  it('has none for a tab that was never held by an editor', () => {
    expect(editorPayload(null, textFromString('abc'))).toBeNull();
  });
});

describe('the scroll position of a tab on its way', () => {
  it('is the line at the top and how far it is scrolled past, as plain data', () => {
    expect(scrollRecord(130, { from: 42, top: 100 }, 7)).toEqual({
      pos: 42,
      yMargin: 30,
      scrollLeft: 7,
    });
  });

  it('is read from the view past the document padding', () => {
    const view = {
      scrollDOM: { scrollTop: 250, scrollLeft: 12 },
      documentPadding: { top: 20, bottom: 0 },
      lineBlockAtHeight: (height: number) => {
        expect(height).toBe(230);
        return { from: 90, top: 200 } as never;
      },
    };
    expect(
      scrollRecordOf(view as unknown as Parameters<typeof scrollRecordOf>[0]),
    ).toEqual({
      pos: 90,
      yMargin: 30,
      scrollLeft: 12,
    });
  });

  it('puts the line back where it was, whatever the layout of the new window', () => {
    const record = { pos: 90, yMargin: 30, scrollLeft: 12 };
    // The same line is at another height here, under another padding.
    expect(scrollTargetTop(record, 400, 8)).toBe(438);
  });
});
