// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// What the windowed editor does with input that acts on a selection too large
// for one window (a global operation on the file), decided when the queued item
// is taken out of the replay queue: which command a key is, what it does to the
// selection, and how the undo and group bookkeeping follows. Free of the DOM
// and Tauri, so it unit-tests in isolation.

import type { Command } from '@codemirror/view';
import {
  addCursorAbove,
  addCursorBelow,
  blockComment,
  blockUncomment,
  copyLineDown,
  copyLineUp,
  cursorCharBackward,
  cursorCharBackwardLogical,
  cursorCharForward,
  cursorCharForwardLogical,
  cursorCharLeft,
  cursorCharRight,
  cursorDocEnd,
  cursorDocStart,
  cursorGroupBackward,
  cursorGroupForward,
  cursorGroupForwardWin,
  cursorGroupLeft,
  cursorGroupRight,
  cursorLineBoundaryBackward,
  cursorLineBoundaryForward,
  cursorLineBoundaryLeft,
  cursorLineBoundaryRight,
  cursorLineDown,
  cursorLineEnd,
  cursorLineStart,
  cursorLineUp,
  cursorMatchingBracket,
  cursorPageDown,
  cursorPageUp,
  cursorSubwordBackward,
  cursorSubwordForward,
  cursorSyntaxLeft,
  cursorSyntaxRight,
  deleteCharBackward,
  deleteCharBackwardStrict,
  deleteCharForward,
  deleteGroupBackward,
  deleteGroupForward,
  deleteGroupForwardWin,
  deleteLine,
  deleteLineBoundaryBackward,
  deleteLineBoundaryForward,
  deleteToLineEnd,
  deleteToLineStart,
  deleteTrailingWhitespace,
  indentLess,
  indentMore,
  indentSelection,
  insertBlankLine,
  insertNewlineAndIndent,
  insertNewlineKeepIndent,
  insertTab,
  lineComment,
  lineUncomment,
  moveLineDown,
  moveLineUp,
  redoSelection,
  selectAll,
  selectCharBackward,
  selectCharBackwardLogical,
  selectCharForward,
  selectCharForwardLogical,
  selectCharLeft,
  selectCharRight,
  selectDocEnd,
  selectDocStart,
  selectGroupBackward,
  selectGroupForward,
  selectGroupForwardWin,
  selectGroupLeft,
  selectGroupRight,
  selectLine,
  selectLineBoundaryBackward,
  selectLineBoundaryForward,
  selectLineBoundaryLeft,
  selectLineBoundaryRight,
  selectLineDown,
  selectLineEnd,
  selectLineStart,
  selectLineUp,
  selectMatchingBracket,
  selectPageDown,
  selectPageUp,
  selectParentSyntax,
  selectSubwordBackward,
  selectSubwordForward,
  selectSyntaxLeft,
  selectSyntaxRight,
  simplifySelection,
  splitLine,
  toggleBlockComment,
  toggleBlockCommentByLine,
  toggleComment,
  toggleLineComment,
  toggleTabFocusMode,
  transposeChars,
  undoSelection as undoCursorSelection,
} from '@codemirror/commands';
import { offscreenArrowKeys } from '../editor/offscreenArrow';
import { shiftTabKey, tabKey } from '../editor/keymap';
import {
  decideNewGroup,
  type GroupCurrent,
  type GroupPrev,
} from './windowedEdit';
import {
  drainStep,
  replayStartAction,
  type ReplayItemKind,
} from './replayKeys';
import {
  fitsWindow,
  globalOpPath,
  insideWindow,
  queuedClipboardAction,
  type LinePos,
  type LineSelection,
} from './windowSelection';
import { LINE_END_COL, clipCopyRoute } from './clipRouting';

export { globalOpPath };
/** The loaded window as far as the routing looks at it. */
export interface WindowLines {
  startLine: number;
  lineCount: number;
}
/** Whether the selection fits one window but lies outside the loaded one. */
export function selectionOutside(
  sel: LineSelection,
  win: WindowLines,
): boolean {
  return !insideWindow(sel, win.startLine, win.lineCount) && fitsWindow(sel);
}
/** Whether input acts through the replay: the selection is outside the loaded
 *  window, or too large for any window and so edited as a global operation. */
