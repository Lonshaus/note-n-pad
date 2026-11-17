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
/** Whether two selections have the same ends; `undirectional` is ignored. */
export function sameSelection(
  a: LineSelection | null,
  b: LineSelection | null,
): boolean {
  return (
    a !== null &&
    b !== null &&
    samePos(a.anchor, b.anchor) &&
    samePos(a.head, b.head)
  );
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
 *  leaves that end unmoved. `moved` names the ends that count as moved whatever
 *  their live position says (see `pointerMoves`): a selection made where a
 *  hidden end is drawn moves it. */
export function selectionAfterChange(
  global: LineSelection,
  prevLive: LineSelection,
  nextLive: LineSelection,
  startLine: number,
  docChanged: boolean,
  moved?: { anchor: boolean; head: boolean },
): LineSelection {
  const next = toGlobalSelection(nextLive, startLine);
  const collapsed =
    !samePos(prevLive.anchor, prevLive.head) &&
    samePos(nextLive.anchor, nextLive.head);
  if (docChanged || collapsed) {
    return next;
  }
  return {
    anchor:
      moved?.anchor !== true && samePos(prevLive.anchor, nextLive.anchor)
        ? global.anchor
        : next.anchor,
    head:
      moved?.head !== true && samePos(prevLive.head, nextLive.head)
        ? global.head
        : next.head,
  };
}
/** Whether both ends of the selection lie on lines of the loaded window, and
 *  neither is in a part of a line it does not hold (`holes`, when given). */
export function insideWindow(
  global: LineSelection,
  startLine: number,
  lineCount: number,
  holes?: WindowHoles,
): boolean {
  const end = startLine + lineCount;
  return (
    global.anchor.line >= startLine &&
    global.anchor.line < end &&
    global.head.line >= startLine &&
    global.head.line < end &&
    (holes === undefined || !hiddenEnd(global, holes))
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
/** What the loaded window's holes say about a global selection. Positions are
 *  global lines and columns. */
export interface WindowHoles {
  /** Whether the position lies strictly inside a part of a line the window
   *  does not hold. */
  hidden: (pos: LinePos) => boolean;
  /** Whether the selection's live range holds a placeholder, an end of it is
   *  hidden, or it is a caret on a line with a hole: its text in the window is
   *  not the text in the file. */
  hiddenText: (sel: LineSelection) => boolean;
  /** The selection the window was read focused on, null for an unfocused read
   *  or after a document change. */
  readFor: LineSelection | null;
}
/** Whether an end of the selection lies in a part of a line not loaded. */
export function hiddenEnd(sel: LineSelection, holes: WindowHoles): boolean {
  return holes.hidden(sel.anchor) || holes.hidden(sel.head);
}
/** Whether an operation on the selection runs in the core and not in the
 *  window: it is too large for one window, or it is not empty, has a hidden end
 *  and the window was read focused on it (a selection with a hidden end is first
 *  brought in by a read focused on it, so one that still has a hidden end
 *  spans more than a segment holds). A hidden caret is never core-op. Without
 *  `holes` only the size counts. */
export function coreOp(sel: LineSelection, holes?: WindowHoles): boolean {
  return (
    globalOpPath(sel) ||
    (holes !== undefined &&
      !samePos(sel.anchor, sel.head) &&
      hiddenEnd(sel, holes) &&
      sameSelection(holes.readFor, sel))
  );
}
/** What a key does to a caret next to a part of a line not loaded: 'run' acts
 *  in the window as it is, 'reload' first reads the window again around the
 *  caret, 'refuse' does nothing (see `reachDecision`). */
export type ReachDecision = 'run' | 'reload' | 'refuse';
/** Whether the loaded window can take the input replayed at the selection. A
 *  core-op selection is replayed in the window holding its head, with the other
 *  end clamped: the head must be on a loaded line and not hidden. Any other
 *  selection has both ends inside. Never when the queue's head is a key whose
 *  decision is to read the window again first (`decision`). */
export function replayReady(
  global: LineSelection,
  startLine: number,
  lineCount: number,
  holes?: WindowHoles,
  decision?: ReachDecision,
): boolean {
  if (decision === 'reload') {
    return false;
  }
  if (coreOp(global, holes)) {
    const line = global.head.line;
    return (
      line >= startLine &&
      line < startLine + lineCount &&
      (holes === undefined || !holes.hidden(global.head))
    );
  }
  return insideWindow(global, startLine, lineCount, holes);
}
/** What Replace does with the selection: 'here' replaces in the window, 'reveal'
 *  first reads a window focused on it, 'find' acts as Find Next. A selection too
 *  large for a window, or one a focused read did not bring in, is found. */
export function replaceRoute(
  sel: LineSelection,
  win: {
    startLine: number;
    lineCount: number;
    holes?: WindowHoles | undefined;
  },
  revealed: boolean,
): 'here' | 'reveal' | 'find' {
  if (insideWindow(sel, win.startLine, win.lineCount, win.holes)) {
    return 'here';
  }
  if (globalOpPath(sel) || revealed || coreOp(sel, win.holes)) {
    return 'find';
  }
  return 'reveal';
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
 *  moved (`moved`, by default the ends whose position differs), the queued
 *  caret's end for the others. */
export function queuedSelectEnds<T>(
  prev: { anchor: number; head: number },
  next: { anchor: number; head: number },
  convert: (pos: number) => T,
  caret: { anchor: T; head: T },
  moved: { anchor: boolean; head: boolean } = movedEnds(prev, next),
): { anchor: T; head: T } {
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
/** Whether a transaction is refused while an operation on the selection runs in
 *  the core (`core`, by default only a selection too large for one window): one
 *  a user action made that changes the document, whatever the action. Only the
 *  part inside the window would change. */
export function blockedWhileGlobal(
  tr: { docChanged: boolean; userEvent: string | undefined },
  global: LineSelection,
  core: boolean = globalOpPath(global),
): boolean {
  return tr.docChanged && tr.userEvent !== undefined && core;
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
