// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
import type { ClipRoute } from './clipRouting';
import { MARGIN_LINES, WINDOW_LINES, nextWindow } from './windowedEdit';
/** Pure model of a selection that outlives the sliding window: the editor keeps
 *  the selection's global ends, and only the part inside the loaded window is
 *  live in CodeMirror. Free of CodeMirror/Tauri so it unit-tests in isolation. */
/** A position as a 0-based line and a character column. The line is global in a
 *  global selection and window-local in a live one. */
export interface LinePos {
  line: number;
  col: number;
}

export interface LineSelection {
  anchor: LinePos;
  head: LinePos;
  /** Made by Select Line: a Shift key first turns it toward its own direction. */
  undirectional?: boolean;
}
/** The loaded window: its first global line, its line count and the length of
 *  each window-local line. */
export interface WindowShape {
  startLine: number;
  lineCount: number;
  lineLength: (local: number) => number;
}

function samePos(a: LinePos, b: LinePos): boolean {
  return a.line === b.line && a.col === b.col;
}

function toLivePos(pos: LinePos, win: WindowShape): LinePos {
  const local = pos.line - win.startLine;
  if (local < 0) {
    return { line: 0, col: 0 };
  }
  if (local >= win.lineCount) {
    const last = win.lineCount - 1;
    return { line: last, col: win.lineLength(last) };
  }
  return { line: local, col: Math.min(pos.col, win.lineLength(local)) };
}

function toGlobalPos(pos: LinePos, startLine: number): LinePos {
  return { line: pos.line + startLine, col: pos.col };
}
/** The global selection intersected with the window: an end outside it sits on
 *  the window edge on its side, so a selection entirely outside becomes a caret
 *  at the nearest edge. */
export function toLiveSelection(
  global: LineSelection,
  win: WindowShape,
): LineSelection {
  return {
    anchor: toLivePos(global.anchor, win),
    head: toLivePos(global.head, win),
  };
}

export function toGlobalSelection(
  live: LineSelection,
  startLine: number,
): LineSelection {
  return {
    anchor: toGlobalPos(live.anchor, startLine),
    head: toGlobalPos(live.head, startLine),
  };
}
/** A window swap: the live selection for the new window. The global selection
 *  is returned unchanged, so a later swap can bring the clamped ends back. */
export function selectionAfterSwap(
  global: LineSelection,
  win: WindowShape,
): { live: LineSelection; global: LineSelection } {
  return { live: toLiveSelection(global, win), global };
}
/** A caret at the start of a global line: the selection after a goto swap. */
export function gotoSelection(line: number): LineSelection {
  const pos = { line, col: 0 };
  return { anchor: pos, head: pos };
}
/** The global selection after the live one changed inside the window. A document
 *  change replaces it with the live selection. A pure selection change replaces
 *  each end the user moved; an end left where it was keeps its remembered global
 *  position, which may lie outside the window. A range collapsing to a caret
 *  drops the remembered ends, since an arrow key collapsing onto a clamped edge
 *  leaves that end unmoved. */
export function selectionAfterChange(
  global: LineSelection,
  prevLive: LineSelection,
  nextLive: LineSelection,
  startLine: number,
  docChanged: boolean,
): LineSelection {
  const next = toGlobalSelection(nextLive, startLine);
  const collapsed =
    !samePos(prevLive.anchor, prevLive.head) &&
    samePos(nextLive.anchor, nextLive.head);
  if (docChanged || collapsed) {
    return next;
  }
  return {
    anchor: samePos(prevLive.anchor, nextLive.anchor)
      ? global.anchor
      : next.anchor,
    head: samePos(prevLive.head, nextLive.head) ? global.head : next.head,
  };
}
/** Whether both ends of the selection lie on lines of the loaded window. */
export function insideWindow(
  global: LineSelection,
  startLine: number,
  lineCount: number,
): boolean {
  const end = startLine + lineCount;
  return (
    global.anchor.line >= startLine &&
    global.anchor.line < end &&
    global.head.line >= startLine &&
    global.head.line < end
  );
}
/** Whether one window can hold the selection with a margin on both sides. */
export function fitsWindow(global: LineSelection): boolean {
  return (
    Math.abs(global.anchor.line - global.head.line) <=
    WINDOW_LINES - 2 * MARGIN_LINES
  );
}
/** Whether the selection is too large for one window, so an edit or an
 *  indentation of it is an operation on the whole file and not on the window. */