export function inputOutside(sel: LineSelection, win: WindowLines): boolean {
  return selectionOutside(sel, win) || globalOpPath(sel);
}
/** Whether a move to the start or end of the file, `spec` being one of the
 *  four doc-edge selection commands, ends outside the loaded window. */
export function docEdgeOutside(
  spec: SelectSpec,
  win: WindowLines,
  totalLines: number,
): boolean {
  if (spec.type !== 'docEdge' && spec.type !== 'extendDoc') {
    return false;
  }
  return spec.end
    ? win.startLine + win.lineCount < totalLines
    : win.startLine > 0;
}
/** Whether the swap now running leaves the editor open to a captured
 *  composition. A global operation of this very editor holds the gate read-only
 *  and still counts. */
export function keepsInput(s: {
  swapping: boolean;
  replaySwap: boolean;
  locked: boolean;
  holds: number;
  gateReadOnly: boolean;
  ownGlobalOp: boolean;
}): boolean {
  return (
    s.swapping &&
    s.replaySwap &&
    !s.locked &&
    s.holds === 0 &&
    (!s.gateReadOnly || s.ownGlobalOp)
  );
}
/** What a global operation needs to wait for before it starts: the same as a
 *  swap back to the caret, a composition no capture covers holds it back. */
export function globalStartAction(
  s: Parameters<typeof replayStartAction>[0],
): 'drop' | 'wait' | 'run' {
  const action = replayStartAction(s);
  return action === 'swap' ? 'run' : action;
}
/** Text for the core with every line break written as `sep`, the file's. */
export function normalizeBreaks(text: string, sep: string): string {
  return text.replace(/\r\n?|\n/g, sep);
}
/** The text a replace-range operation puts in place of the selection, with the
 *  file's breaks: nothing for a delete, one break for a split line, the item's
 *  text for a replace. */
export function opText(op: GlobalOp, text: string, sep: string): string {
  if (op === 'delete' || op === 'clipCut') {
    return '';
  }
  return normalizeBreaks(op === 'split' ? '\n' : text, sep);
}
/** The two ends of a selection as the core's `track` argument, when the
 *  selection is too large for a window (and so no window mirrors it). */
export function trackOf(sel: LineSelection): [LinePos, LinePos] | undefined {
  return globalOpPath(sel) ? [sel.anchor, sel.head] : undefined;
}
/** Whether the edit joins the undo group of the one before it: the typed text
 *  that follows a global delete does, with the delete a single step. */
export function groupDecision(s: {
  joinNextApply: boolean;
  forceNewGroup: boolean;
  prev: GroupPrev;
  current: GroupCurrent;
}): boolean {
  if (s.joinNextApply) {
    return false;
  }
  return s.forceNewGroup || decideNewGroup(s.prev, s.current);
}
/** Whether the flag that joins the next edit to the global delete before it
 *  survives the drain's next step: only a step that waits for the edit or runs
 *  it keeps it, anything else running first clears it. */
export function joinAfterStep(flag: boolean, step: DequeueStep): boolean {
  return (
    flag &&
    (step === 'run' || step === 'wait' || step === 'swap' || step === 'map')
  );
}
/** The selection after an undo or redo that was asked to track the selection,
 *  and how the window follows. 'mirror': the edits landed in the window.
 *  'reload_only': the window is read again where it is. 'goto': the change lies
 *  outside the window; the selection is revealed at its head, not replaced by
 *  a caret at the change. */
