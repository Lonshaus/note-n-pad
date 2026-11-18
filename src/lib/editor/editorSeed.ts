// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// What an editor keeps of a tab besides its text, as plain data: the selection
// and the undo history, and where it is scrolled to. A tab moved to another
// window carries them, and the editor there starts from them instead of from
// the bare text.

import { EditorState, type Extension, type Text } from '@codemirror/state';
import { historyField } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { textEq } from '../util/text';
/** An editor state without its document: the selection and the history, as
 *  CodeMirror's `toJSON` gives them. */
export type EditorJson = Record<string, unknown>;
/** The state of the editor of a tab as plain data, or null when it has none or
 *  is not of the tab's current text (a state the document moved on from would
 *  put its history and selection on the wrong text). */
export function editorPayload(
  state: EditorState | null,
  content: Text,
): EditorJson | null {
  if (state === null || !textEq(state.doc, content)) {
    return null;
  }
  const json = state.toJSON({ history: historyField }) as Record<
    string,
    unknown
  >;
  const { doc: _doc, ...rest } = json;
  return rest;
}
/** The state `json` describes over `content`, with the same extensions the
 *  editor gives every tab. One `undo` reverts only the last change, as it would
 *  have in the window the tab came from. */
export function seededState(
  json: EditorJson,
  content: Text,
  extensions: Extension,
): EditorState {
  return EditorState.fromJSON(
    { ...json, doc: content.toString() },
    { extensions },
    { history: historyField },
  );
}
/** Where an editor is scrolled to, independent of the layout it was measured
 *  in: the document position at the top, how far that line is scrolled past,
 *  and the horizontal offset. */
export interface ScrollRecord {
  pos: number;
  yMargin: number;
  scrollLeft: number;
}
/** The record of a scroll `top` (past the document padding), with the line
 *  block at that height and the horizontal offset. */
export function scrollRecord(
  top: number,
  block: { from: number; top: number },
  scrollLeft: number,
): ScrollRecord {
  return { pos: block.from, yMargin: top - block.top, scrollLeft };
}
/** The scroll offset that puts the line block at `blockTop` the recorded
 *  margin above the top, given the document padding. */
export function scrollTargetTop(
  record: ScrollRecord,
  blockTop: number,
  paddingTop: number,
): number {
  return blockTop + paddingTop + record.yMargin;
}
/** The scroll record of a view as it is now. */
export function scrollRecordOf(
  view: Pick<EditorView, 'scrollDOM' | 'documentPadding' | 'lineBlockAtHeight'>,
): ScrollRecord {
  const top = view.scrollDOM.scrollTop - view.documentPadding.top;
  return scrollRecord(
    top,
    view.lineBlockAtHeight(top),
    view.scrollDOM.scrollLeft,
  );
}
/** Scroll `view` to `record`, in its next measure pass, when its layout is
 *  known. */
export function applyScrollRecord(
  view: EditorView,
  record: ScrollRecord,
): void {
  view.requestMeasure({
    read: (v) => ({
      blockTop: v.lineBlockAt(Math.min(record.pos, v.state.doc.length)).top,
      paddingTop: v.documentPadding.top,
    }),
    write: (measured, v) => {
      v.scrollDOM.scrollTop = scrollTargetTop(
        record,
        measured.blockTop,
        measured.paddingTop,
      );
      v.scrollDOM.scrollLeft = record.scrollLeft;
    },
  });
}