export function globalOpPath(global: LineSelection): boolean {
  return !fitsWindow(global);
}
/** Whether the loaded window can take the input replayed at the selection: a
 *  selection that fits one window has both ends inside; one that does not is
 *  replayed in the window holding its head, with the other end clamped. */
export function replayReady(
  global: LineSelection,
  startLine: number,
  lineCount: number,
): boolean {
  if (fitsWindow(global)) {
    return insideWindow(global, startLine, lineCount);
  }
  const line = global.head.line;
  return line >= startLine && line < startLine + lineCount;
}
/** Which ends a pointer selection moved: an end left where it was (the anchor
 *  of a shift-click) keeps the queued caret's position. */
export function movedEnds(
  prev: { anchor: number; head: number },
  next: { anchor: number; head: number },
): { anchor: boolean; head: boolean } {
  return {
    anchor: prev.anchor !== next.anchor,
    head: prev.head !== next.head,
  };
}
/** The ends a pointer selection queues: the converted position of each end it
 *  moved, the queued caret's end for the others. */
export function queuedSelectEnds<T>(
  prev: { anchor: number; head: number },
  next: { anchor: number; head: number },
  convert: (pos: number) => T,
  caret: { anchor: T; head: T },
): { anchor: T; head: T } {
  const moved = movedEnds(prev, next);
  return {
    anchor: moved.anchor ? convert(next.anchor) : caret.anchor,
    head: moved.head ? convert(next.head) : caret.head,
  };
}
/** The first line of a window holding both ends of a selection that fits one,
 *  clamped to the file. */
export function windowStartFor(
  global: LineSelection,
  totalLines: number,
): number {
  const first = Math.min(global.anchor.line, global.head.line);
  return nextWindow(first, totalLines, WINDOW_LINES, MARGIN_LINES).startLine;
}
/** The fields of a KeyboardEvent that decide how a key is replayed. */
export interface ReplayKeyEvent {
  key: string;
  keyCode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
}

const MODIFIER_KEYS = new Set([
  'Alt',
  'AltGraph',
  'CapsLock',
  'Control',
  'Fn',
  'FnLock',
  'Hyper',
  'Meta',
  'NumLock',
  'OS',
  'ScrollLock',
  'Shift',
  'Super',
  'Symbol',
  'SymbolLock',
]);

const EDIT_KEYS = new Set([
  'Enter',
  'Backspace',
  'Delete',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);
/** Whether the key belongs to an input method (a composition is running or
 *  about to start). */
export function isImeKey(e: ReplayKeyEvent): boolean {
  return e.isComposing || e.key === 'Process' || e.keyCode === 229;
}
/** How a keydown is replayed once the window is back on the selection: 'text'
 *  inserts the character, 'key' runs the editor's key binding, 'chord' is a
 *  Ctrl/Meta shortcut that keeps its native action (an AltGr character typed
 *  with Ctrl+Alt arrives later as input), 'ignore' is dropped. */
export function replayKind(
  e: ReplayKeyEvent,
  os: string,
): 'text' | 'key' | 'chord' | 'ignore' {
  if (isImeKey(e) || MODIFIER_KEYS.has(e.key)) {
    return 'ignore';
  }
  if (e.ctrlKey || e.metaKey) {
    return 'chord';
  }
  if ([...e.key].length === 1) {
    // Alt+character types only on macOS; elsewhere it is a menu mnemonic.
    return os !== 'macos' && e.altKey ? 'chord' : 'text';
  }
  return EDIT_KEYS.has(e.key) ? 'key' : 'ignore';
}
/** Whether the key is an editing or navigation key other than Tab. */
export function isEditingKey(key: string): boolean {
  return EDIT_KEYS.has(key) && key !== 'Tab';
}
/** Whether the key is a modifier pressed on its own. */
export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.has(key);
}
/** What Select All covers in a large file: what is on screen, or the file. */
export type SelectAllMode = 'visible' | 'file';
/** How Select All was asked for: its key, the Edit menu, or the browser's own
 *  select-all arriving as a selection. */