export function undoSelection(s: {
  tracked: readonly [LinePos, LinePos] | undefined;
  branch: 'mirror' | 'reload_only' | 'goto';
}): { sel: LineSelection | null; mode: 'none' | 'reload' | 'reveal' | 'goto' } {
  const sel =
    s.tracked === undefined
      ? null
      : { anchor: s.tracked[0], head: s.tracked[1] };
  if (s.branch === 'mirror') {
    return { sel, mode: 'none' };
  }
  if (s.branch === 'reload_only') {
    return { sel, mode: 'reload' };
  }
  return { sel, mode: sel === null ? 'goto' : 'reveal' };
}
/** How a selection command moves the selection of a window-less selection. */
export type SelectSpec =
  /** Collapses to the later (forward) or earlier end. */
  | { type: 'collapse'; forward: boolean }
  /** Collapses at the head, moved to a line boundary by the replay. */
  | { type: 'lineBoundary' }
  | { type: 'docEdge'; end: boolean }
  /** Moves the head by the replay; `forward` turns a Select Line selection. */
  | { type: 'extend'; forward: boolean | null }
  | { type: 'extendDoc'; end: boolean }
  | { type: 'simplify' }
  | { type: 'line' }
  /** Acts at the head, or leaves the selection as it was. */
  | { type: 'restore' };
/** What a command does on a selection too large for one window. */
export type CommandClass =
  | { type: 'delete' }
  | { type: 'enter' }
  | { type: 'split' }
  | { type: 'indent' }
  | { type: 'outdent' }
  | { type: 'select'; select: SelectSpec }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'closeBox' }
  /** Runs on the window as it is. */
  | { type: 'normal' }
  | { type: 'drop' };
/** The editor's own commands, which have no identity of CodeMirror's. */
export interface OwnCommands {
  closeBox: Command;
  selectVisible: Command;
  undo: Command;
  redo: Command;
}

const TABLE = new Map<Command, CommandClass>();

