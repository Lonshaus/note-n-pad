// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Composing text with an input method while the caret lies outside the loaded
// window of a large file. The composition runs at the window edge, where
// CodeMirror clamps the caret; its changes are captured, undone when it ends,
// and the committed text is replayed at the real caret.

import { ChangeSet, type Text } from '@codemirror/state';
/** The changes a composition made since the capture began, composed into one
 *  change set over the document the capture started from. */
export interface ImeCapture {
  changes: ChangeSet;
}
/** Begin a capture over a document of `docLength` characters. */
export function startCapture(docLength: number): ImeCapture {
  return { changes: ChangeSet.empty(docLength) };
}
/** Fold the changes of one editor update into the capture. They must apply to
 *  the document the capture has reached so far. */
export function accumulate(
  capture: ImeCapture,
  changes: ChangeSet,
): ImeCapture {
  return { changes: capture.changes.compose(changes) };
}
/** The text the composition committed and the changes that put the document back
 *  as it was when the capture began. A composition that was cancelled leaves
 *  nothing to commit and nothing to revert. */
export function finishCapture(
  startDoc: Text,
  changes: ChangeSet,
): { committed: string; revert: ChangeSet } {
  let committed = '';
  changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
    committed += inserted.toString();
  });
  return { committed, revert: changes.invert(startDoc) };
}
/** Whether a pointer selection joins the replay queue: the input before it has
 *  not reached the core yet, or a composition is open. */
export function selectQueued(s: {
  pointer: boolean;
  replayPending: boolean;
  capturing: boolean;
}): boolean {
  return s.pointer && (s.replayPending || s.capturing);
}
/** A position in the document a composition has changed, as a position in the
 *  document the capture began from. A position inside the composition goes to
 *  where it began. */
export function toCaptureStart(
  changes: ChangeSet,
  startDoc: Text,
  pos: number,
): number {
  return changes.invert(startDoc).mapPos(pos, -1);
}
/** What a keydown means for the "input method key seen, composition not started"
 *  state: 'mark' sets it, 'clear' ends it, 'keep' leaves it (a composition is
 *  already running). */
export function imeKeyAction(s: {
  ime: boolean;
  wanted: boolean;
  capturing: boolean;
}): 'mark' | 'clear' | 'keep' {
  if (!s.ime) {
    return 'clear';
  }
  if (s.capturing) {
    return 'keep';
  }
  return s.wanted ? 'mark' : 'clear';
}
/** What to do with an edit made while the selection lies outside the window:
 *  'capture' lets it through into the running capture, 'queue' rejects it and
 *  replays its text at the real caret, 'reject' rejects it and leaves it to the
 *  key replay (a composition edit no capture covers is dropped). */
export function outsideInputAction(s: {
  capturing: boolean;
  /** An input method key came and no composition has started. */
  pending: boolean;
  /** A capture ended a moment ago; CodeMirror may still deliver its last text. */
  late: boolean;
  userEvent: string | undefined;
}): 'capture' | 'queue' | 'reject' {
  const e = s.userEvent;
  const isCompose = e !== undefined && e.startsWith('input.type.compose');
  const isType =
    e === 'input.type' || (e !== undefined && e.startsWith('input.type.'));
  // CodeMirror's own composition start deletes a multi-line selection as plain
  // 'input'.
  if (s.capturing && (isType || e === 'input')) {
    return 'capture';
  }
  if (isType && !isCompose) {
    return 'queue';
  }
  if (isCompose && (s.pending || s.late)) {
    return 'queue';
  }
  return 'reject';
}
/** Whether a transaction is the input of a composition a capture covers. */
export function capturedInput(
  capturing: boolean,
  userEvent: string | undefined,
): boolean {
  return (
    capturing &&
    outsideInputAction({
      capturing: true,
      pending: false,
      late: false,
      userEvent,
    }) === 'capture'
  );
}
/** What an editor update means for the window's bookkeeping. While a capture
 *  runs, its changes only accumulate: they are no edit for the core and they
 *  must not move the global selection, which still holds the real caret. */
export function updateActions(s: {
  docChanged: boolean;
  selectionSet: boolean;
  swapping: boolean;
  applyingRemote: boolean;
  capturing: boolean;
}): { accumulate: boolean; edit: boolean; track: boolean } {
  return {
    accumulate: s.capturing && s.docChanged,
    edit: s.docChanged && !s.swapping && !s.applyingRemote && !s.capturing,
    track: (s.docChanged || s.selectionSet) && !s.swapping && !s.capturing,
  };
}
/** Whether a composition that starts now is captured. A queued replay does not
 *  stop it: the next composition of a run starts while the last commit waits for
 *  its swap, and its text joins the queue behind the first. The swap that brings
 *  the window back to the caret does not stop it either: the keys typed while it
 *  runs compose in the old window, and the new one goes in after the commit. Any
 *  other swap running, or a queue being replayed, does stop it. */
export function captureStartAllowed(s: {
  capturing: boolean;
  locked: boolean;
  swapping: boolean;
  /** The swap running is the one that brings the window back to the caret. */
  replaySwap: boolean;
  draining: boolean;
  holds: number;
  /** The replay wants the input: focus is right and the caret is outside. */
  wanted: boolean;
  /** The selection lies outside the window and fits one. */
  outside: boolean;
  /** A Select All waits to run, which takes no new input. */
  selectAllPending: boolean;
}): boolean {
  return (
    !s.selectAllPending &&
    !s.capturing &&
    !s.locked &&
    !s.draining &&
    s.holds === 0 &&
    s.wanted &&
    (s.replaySwap || (!s.swapping && s.outside))
  );
}