export type SelectAllEntry = 'key' | 'menu' | 'native';
/** What a Select All made through `entry` covers under the setting. */
export function selectAllTarget(
  mode: SelectAllMode,
  _entry: SelectAllEntry,
): SelectAllMode {
  return mode === 'file' ? 'file' : 'visible';
}
/** Whether an end of the global selection lies outside the lines of the loaded
 *  window, so an operation on the selection needs the whole file and not the
 *  window's text. */
export function needsGlobalOp(
  global: LineSelection,
  startLine: number,
  lineCount: number,
): boolean {
  return !insideWindow(global, startLine, lineCount);
}
/** What can end or set the viewer's whole-file selection. */
export type WholeFileEvent =
  | { type: 'selectAll'; entry: SelectAllEntry }
  | { type: 'click' | 'key' | 'select' };
/** Whether the viewer's selection is the whole file after `event`: a Select All
 *  under the "file" setting sets it, a click, a key that moves the selection
 *  or a new selection clears it. */
export function wholeFileAfter(
  state: { mode: SelectAllMode },
  event: WholeFileEvent,
): boolean {
  return (
    event.type === 'selectAll' &&
    selectAllTarget(state.mode, event.entry) === 'file'
  );
}
/** Whether a key press moves the selection (modifiers do not matter). */
export function movesSelection(key: string): boolean {
  return (
    key.startsWith('Arrow') ||
    key === 'Home' ||
    key === 'End' ||
    key === 'PageUp' ||
    key === 'PageDown'
  );
}
/** The selection of a Select All over the whole file: the global ends are the
 *  start of the file and `endPos`, the live selection is those clamped to the
 *  window, and the last live selection is that same one, so the next update of
 *  the view moves neither global end. */
export function wholeFileSelection(
  endPos: LinePos,
  win: WindowShape,
): { globalSel: LineSelection; live: LineSelection; lastLive: LineSelection } {
  const globalSel = { anchor: { line: 0, col: 0 }, head: endPos };
  const live = toLiveSelection(globalSel, win);
  return { globalSel, live, lastLive: live };
}
/** Whether a transaction is refused while the selection is too large for one
 *  window: one a user action made that changes the document, whatever the
 *  action. Only the part inside the window would change. */
export function blockedWhileGlobal(
  tr: { docChanged: boolean; userEvent: string | undefined },
  global: LineSelection,
): boolean {
  return tr.docChanged && tr.userEvent !== undefined && globalOpPath(global);
}
/** Whether a copy or cut is refused: none is. A selection too large for one
 *  window is copied or cut through a clip (see `clipCopyRoute`), and a paste
 *  goes to the replay as a replace of the selection. */
export function clipboardBlocked(
  _kind: 'copy' | 'cut' | 'paste',
  _global: LineSelection,
  _focus: 'editor' | 'none' | 'other',
): boolean {
  return false;
}
/** What a queued copy or cut does once it is taken out, by the way its copy
 *  goes now: 'clip' goes through a clip file, 'supply' gives the web clipboard
 *  the text of the window. */
export function queuedClipboardAction(route: ClipRoute): 'clip' | 'supply' {
  return route === 'session' ? 'clip' : 'supply';
}
/** Whether a selection transaction is the browser's select-all: not made by a
 *  key command or a pointer, no document change, and covering the whole
 *  rendered range. */
export function isNativeSelectAll(s: {
  docChanged: boolean;
  isSelect: boolean;
  isPointer: boolean;
  keyActive: boolean;
  from: number;
  to: number;
  viewportFrom: number;
  viewportTo: number;
}): boolean {
  return (
    !s.keyActive &&
    !s.docChanged &&
    s.isSelect &&
    !s.isPointer &&
    s.from <= s.viewportFrom &&
    s.to >= s.viewportTo
  );
}