function classify(commands: readonly Command[], cls: CommandClass): void {
  for (const command of commands) {
    TABLE.set(command, cls);
  }
}
const collapse = (forward: boolean): CommandClass => ({
  type: 'select',
  select: { type: 'collapse', forward },
});
const extend = (forward: boolean | null): CommandClass => ({
  type: 'select',
  select: { type: 'extend', forward },
});
const LINE_BOUNDARY: CommandClass = {
  type: 'select',
  select: { type: 'lineBoundary' },
};
const offscreenUp = offscreenArrowKeys[0];
const offscreenDown = offscreenArrowKeys[1];
// A left or right key moves the other way in right-to-left text; the
// selection's own direction is not known here, so left-to-right is assumed.
classify(
  [
    cursorCharLeft,
    cursorCharBackward,
    cursorCharBackwardLogical,
    cursorGroupLeft,
    cursorGroupBackward,
    cursorSubwordBackward,
    cursorLineUp,
    cursorPageUp,
    ...(offscreenUp?.run !== undefined ? [offscreenUp.run] : []),
  ],
  collapse(false),
);
classify(
  [
    cursorCharRight,
    cursorCharForward,
    cursorCharForwardLogical,
    cursorGroupRight,
    cursorGroupForward,
    cursorGroupForwardWin,
    cursorSubwordForward,
    cursorLineDown,
    cursorPageDown,
    ...(offscreenDown?.run !== undefined ? [offscreenDown.run] : []),
  ],
  collapse(true),
);
classify(
  [
    cursorLineBoundaryBackward,
    cursorLineBoundaryForward,
    cursorLineBoundaryLeft,
    cursorLineBoundaryRight,
    cursorLineStart,
    cursorLineEnd,
  ],
  LINE_BOUNDARY,
);
classify([cursorDocStart], {
  type: 'select',
  select: { type: 'docEdge', end: false },
});
classify([cursorDocEnd], {
  type: 'select',
  select: { type: 'docEdge', end: true },
});
classify(
  [
    selectCharLeft,
    selectCharBackward,
    selectCharBackwardLogical,
    selectGroupLeft,
    selectGroupBackward,
    selectSubwordBackward,
    selectLineUp,
    selectPageUp,
    selectLineBoundaryBackward,
    selectLineBoundaryLeft,
    selectLineStart,
    ...(offscreenUp?.shift !== undefined ? [offscreenUp.shift] : []),
  ],
  extend(false),
);
classify(
  [
    selectCharRight,
    selectCharForward,
    selectCharForwardLogical,
    selectGroupRight,
    selectGroupForward,
    selectGroupForwardWin,
    selectSubwordForward,
    selectLineDown,
    selectPageDown,
    selectLineBoundaryForward,
    selectLineBoundaryRight,
    selectLineEnd,
    ...(offscreenDown?.shift !== undefined ? [offscreenDown.shift] : []),
  ],
  extend(true),
);
// Extends from the anchor without turning a Select Line selection.
classify([selectMatchingBracket], extend(null));
classify([selectDocStart], {
  type: 'select',
  select: { type: 'extendDoc', end: false },
});
classify([selectDocEnd], {
  type: 'select',
  select: { type: 'extendDoc', end: true },
});
classify([simplifySelection], {
  type: 'select',
  select: { type: 'simplify' },
});
classify([selectLine], { type: 'select', select: { type: 'line' } });
classify([cursorMatchingBracket, addCursorAbove, addCursorBelow], {
  type: 'select',
  select: { type: 'restore' },
});
classify(
  [
    deleteCharBackward,
    deleteCharBackwardStrict,
    deleteCharForward,
    deleteGroupBackward,
    deleteGroupForward,
    deleteGroupForwardWin,
    deleteLineBoundaryBackward,
    deleteLineBoundaryForward,
    deleteToLineEnd,
    deleteToLineStart,
  ],
  { type: 'delete' },
);
classify([insertNewlineAndIndent], { type: 'enter' });
classify([splitLine], { type: 'split' });
classify([indentMore, tabKey], { type: 'indent' });
classify([indentLess, shiftTabKey], { type: 'outdent' });
// The syntax moves jump to the ends of the window, not of the file, without a
// language; they run on the window until they are classed with the doc edges.
classify(
  [
    toggleTabFocusMode,
    selectAll,
    cursorSyntaxLeft,
    cursorSyntaxRight,
    selectSyntaxLeft,
    selectSyntaxRight,
  ],
  { type: 'normal' },
);
// Edits that are no goal of the global path, and the ones that do nothing
// without a language or on a selection: they stay as they were.
classify(
  [
    moveLineUp,
    moveLineDown,
    copyLineUp,
    copyLineDown,
    deleteLine,
    insertBlankLine,
    indentSelection,
    toggleComment,
    toggleLineComment,
    toggleBlockComment,
    toggleBlockCommentByLine,
    blockComment,
    blockUncomment,
    lineComment,
    lineUncomment,
    deleteTrailingWhitespace,
    transposeChars,
    selectParentSyntax,
    insertNewlineKeepIndent,
    insertTab,
    undoCursorSelection,
    redoSelection,
  ],
  { type: 'drop' },
);
/** What `command` is on a selection too large for a window; undefined for a
 *  command that is in no row of the table. */
export function classifyCommand(
  command: Command,
  own: OwnCommands,
): CommandClass | undefined {
  if (command === own.closeBox) {
    return { type: 'closeBox' };
  }
  if (command === own.selectVisible) {
    return { type: 'normal' };
  }
  if (command === own.undo) {
    return { type: 'undo' };
  }
  if (command === own.redo) {
    return { type: 'redo' };
  }
  return TABLE.get(command);
}
/** The whole-file operations a queued item can turn into. */
export type GlobalOp =
  'delete' | 'replace' | 'enter' | 'split' | 'indent' | 'outdent' | 'clipCut';
/** The two ends of a range of the file, as the core takes them. */
export interface ClipEnds {
  anchor: LinePos;
  head: LinePos;
}
/** A copy through a clip file. `linewise` marks the line of a caret, copied
 *  with nothing selected. `refuseSupply`: the item was queued with a write to
 *  the web clipboard, which is refused (it can no longer be made). */
export interface ClipCopy {
  copy: ClipEnds;
  linewise: boolean;
  refuseSupply: boolean;
}
/** A cut through a clip file: `remove` is taken out of the file once the clip
 *  is offered. Its head `'end'` is the end of the file. */
export interface ClipCut extends ClipCopy {
  remove: { anchor: LinePos; head: LinePos | 'end' };
}
/** What the drain does with an item. 'normal' runs it on the window as it is,
 *  'drop' removes it, 'deleteFirst' deletes the selection and then runs the
 *  item as typed text at the caret, 'op' is the whole-file operation,
 *  'clipCopy' copies a range through a clip without changing the file,
 *  'select' moves the selection by the command, 'undo' and 'redo' stand for the
 *  item turned into an undo or redo, 'clipPaste' asks the clipboard what it
 *  holds and pastes that (see `resolveClip`). */
export type GlobalAction =
  | { type: 'normal' }
  | { type: 'drop' }
  | { type: 'deleteFirst' }
  | { type: 'op'; op: Exclude<GlobalOp, 'clipCut'> }
  | { type: 'op'; op: 'clipCut'; cut: ClipCut }
  | ({ type: 'clipCopy' } & ClipCopy)
  | { type: 'select'; select: SelectSpec }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'clipPaste' };

const NORMAL: GlobalAction = { type: 'normal' };
const DROP: GlobalAction = { type: 'drop' };
/** A queued item as far as the routing looks at it. */
export interface RoutedItem {
  kind: ReplayItemKind;
  userEvent?: string | undefined;
  /** The selection key was applied to the selection already; it only needs
   *  its replay on the window. */
  handled?: boolean | undefined;
  /** A copy or cut queued to go through a clip, with no write to the web
   *  clipboard behind it. */
  clip?: boolean | undefined;
}
/** The clip action for a copy or cut of the selection `sel`. A caret copies
 *  its line without the break, and a cut takes the line and the break after it
 *  (the last line, up to the end of the file), as CodeMirror does. */
function clipAction(
  cut: boolean,
  sel: LineSelection,
  totalLines: number,
  refuseSupply: boolean,
): GlobalAction {
  const caret = same(sel.anchor, sel.head);
  const line = sel.head.line;
  const start: LinePos = { line, col: 0 };
  const copy: ClipEnds = caret
    ? { anchor: start, head: { line, col: LINE_END_COL } }
    : { anchor: sel.anchor, head: sel.head };
  if (!cut) {
    return { type: 'clipCopy', copy, linewise: caret, refuseSupply };
  }
  const remove = caret
    ? {
        anchor: start,
        head:
          line + 1 >= totalLines
            ? ('end' as const)
            : { line: line + 1, col: 0 },
      }
    : { anchor: sel.anchor, head: sel.head };
  return {
    type: 'op',
    op: 'clipCut',
    cut: { copy, remove, linewise: caret, refuseSupply },
  };
}
/** The doc-edge command a key is, when its target lies outside the window. */
export function docEdgeSelect(i: {
  commands: readonly Command[];
  panelOpen: boolean;
  own: OwnCommands;
  totalLines: number;
  win: WindowLines;
}): SelectSpec | undefined {
  for (const command of i.commands) {
    const cls = classifyCommand(command, i.own);
    if (cls === undefined || (cls.type === 'closeBox' && !i.panelOpen)) {
      continue;
    }
    return cls.type === 'select' &&
      docEdgeOutside(cls.select, i.win, i.totalLines)
      ? cls.select
      : undefined;
  }
  return undefined;
}
/** What to do with the queue's head at the moment it is taken out, by the
 *  selection it acts on. `commands` is the chain of commands the key falls
 *  through (see `commandChain`). */
export function globalItemAction(i: {
  item: RoutedItem;
  sel: LineSelection;
  commands: readonly Command[];
  panelOpen: boolean;
  own: OwnCommands;
  /** The file's line count now. */
  totalLines: number;
  /** The loaded window. */
  win: WindowLines;
}): GlobalAction {
  if (i.item.kind === 'copy' || i.item.kind === 'cut') {
    // A queued clip, or a copy that supplies the web clipboard but found its
    // selection grown past one window, goes through a clip file.
    const clip = i.item.clip === true;
    const route = clipCopyRoute({
      mode: 'edit',
      focus: 'editor',
      globalSel: i.sel,
      wholeFile: false,
      domSelection: false,
      sel: null,
      loadedRows: null,
    });
    if (clip || queuedClipboardAction(route) === 'clip') {
      return clipAction(i.item.kind === 'cut', i.sel, i.totalLines, !clip);
    }
  }
  if (i.item.kind === 'clipPaste') {
    // Whatever the selection: what the paste holds is not known yet.
    return { type: 'clipPaste' };
  }
  if (i.item.handled === true) {
    return NORMAL;
  }
  if (!globalOpPath(i.sel)) {
    // A move to the start or end of the file acts on the whole file even from
    // a caret in the window, when its target lies outside the window.
    const edge = i.item.kind === 'key' ? docEdgeSelect(i) : undefined;
    return edge === undefined ? NORMAL : { type: 'select', select: edge };
  }
  if (i.item.kind === 'text') {
    return i.item.userEvent === 'input.paste'
      ? { type: 'op', op: 'replace' }
      : { type: 'deleteFirst' };
  }
  if (i.item.kind !== 'key') {
    return NORMAL;
  }
  for (const command of i.commands) {
    const cls = classifyCommand(command, i.own);
    if (cls === undefined) {
      continue;
    }
    switch (cls.type) {
      case 'closeBox':
        // Closes a panel when one is open, else the next command decides.
        if (i.panelOpen) {
          return NORMAL;
        }
        break;
      case 'delete':
        return { type: 'op', op: 'delete' };
      case 'enter':
        return { type: 'op', op: 'enter' };
      case 'split':
        return { type: 'op', op: 'split' };
      case 'indent':
        return { type: 'op', op: 'indent' };
      case 'outdent':
        return { type: 'op', op: 'outdent' };
      case 'select':
        return { type: 'select', select: cls.select };
      case 'undo':
        return { type: 'undo' };
      case 'redo':
        return { type: 'redo' };
      case 'normal':
        return NORMAL;
      case 'drop':
        return DROP;
    }
  }
  return DROP;
}
/** What the drain does next, counting the items a global selection turns into
 *  work of their own: 'global' is a whole-file operation, 'keySelect' a
 *  selection key to apply, 'drop' removes the item. The others are those of
 *  `drainStep`. */
export type DequeueStep =
  ReturnType<typeof drainStep> | 'global' | 'keySelect' | 'drop' | 'clipCopy';

export interface DequeueInput {
  item: RoutedItem | undefined;
  sel: LineSelection;
  commands: readonly Command[];
  panelOpen: boolean;
  own: OwnCommands;
  swapping: boolean;
  holds: number;
  headMapping: boolean;
  ready: boolean;
  totalLines: number;
  win: WindowLines;
}
/** The next step for the queue's head. An item that works on the whole file is
 *  judged before `drainStep` sees it, so the window is not swapped (or the
 *  selection clamped) for an item that does not need the window. */
export function dequeueStep(i: DequeueInput): {
  step: DequeueStep;
  action: GlobalAction;
} {
  const action =
    i.item === undefined
      ? NORMAL
      : globalItemAction({
          item: i.item,
          sel: i.sel,
          commands: i.commands,
          panelOpen: i.panelOpen,
          own: i.own,
          totalLines: i.totalLines,
          win: i.win,
        });
  const busy = i.swapping || i.holds > 0;
  switch (action.type) {
    case 'drop':
      return { step: 'drop', action };
    case 'deleteFirst':
    case 'op':
    case 'clipPaste':
      return { step: busy ? 'wait' : 'global', action };
    case 'clipCopy':
      return { step: busy ? 'wait' : 'clipCopy', action };
    case 'select':
      return { step: busy ? 'wait' : 'keySelect', action };
    case 'undo':
    case 'redo':
      return {
        step: drainStep({
          swapping: i.swapping,
          holds: i.holds,
          head: action.type,
          headMapping: false,
          ready: i.ready,
        }),
        action,
      };
    case 'normal':
      return {
        step: drainStep({
          swapping: i.swapping,
          holds: i.holds,
          head: i.item?.kind ?? null,
          headMapping: i.headMapping,
          ready: i.ready,
        }),
        action,
      };
  }
}
/** The same for the queue's head in the shadow, which has no swap and no hold
 *  and acts on its own selection `sh.sel`. A copy through a clip stops it like
 *  a whole-file operation: the read loop runs it. */
export function shadowStep(
  i: Omit<DequeueInput, 'swapping' | 'holds'>,
): ReturnType<typeof dequeueStep> {
  const r = dequeueStep({ ...i, swapping: false, holds: 0 });
  return r.step === 'clipCopy' ? { step: 'global', action: r.action } : r;
}
/** What the read loop of a window swap does once the action the shadow stopped
 *  at has run: it reads the window again, around the selection the action
 *  leaves, and carries on with the loop. */
export function afterShadowStop(action: GlobalAction): 'reread' | 'end' {
  switch (action.type) {
    case 'op':
    case 'deleteFirst':
    case 'clipCopy':
    case 'clipPaste':
      return 'reread';
    default:
      return 'end';
  }
}

const before = (a: LinePos, b: LinePos): boolean =>
  a.line < b.line || (a.line === b.line && a.col < b.col);
const same = (a: LinePos, b: LinePos): boolean =>
  a.line === b.line && a.col === b.col;
const cursorAt = (p: LinePos): LineSelection => ({ anchor: p, head: p });
/** Whether `globalSelectAction` needs the end of the file. */
export function needsEndPos(spec: SelectSpec): boolean {
  return (
    spec.type === 'line' ||
    ((spec.type === 'docEdge' || spec.type === 'extendDoc') && spec.end)
  );
}
/** What a selection key does to a selection too large for a window. */
export interface SelectOutcome {
  /** The global selection to set. */
  sel: LineSelection;
  /** The key is replayed on the window holding the head of `sel`, which then
   *  decides the final selection. */
  replay: boolean;
  /** The selection to put back when the replay did nothing. */
  restore: LineSelection | null;
}
/** The selection after `spec`, as CodeMirror's command does on a non-empty
 *  selection; `end` is the end of the file. */
export function globalSelectAction(
  spec: SelectSpec,
  sel: LineSelection,
  end: LinePos,
): SelectOutcome {
  const first = before(sel.head, sel.anchor) ? sel.head : sel.anchor;
  const last = before(sel.head, sel.anchor) ? sel.anchor : sel.head;
  const start: LinePos = { line: 0, col: 0 };
  switch (spec.type) {
    case 'collapse':
      return {
        sel: cursorAt(spec.forward ? last : first),
        replay: false,
        restore: null,
      };
    case 'lineBoundary':
      return { sel: cursorAt(sel.head), replay: true, restore: null };
    case 'docEdge':
      return {
        sel: cursorAt(spec.end ? end : start),
        replay: false,
        restore: null,
      };
    case 'extend': {
      const turn =
        sel.undirectional === true &&
        spec.forward !== null &&
        !before(sel.head, sel.anchor) !== spec.forward;
      return {
        sel: turn ? { anchor: sel.head, head: sel.anchor } : sel,
        replay: true,
        restore: null,
      };
    }
    case 'extendDoc':
      return {
        sel: { anchor: sel.anchor, head: spec.end ? end : start },
        replay: false,
        restore: null,
      };
    case 'simplify':
      return { sel: cursorAt(sel.head), replay: false, restore: null };
    case 'line': {
      const empty = same(sel.anchor, sel.head);
      const lastLine =
        !empty && last.col === 0
          ? Math.max(first.line, last.line - 1)
          : last.line;
      return {
        sel: {
          anchor: { line: first.line, col: 0 },
          head: lastLine >= end.line ? end : { line: lastLine + 1, col: 0 },
          undirectional: true,
        },
        replay: false,
        restore: null,
      };
    }
    case 'restore':
      return { sel: cursorAt(sel.head), replay: true, restore: sel };
  }
}
