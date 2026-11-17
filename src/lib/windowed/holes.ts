// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
import {
  EditorSelection,
  EditorState,
  Prec,
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
  Transaction,
  type ChangeDesc,
  type Extension,
  type Line,
  type SelectionRange,
  type Text,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  WidgetType,
  type Command,
  type DecorationSet,
} from '@codemirror/view';
import {
  deleteCharBackward,
  deleteCharForward,
  deleteGroupBackward,
  deleteGroupForward,
  deleteLine,
  deleteLineBoundaryBackward,
  deleteLineBoundaryForward,
  deleteToLineEnd,
  deleteToLineStart,
} from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { byteLength, byteToCharAt, type HoleSpan } from '../util/windowedEdit';
import { textMatchesQuery } from '../util/windowedFind';
import {
  gotoSelection,
  sameSelection,
  toLiveSelection,
  type LinePos,
  type LineSelection,
  type ReachDecision,
  type WindowHoles,
} from '../util/windowSelection';
/** A window's lines that hold only part of their text: a placeholder character
 *  stands for each part not loaded, and a range of the document marks it. Pure
 *  logic over an `EditorState` that carries `holeExtensions`, so it unit-tests
 *  without a DOM. */
/** The character the core writes in place of a part not loaded. Only its
 *  position identifies a hole: the same character in the file is ordinary text. */
export const PLACEHOLDER = '\uFFFC';
/** A hole as the core's `windowed_read` reports it. */
export interface ReadHole {
  /** Window-local line. */
  line: number;
  /** UTF-16 index of the placeholder in the line's text. */
  at: number;
  /** UTF-8 bytes not loaded. */
  bytes: number;
  /** UTF-16 length of the bytes not loaded. */
  units: number;
  budget: boolean;
  in_view: boolean;
}
/** What a hole stands for. Text inserted at either edge of its range maps
 *  outside it. */
export class HoleValue extends RangeValue {
  override startSide = 1;
  override endSide = -1;
  constructor(
    readonly bytes: number,
    readonly units: number,
    readonly budget: boolean,
    readonly inView: boolean,
    /** The marker's text, built when the window was read. */
    readonly label: string,
  ) {
    super();
  }
  override eq(other: RangeValue): boolean {
    return (
      other instanceof HoleValue &&
      other.bytes === this.bytes &&
      other.units === this.units &&
      other.budget === this.budget &&
      other.inView === this.inView &&
      other.label === this.label
    );
  }
}
/** The range set of a read's holes in `doc`, a range `[p, p + 1)` per
 *  placeholder. */
export function holeSetOf(
  doc: Text,
  holes: readonly ReadHole[],
  label: (bytes: number) => string,
): RangeSet<HoleValue> {
  return RangeSet.of(
    holes.map((h) => {
      const from = doc.line(h.line + 1).from + h.at;
      return new HoleValue(
        h.bytes,
        h.units,
        h.budget,
        h.in_view,
        label(h.bytes),
      ).range(from, from + 1);
    }),
    true,
  );
}
const setHolesEffect = StateEffect.define<RangeSet<HoleValue>>();
/** The effect that replaces the field's holes with a set in the transaction's
 *  new coordinates. */
export function setHoles(set: RangeSet<HoleValue>): StateEffect<unknown> {
  return setHolesEffect.of(set);
}
/** The positions of the placeholders a change set replaces (a change with
 *  `toA > fromA` over `[p, p + 1)`). */
function replacedPlaceholders(
  set: RangeSet<HoleValue>,
  changes: ChangeDesc,
): Set<number> {
  const dropped = new Set<number>();
  changes.iterChangedRanges((fromA, toA) => {
    if (toA > fromA) {
      set.between(fromA, toA, (from, to) => {
        if (fromA <= from && toA >= to) {
          dropped.add(from);
        }
      });
    }
  });
  return dropped;
}
// A hole whose placeholder is replaced is gone: mapping alone would keep a
// range whose placeholder was replaced exactly over the inserted text.
const holeField = StateField.define<RangeSet<HoleValue>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    let next = set;
    if (tr.docChanged) {
      const dropped = replacedPlaceholders(next, tr.changes);
      if (dropped.size > 0) {
        next = next.update({ filter: (from) => !dropped.has(from) });
      }
      next = next.map(tr.changes);
    }
    for (const e of tr.effects) {
      if (e.is(setHolesEffect)) {
        next = e.value;
      }
    }
    return next;
  },
});
// The selection the state's window was read focused on; any document change
// ends it, since the read no longer shows what the selection stands on.
const readForField = StateField.define<LineSelection | null>({
  create: () => null,
  update: (value, tr) => (tr.docChanged ? null : value),
});
/** The holes of the state's window, in document order. */
export function holesOf(state: EditorState): RangeSet<HoleValue> {
  return state.field(holeField, false) ?? RangeSet.empty;
}
/** The selection the state's window was read focused on, global, or null. */
export function readForOf(state: EditorState): LineSelection | null {
  return state.field(readForField, false) ?? null;
}
/** A hole placed in a state's document. */
export interface PlacedHole {
  /** The placeholder's document position. */
  from: number;
  /** Window-local line, 0-based. */
  line: number;
  /** UTF-16 index of the placeholder in its line. */
  at: number;
  value: HoleValue;
}
/** The state's holes with their lines, in document order. */
export function placedHoles(state: EditorState): PlacedHole[] {
  const out: PlacedHole[] = [];
  holesOf(state).between(0, state.doc.length, (from, _to, value) => {
    const line = state.doc.lineAt(from);
    out.push({ from, line: line.number - 1, at: from - line.from, value });
  });
  return out;
}
/** The state's holes as the conversions between document and byte positions
 *  take them. */
export function holeSpans(state: EditorState): HoleSpan[] {
  const out: HoleSpan[] = [];
  holesOf(state).between(0, state.doc.length, (from, _to, value) => {
    out.push({ from, bytes: value.bytes });
  });
  return out;
}
/** The holes of one line, in order: the placeholder's index in the line and the
 *  UTF-16 length it stands for. */
function lineHoles(
  state: EditorState,
  line: Line,
): { at: number; units: number; bytes: number }[] {
  const out: { at: number; units: number; bytes: number }[] = [];
  holesOf(state).between(line.from, line.to, (from, to, value) => {
    if (from >= line.from && to <= line.to) {
      out.push({
        at: from - line.from,
        units: value.units,
        bytes: value.bytes,
      });
    }
  });
  return out;
}
/** A document position as a window-local line and a column of the real line:
 *  the loaded units before it plus the units of every hole before it. */
export function livePos(state: EditorState, pos: number): LinePos {
  const line = state.doc.lineAt(pos);
  const at = pos - line.from;
  let col = at;
  for (const h of lineHoles(state, line)) {
    if (h.at + 1 > at) {
      break;
    }
    col += h.units - 1;
  }
  return { line: line.number - 1, col };
}
/** The document position of a window-local line and real column. A column past
 *  the line end maps to the line end, a column strictly inside a hole to the
 *  hole's edge nearer to it in the file (the left one on a tie). */
export function docPos(state: EditorState, pos: LinePos): number {
  const line = state.doc.line(pos.line + 1);
  let extra = 0;
  for (const h of lineHoles(state, line)) {
    const start = h.at + extra;
    if (pos.col <= start) {
      break;
    }
    if (pos.col < start + h.units) {
      const left = pos.col - start <= start + h.units - pos.col;
      return line.from + (left ? h.at : h.at + 1);
    }
    extra += h.units - 1;
  }
  return line.from + Math.min(pos.col - extra, line.length);
}
/** The length in columns of a window-local line as it is in the file: its
 *  document length plus what each hole stands for beyond its placeholder. */
export function lineLength(state: EditorState, local: number): number {
  const line = state.doc.line(local + 1);
  let length = line.length;
  for (const h of lineHoles(state, line)) {
    length += h.units - 1;
  }
  return length;
}
/** Whether a window-local position lies strictly inside a hole: the column has
 *  no place in the document. A column at a hole's edge or past the line end is
 *  not hidden. */
export function hiddenAt(state: EditorState, pos: LinePos): boolean {
  const line = state.doc.line(pos.line + 1);
  let extra = 0;
  for (const h of lineHoles(state, line)) {
    const start = h.at + extra;
    if (pos.col <= start) {
      return false;
    }
    if (pos.col < start + h.units) {
      return true;
    }
    extra += h.units - 1;
  }
  return false;
}
/** Whether the document range `[from, to)` holds a placeholder. */
export function rangeHasPlaceholder(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  let found = false;
  holesOf(state).between(from, to, (hFrom) => {
    if (hFrom >= from && hFrom < to) {
      found = true;
      return false;
    }
    return undefined;
  });
  return found;
}
/** Which ends of a global selection lie inside a hole of the window that starts
 *  at global line `startLine`. */
export function hiddenEnds(
  state: EditorState,
  sel: LineSelection,
  startLine: number,
): { anchor: boolean; head: boolean } {
  const hiddenIn = (pos: LinePos): boolean => {
    const local = pos.line - startLine;
    return (
      local >= 0 &&
      local < state.doc.lines &&
      hiddenAt(state, { line: local, col: pos.col })
    );
  };
  return { anchor: hiddenIn(sel.anchor), head: hiddenIn(sel.head) };
}
/** What the state's holes say about a global selection, for the window that
 *  starts at global line `startLine`. */
export function windowHoles(
  state: EditorState,
  startLine: number,
): WindowHoles {
  const doc = state.doc;
  const hidden = (pos: LinePos): boolean =>
    hiddenEnds(state, { anchor: pos, head: pos }, startLine).head;
  return {
    hidden,
    hiddenText: (sel) => {
      if (hidden(sel.anchor) || hidden(sel.head)) {
        return true;
      }
      const live = toLiveSelection(sel, {
        startLine,
        lineCount: doc.lines,
        lineLength: (local) => lineLength(state, local),
      });
      const a = docPos(state, live.anchor);
      const b = docPos(state, live.head);
      if (rangeHasPlaceholder(state, Math.min(a, b), Math.max(a, b))) {
        return true;
      }
      const local = sel.head.line - startLine;
      return (
        sel.anchor.line === sel.head.line &&
        sel.anchor.col === sel.head.col &&
        local >= 0 &&
        local < doc.lines &&
        lineHoles(state, doc.line(local + 1)).length > 0
      );
    },
    readFor: readForOf(state),
  };
}
/** Where a global byte offset lies in a window: the document position, or null
 *  when the window does not hold it. An offset strictly inside a hole is
 *  outside, one inside a CRLF moves to the break's start. */
export function placeOffset(
  off: number,
  geometry: { startOffset: number; endOffset: number; endLine: number },
  totalLines: number,
  doc: string,
  breaks: readonly string[],
  holes: readonly HoleSpan[],
): number | null {
  const inside =
    off >= geometry.startOffset &&
    (off < geometry.endOffset ||
      (off === geometry.endOffset && geometry.endLine >= totalLines));
  if (!inside) {
    return null;
  }
  const rel = off - geometry.startOffset;
  const at = byteToCharAt(doc, breaks, rel, holes);
  if (at === 'hole') {
    return null;
  }
  if (at === 'crlf') {
    const before = byteToCharAt(doc, breaks, rel - 1, holes);
    return typeof before === 'number' ? before : 0;
  }
  return at;
}
/** Which ends of a pointer selection (or a Select All) moved. An end whose
 *  position changed moved. Where a kept global end is hidden the selection is
 *  made where that end is drawn, so its position does not tell: the head
 *  counts as moved, and both ends when the new selection is empty or comes from
 *  a Select All. */
export function pointerMoves(
  prev: { anchor: number; head: number },
  next: { anchor: number; head: number },
  hiddenEnds: { anchor: boolean; head: boolean },
  selectAll = false,
): { anchor: boolean; head: boolean } {
  const moved = {
    anchor: prev.anchor !== next.anchor,
    head: prev.head !== next.head,
  };
  if (!hiddenEnds.anchor && !hiddenEnds.head) {
    return moved;
  }
  const both = selectAll || next.anchor === next.head;
  return { anchor: moved.anchor || both, head: true };
}
/** The ends a selection transaction moves whatever their position says, when it
 *  is a pointer selection or a Select All made over a window with a hidden
 *  end: the ends `pointerMoves` gives. `startState` is the state before the
 *  transaction, `next` its new selection, `sel` the global selection before it.
 *  Undefined for any other transaction, or when no kept end is hidden. */
export function forcedMoves(s: {
  pointer: boolean;
  selectAll: boolean;
  startState: EditorState;
  next: { anchor: number; head: number };
  sel: LineSelection;
  startLine: number;
}): { anchor: boolean; head: boolean } | undefined {
  if (!s.pointer && !s.selectAll) {
    return undefined;
  }
  const hidden = hiddenEnds(s.startState, s.sel, s.startLine);
  if (!hidden.anchor && !hidden.head) {
    return undefined;
  }
  const prev = s.startState.selection.main;
  return pointerMoves(prev, s.next, hidden, s.selectAll);
}
/** A line of the window that holds only part of its text. */
export interface CutLine {
  /** Global line. */
  line: number;
  /** Which parts are not loaded: the start (`left`), the end (`right`), both,
   *  or the middle of the line (`mid`, after lines were joined). */
  shape: 'left' | 'right' | 'both' | 'mid';
  /** Bytes of the line's content before its loaded part, with a left hole. */
  leftBytes: number;
  /** The line's content in bytes, the parts not loaded included. */
  contentBytes: number;
}
/** The bytes of a line's content: its text without the placeholders, plus what
 *  they stand for. */
function contentBytesOf(
  line: Line,
  holes: readonly { bytes: number }[],
): number {
  let bytes = byteLength(line.text) - 3 * holes.length;
  for (const h of holes) {
    bytes += h.bytes;
  }
  return bytes;
}
/** The lines of the state's window with a hole, as global lines. */
export function cutLines(state: EditorState, startLine: number): CutLine[] {
  const out: CutLine[] = [];
  let at = 0;
  const placed = placedHoles(state);
  while (at < placed.length) {
    const first = placed[at];
    if (first === undefined) {
      break;
    }
    let end = at;
    while (placed[end + 1]?.line === first.line) {
      end += 1;
    }
    const group = placed.slice(at, end + 1);
    at = end + 1;
    const line = state.doc.line(first.line + 1);
    const only = group.length === 1;
    const lastAt = line.length - 1;
    let shape: CutLine['shape'] = 'mid';
    if (only && first.at === lastAt) {
      shape = 'right';
    } else if (only && first.at === 0) {
      shape = 'left';
    } else if (
      group.length === 2 &&
      first.at === 0 &&
      group[1]?.at === lastAt
    ) {
      shape = 'both';
    }
    out.push({
      line: first.line + startLine,
      shape,
      leftBytes: first.value.bytes,
      contentBytes: contentBytesOf(
        line,
        group.map((h) => h.value),
      ),
    });
  }
  return out;
}
/** A part of a line the read shows again: from byte `start` of the line's
 *  content, or up to byte `end`. */
export interface KeepEntry {
  /** Global line. */
  line: number;
  start?: number;
  end?: number;
}
/** What a read asks of the core besides its line range. */
export interface ReadArgs {
  focus?: LinePos;
  also?: LinePos;
  lead?: number;
  view?: [number, number];
  keep?: KeepEntry[];
}
/** What a window read is for. */
export type ReadMode =
  'goto' | 'reveal' | 'mount' | 'preserve' | 'reload' | 'budget' | 'click';
/** What `readRequest` takes. */
export interface ReadInput {
  mode: ReadMode;
  /** The line range the window covers, `[startLine, endLine)`, global. */
  range: { startLine: number; endLine: number };
  /** The lines on screen, `[first, end)`, global; null without a view. */
  screen: readonly [number, number] | null;
  /** Whether byte offsets inside lines are current (see `readRequest`). */
  keepAllowed: boolean;
  /** The lines of the installed view with a hole. */
  cuts: readonly CutLine[];
  /** `goto`: the line to show; `mount`: the line when no caret is restored. */
  target?: number;
  /** `reveal` and `budget`: the selection to read for. */
  sel?: LineSelection;
  /** `budget`: the read repeats the focus on `sel`. */
  focused?: boolean | undefined;
  /** `mount`: the restored caret, global. */
  caret?: LinePos | undefined;
  /** `click`: the line of the marker and what to show of it. */
  click?: { line: number; entry: KeepEntry } | undefined;
  /** A view nobody sees: no `view`, no `keep`. */
  shadow?: boolean;
}
/** The keep entry that shows a cut line's loaded part again, null for a shape
 *  that has no such part (a hole in the middle of the line). */
function keepOf(cut: CutLine): KeepEntry | null {
  if (cut.shape === 'right') {
    return { line: cut.line, start: 0 };
  }
  if (cut.shape === 'left') {
    return { line: cut.line, end: cut.contentBytes };
  }
  if (cut.shape === 'both') {
    return { line: cut.line, start: cut.leftBytes };
  }
  return null;
}
/** The request of one window read: the selection it is focused on (null for an
 *  unfocused read, which names the lines on screen instead) and the arguments
 *  for `windowed_read`. A focused read sends the head as `focus` and the anchor
 *  as `also`; `keep` shows every other cut line of the range as it was, and is
 *  sent only when `keepAllowed`. */
export function readRequest(input: ReadInput): {
  args: ReadArgs;
  readFor: LineSelection | null;
} {
  const { mode, range } = input;
  let readFor: LineSelection | null = null;
  if (mode === 'goto') {
    readFor = gotoSelection(input.target ?? range.startLine);
  } else if (mode === 'mount') {
    const caret = input.caret;
    readFor =
      caret !== undefined &&
      caret.line >= range.startLine &&
      caret.line < range.endLine
        ? { anchor: caret, head: caret }
        : gotoSelection(input.target ?? range.startLine);
  } else if (
    mode === 'reveal' ||
    (mode === 'budget' && input.focused === true)
  ) {
    readFor = input.sel ?? null;
  }
  const args: ReadArgs = {};
  if (readFor !== null) {
    args.focus = readFor.head;
    args.also = readFor.anchor;
  }
  const unfocused = mode !== 'goto' && mode !== 'reveal' && mode !== 'mount';
  if (input.shadow !== true && unfocused && input.screen !== null) {
    args.view = [input.screen[0], input.screen[1]];
  }
  if (mode === 'click' && input.click !== undefined) {
    args.lead = input.click.line;
  }
  if (input.shadow !== true && input.keepAllowed) {
    const skip = new Set<number>();
    if (readFor !== null) {
      skip.add(readFor.head.line);
      skip.add(readFor.anchor.line);
    }
    const keep: KeepEntry[] = [];
    for (const cut of input.cuts) {
      if (
        cut.line < range.startLine ||
        cut.line >= range.endLine ||
        skip.has(cut.line) ||
        input.click?.line === cut.line
      ) {
        continue;
      }
      const entry = keepOf(cut);
      if (entry !== null) {
        keep.push(entry);
      }
    }
    if (input.click !== undefined) {
      keep.push(input.click.entry);
      keep.sort((a, b) => a.line - b.line);
    }
    if (keep.length > 0) {
      args.keep = keep;
    }
  }
  return { args, readFor };
}
/** The bytes of a line's content before its `index`th hole: the loaded text
 *  before it plus what the holes before it stand for. */
function holeStart(
  line: Line,
  holes: readonly { at: number; bytes: number }[],
  index: number,
): number {
  const at = holes[index]?.at ?? 0;
  let start = byteLength(line.text.slice(0, at)) - 3 * index;
  for (const before of holes.slice(0, index)) {
    start += before.bytes;
  }
  return start;
}
/** The global line of the hole whose placeholder is at document position `from`
 *  and the byte of that line's content it starts at; null when no hole starts
 *  there. */
export function markerStart(
  state: EditorState,
  from: number,
  startLine: number,
): { line: number; start: number } | null {
  const line = state.doc.lineAt(from);
  const holes = lineHoles(state, line);
  const index = holes.findIndex((h) => h.at === from - line.from);
  return index < 0
    ? null
    : {
        line: line.number - 1 + startLine,
        start: holeStart(line, holes, index),
      };
}
/** The document position of the placeholder of the hole that starts at byte
 *  `start` of global line `line`; null when the window has no such hole. */
export function markerAtByte(
  state: EditorState,
  line: number,
  startLine: number,
  start: number,
): number | null {
  const local = line - startLine;
  if (local < 0 || local >= state.doc.lines) {
    return null;
  }
  const doc = state.doc.line(local + 1);
  const holes = lineHoles(state, doc);
  const index = holes.findIndex((_h, i) => holeStart(doc, holes, i) === start);
  const hole = holes[index];
  return hole === undefined ? null : doc.from + hole.at;
}
/** What a click on the marker of the hole at document position `from` asks of
 *  the core: the global line, what to show of it and whether the part shown is
 *  the one that ends at the hole's end. A hole followed on its line by loaded
 *  text shows the part before it, ending at its end; any other shows the part
 *  after it, starting at its start. Null when no hole starts there. */
export function markerRead(
  state: EditorState,
  from: number,
  startLine: number,
): { line: number; entry: KeepEntry; fromEnd: boolean } | null {
  const line = state.doc.lineAt(from);
  const holes = lineHoles(state, line);
  const at = from - line.from;
  const index = holes.findIndex((h) => h.at === at);
  const hole = holes[index];
  if (hole === undefined) {
    return null;
  }
  const start = holeStart(line, holes, index);
  const after = holes.length - index - 1;
  const loadedAfter = line.length - at - 1 - after > 0;
  const global = line.number - 1 + startLine;
  return loadedAfter
    ? {
        line: global,
        entry: { line: global, end: start + hole.bytes },
        fromEnd: true,
      }
    : { line: global, entry: { line: global, start }, fromEnd: false };
}
/** A hole of the window on screen, as the budget check reads it. */
export interface ScreenHole {
  /** Global line. */
  line: number;
  budget: boolean;
  inView: boolean;
}
/** Whether the window is read again because the budget left lines on screen
 *  cut, and whether that read repeats the focus: it does while the window is
 *  still the one read for the selection. */
export function budgetCheck(
  screen: readonly [number, number] | null,
  holes: readonly ScreenHole[],
  readFor: LineSelection | null,
  selection: LineSelection,
): { reread: boolean; focused: boolean } {
  const reread =
    screen !== null &&
    holes.some(
      (h) => h.budget && !h.inView && h.line >= screen[0] && h.line < screen[1],
    );
  return { reread, focused: reread && sameSelection(readFor, selection) };
}
/** Where the budget check is: waiting for the frames after a window install
 *  (`pending`), or free to run (`due`). */
export type BudgetPhase = 'idle' | 'pending' | 'due';
/** The phase after an event: an install makes the check pending, the timer
 *  queued after the install's frames makes a pending check due, and the end of
 *  the editor clears it. */
export function budgetPhase(
  phase: BudgetPhase,
  event: 'install' | 'timer' | 'gone',
): BudgetPhase {
  if (event === 'install') {
    return 'pending';
  }
  if (event === 'gone') {
    return 'idle';
  }
  return phase === 'pending' ? 'due' : phase;
}
/** The delete commands whose range can reach a placeholder when the caret is
 *  next to a part not loaded. */
export const REACHING_DELETES: ReadonlySet<Command> = new Set<Command>([
  deleteCharBackward,
  deleteCharForward,
  deleteGroupBackward,
  deleteGroupForward,
  deleteLineBoundaryBackward,
  deleteLineBoundaryForward,
]);
/** The commands that may remove a placeholder: each deletes to the end or start
 *  of a line, or the whole line, and the hidden bytes go with the placeholder. */
export const PLACEHOLDER_DELETES: ReadonlySet<Command> = new Set<Command>([
  deleteToLineEnd,
  deleteToLineStart,
  deleteLineBoundaryBackward,
  deleteLineBoundaryForward,
  deleteLine,
]);
/** The command a keydown runs, as far as the placeholder rules look at it: the
 *  first command of its chain that reaches a placeholder or may remove one, else
 *  the first of the chain, else the one a layout that names the key by another
 *  character resolves (`resolveCodeNamedKey`). */
export function recordedCommand(
  chain: readonly Command[],
  named: Command | null,
): Command | null {
  return (
    chain.find((c) => REACHING_DELETES.has(c) || PLACEHOLDER_DELETES.has(c)) ??
    chain[0] ??
    named
  );
}
/** Where a command moves to a line edge: the range of the caret, forward or
 *  backward. The view's `moveToLineBoundary`. */
export type LineBoundary = (
  range: SelectionRange,
  forward: boolean,
) => SelectionRange;
/** Whether a keydown is judged by the selection before it runs: the replay's
 *  guard passes, focus is in the editor, the window holds the selection, the key
 *  is not an input method's, and no composition is open or captured. */
export function reachGate(s: {
  guard: boolean;
  focusInEditor: boolean;
  inside: boolean;
  imeKey: boolean;
  composing: boolean;
  capturing: boolean;
}): boolean {
  return (
    s.guard &&
    s.focusInEditor &&
    s.inside &&
    !s.imeKey &&
    !s.composing &&
    !s.capturing
  );
}
/** Whether a delete command at the caret reaches into a part not loaded, and
 *  what to do: 'run' it when it does not (or, for a line-edge delete, when the
 *  window was read for the caret, so that edge is the real one), 'reload' the
 *  window around the caret first when it does and the window was read for
 *  another selection, 'refuse' it when it does and the window was read for the
 *  caret. `sel` is global, `startLine` the window's first line; the command runs
 *  on a state made for it, with no filter, so nothing is changed. */
export function reachDecision(
  state: EditorState,
  command: Command,
  sel: LineSelection,
  readFor: LineSelection | null,
  lineBoundary: LineBoundary,
  startLine = 0,
): ReachDecision {
  const local = sel.head.line - startLine;
  if (
    !REACHING_DELETES.has(command) ||
    sel.anchor.line !== sel.head.line ||
    sel.anchor.col !== sel.head.col ||
    local < 0 ||
    local >= state.doc.lines
  ) {
    return 'run';
  }
  const caret = docPos(state, { line: local, col: sel.head.col });
  const dry = EditorState.create({
    doc: state.doc,
    selection: EditorSelection.cursor(caret),
    extensions: [
      holeField.init(() => holesOf(state)),
      EditorState.tabSize.of(state.tabSize),
      indentUnit.of(state.facet(indentUnit)),
    ],
  });
  const out: { tr: Transaction | null } = { tr: null };
  command({
    state: dry,
    dispatch: (tr: Transaction) => {
      out.tr = tr;
    },
    moveToLineBoundary: lineBoundary,
  } as unknown as EditorView);
  const tr = out.tr;
  if (
    tr === null ||
    !(tr.isUserEvent('delete.backward') || tr.isUserEvent('delete.forward'))
  ) {
    return 'run';
  }
  // The holes of the caret's own line: a change that holds or touches one
  // (`from` or `to` at its edge) reaches it.
  const own = placedHoles(dry).filter(
    (h) => h.line === dry.doc.lineAt(caret).number - 1,
  );
  let reaches = false;
  tr.changes.iterChanges((fromA, toA) => {
    // A change that removes only a line break reaches nothing.
    if (toA - fromA === 1 && dry.doc.sliceString(fromA, toA) === '\n') {
      return;
    }
    if (own.some((h) => fromA <= h.from + 1 && toA >= h.from)) {
      reaches = true;
    }
  });
  if (!reaches) {
    return 'run';
  }
  if (!sameSelection(readFor, sel)) {
    return 'reload';
  }
  return command === deleteLineBoundaryBackward ||
    command === deleteLineBoundaryForward
    ? 'run'
    : 'refuse';
}
/** Whether a drag of the selection is refused: the browser would carry the
 *  loaded text only, so a selection that holds a placeholder or has an end in a
 *  part not loaded (`hiddenEnd`) is not dragged. */
export function dragRefused(state: EditorState, hiddenEnd: boolean): boolean {
  const main = state.selection.main;
  return hiddenEnd || rangeHasPlaceholder(state, main.from, main.to);
}
/** The range Replace acts on: the main selection when it is a hit of the query
 *  that holds no placeholder (its text in the window is not the file's, so it
 *  is not known to match); null otherwise. */
export function replaceTarget(
  state: EditorState,
  query: string,
  caseSensitive: boolean,
): { from: number; to: number } | null {
  const { from, to, empty } = state.selection.main;
  if (
    empty ||
    rangeHasPlaceholder(state, from, to) ||
    !textMatchesQuery(state.sliceDoc(from, to), query, caseSensitive)
  ) {
    return null;
  }
  return { from, to };
}
/** The goto box's parsed input. */
export type GotoTarget =
  | { kind: 'line'; line: number }
  | { kind: 'range'; range: { start: number; end: number } };
/** A request that waits for the end of an input-method composition, in the form
 *  it was made: the goto box with its parsed target, a goto by line, a find hit
 *  as the call that produced it, Replace, a marker click as the hole's global
 *  line and the byte its hole starts at (valid while the same window is
 *  installed, `installs`). */
export type KeptRequest =
  | { kind: 'goto'; line: number }
  | { kind: 'panel'; target: GotoTarget }
  | { kind: 'find'; backward: boolean }
  | { kind: 'result'; index: number }
  | { kind: 'replace' }
  | { kind: 'marker'; line: number; start: number; installs: number };
/** The list of kept requests after `request` was made: added when a composition
 *  is open or captured (`composing`), which then leaves the selection alone;
 *  otherwise unchanged and `kept` false, so the request runs now. A request the
 *  list itself runs (`fromList`) is never kept again. An undo's jump is no
 *  request and never comes here. */
export function keptRequest(
  list: readonly KeptRequest[],
  request: KeptRequest,
  composing: boolean,
  fromList = false,
): { kept: boolean; list: readonly KeptRequest[] } {
  return composing && !fromList
    ? { kept: true, list: [...list, request] }
    : { kept: false, list };
}
/** What the list does the moment it may run (after the composition's end, once
 *  the replay has settled): 'drop' it when the editor is locked or gone, 'wait'
 *  when a new composition has begun (its end runs the list again), 'retry' when
 *  a hold keeps the editor busy (its release runs the list again), else 'run'
 *  its first request. A list released without a `compositionend` ignores the
 *  view's own composing flag, which never cleared, unless a composition began
 *  after the release (`renewed`); a capture it never ignores. */
export function keptListStep(s: {
  gone: boolean;
  locked: boolean;
  /** The view is composing, captured or not. */
  composing: boolean;
  /** A capture is open. */
  capturing: boolean;
  released: boolean;
  /** A composition has begun since the list was released. */
  renewed: boolean;
  held: boolean;
}): 'drop' | 'wait' | 'retry' | 'run' {
  if (s.gone || s.locked) {
    return 'drop';
  }
  if (s.capturing || (s.composing && (!s.released || s.renewed))) {
    return 'wait';
  }
  return s.held ? 'retry' : 'run';
}
/** What `runKeptList` asks of the editor. */
export interface KeptHost {
  get: () => readonly KeptRequest[];
  set: (list: readonly KeptRequest[]) => void;
  /** Resolves once no swap runs and nothing is queued; false when the editor
   *  cannot take a request (locked, gone, or held by whole-file work). */
  settled: () => Promise<boolean>;
  gone: () => boolean;
  locked: () => boolean;
  /** A hold keeps the editor busy. */
  held: () => boolean;
  /** The view is composing, captured or not. */
  composing: () => boolean;
  /** A capture is open. */
  capturing: () => boolean;
  /** A composition has begun since the list was released. */
  renewed: () => boolean;
  /** Runs one request, which is never kept again; resolves once its window is
   *  on its way. */
  run: (request: KeptRequest) => Promise<void>;
}
/** Run the kept requests in order, each once, after the editor has settled (see
 *  `keptListStep` for what stops the list). Requests that were not run stay in
 *  the list for the next run. */
export async function runKeptList(
  host: KeptHost,
  released: boolean,
): Promise<void> {
  while (host.get().length > 0) {
    const ready = await host.settled();
    const step = keptListStep({
      gone: host.gone(),
      locked: host.locked(),
      composing: host.composing(),
      capturing: host.capturing(),
      released,
      renewed: host.renewed(),
      held: !ready && host.held(),
    });
    if (step === 'drop') {
      host.set([]);
    }
    const [next, ...rest] = host.get();
    if (step !== 'run' || next === undefined) {
      return;
    }
    host.set(rest);
    await host.run(next);
  }
}
/** The one timer that runs the list: a moment after a composition's end, so its
 *  last text has arrived, or at once when a hold ends. Several asks make one
 *  run, which is `released` when any of them was (a composition that ended
 *  without a `compositionend`). */
export function keptSchedule(run: (released: boolean) => void): {
  schedule: (delay: number, released: boolean) => void;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let released = false;
  let closed = false;
  return {
    schedule(delay, release) {
      released ||= release;
      if (timer !== undefined || closed) {
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        const asked = released;
        released = false;
        run(asked);
      }, delay);
    },
    cancel() {
      closed = true;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
/** The document position of the marker a kept request names, null when it is
 *  dropped: another window has been installed since, or no hole starts at its
 *  byte. */
export function keptMarkerPos(
  request: Extract<KeptRequest, { kind: 'marker' }>,
  state: EditorState,
  startLine: number,
  installs: number,
): number | null {
  return request.installs === installs
    ? markerAtByte(state, request.line, startLine, request.start)
    : null;
}
/** Where a part that ends at the end of a hole's range ends on its line: just
 *  before the line's right placeholder, or at the line end when it has none. */
export function newPartEnd(
  state: EditorState,
  line: { from: number; to: number },
): number {
  if (line.to === line.from) {
    return line.to;
  }
  let right = false;
  holesOf(state).between(line.to - 1, line.to, (from, to) => {
    right ||= from === line.to - 1 && to === line.to;
  });
  return right ? line.to - 1 : line.to;
}
/** Whether a replayed key runs the command it was recorded with directly on
 *  the view: only a key the reaching-delete path queued (`reaching`) that the
 *  scope did not handle and no binding names (`chainLength` 0). Every other
 *  replayed key behaves as it did before holes. */
export function runsRecordedCommand(
  handled: boolean,
  reaching: boolean,
  chainLength: number,
): boolean {
  return !handled && reaching && chainLength === 0;
}
/** What the extensions of `holeExtensions` need from the editor. */
export interface HoleDeps {
  /** A click on the marker of the hole whose placeholder is at `pos`. */
  onMarker: (view: EditorView, pos: number) => void;
  /** The command of the key being handled, null outside one. */
  recordedCommand?: () => Command | null;
  /** An end of the global selection lies in a part not loaded. */
  hiddenEnd?: () => boolean;
}
/** The document position of the hole `value` in the state, null when it is
 *  gone. */
function positionOf(state: EditorState, value: HoleValue): number | null {
  let found: number | null = null;
  holesOf(state).between(0, state.doc.length, (from, _to, v) => {
    if (v === value) {
      found = from;
      return false;
    }
    return undefined;
  });
  return found;
}
/** The marker drawn over a placeholder. It never lets an event move the
 *  selection; a primary-button press with one click loads the next part. */
class HoleWidget extends WidgetType {
  constructor(
    readonly value: HoleValue,
    readonly deps: HoleDeps,
  ) {
    super();
  }
  override eq(other: WidgetType): boolean {
    return other instanceof HoleWidget && other.value === this.value;
  }
  override toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-hole-marker';
    el.textContent = this.value.label;
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (e.button === 0 && e.detail === 1) {
        const pos = positionOf(view.state, this.value);
        if (pos !== null) {
          this.deps.onMarker(view, pos);
        }
      }
    });
    return el;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}
function holeDecorations(
  set: RangeSet<HoleValue>,
  deps: HoleDeps,
): DecorationSet {
  const ranges = [];
  for (const cursor = set.iter(); cursor.value !== null; cursor.next()) {
    ranges.push(
      Decoration.replace({
        widget: new HoleWidget(cursor.value, deps),
      }).range(cursor.from, cursor.to),
    );
  }
  return Decoration.set(ranges);
}
const holeTheme = EditorView.baseTheme({
  '.cm-hole-marker': {
    color: 'var(--e-fg)',
    opacity: '0.6',
    border: '1px solid var(--topbar-border)',
  },
});
/** The filters and handlers that keep an edit, a copy or a drag from acting
 *  on a placeholder as if it were text: the delete filter, the line-text
 *  filter, the drop filter and the drag refusal belong here. */
function holeFilters(deps: HoleDeps): Extension {
  const removes = (state: EditorState, tr: Transaction): boolean => {
    let found = false;
    tr.changes.iterChanges((fromA, toA) => {
      if (toA > fromA && rangeHasPlaceholder(state, fromA, toA)) {
        found = true;
      }
    });
    return found;
  };
  const touchesHole = (
    state: EditorState,
    from: number,
    to: number,
  ): boolean => {
    let found = false;
    holesOf(state).between(
      state.doc.lineAt(from).from,
      state.doc.lineAt(to).to,
      () => {
        found = true;
        return false;
      },
    );
    return found;
  };
  return [
    // A user delete that removes a placeholder from a caret acts on text that
    // is not there; the line-edge deletes remove the hidden bytes with it.
    EditorState.transactionFilter.of((tr) => {
      if (
        !tr.docChanged ||
        tr.annotation(Transaction.userEvent) === undefined ||
        !tr.startState.selection.ranges.every((r) => r.empty)
      ) {
        return tr;
      }
      const command = deps.recordedCommand?.() ?? null;
      if (command !== null && PLACEHOLDER_DELETES.has(command)) {
        return tr;
      }
      return removes(tr.startState, tr) ? [] : tr;
    }),
    // Move Line, Copy Line and Transpose copy or swap whole lines and the
    // characters around the caret: not with a line that has a hole.
    EditorState.transactionFilter.of((tr) => {
      const lines =
        tr.isUserEvent('move.line') || tr.isUserEvent('input.copyline');
      if (!tr.docChanged || !(lines || tr.isUserEvent('move.character'))) {
        return tr;
      }
      const start = tr.startState;
      if (lines) {
        for (const range of start.selection.ranges) {
          let last = start.doc.lineAt(range.to);
          if (!range.empty && range.to === last.from) {
            last = start.doc.lineAt(range.to - 1);
          }
          if (touchesHole(start, range.from, last.to)) {
            return [];
          }
        }
      }
      let touched = false;
      tr.changes.iterChangedRanges((fromA, toA) => {
        touched = touched || touchesHole(start, fromA, toA);
      });
      return touched ? [] : tr;
    }),
    // A native drag carries the loaded text only, and a window swap during it
    // leaves the dragged range stale.
    EditorState.transactionFilter.of((tr) =>
      tr.isUserEvent('move.drop') && removes(tr.startState, tr) ? [] : tr,
    ),
    Prec.highest(
      EditorView.domEventHandlers({
        dragstart(event, view) {
          if (!dragRefused(view.state, deps.hiddenEnd?.() ?? false)) {
            return false;
          }
          // The press then makes a new selection, as one that started no drag.
          event.preventDefault();
          return true;
        },
      }),
    ),
  ];
}
/** Everything a state needs to hold a window with holes: the two fields, the
 *  marker decorations (ahead of `highlightSpecialChars`, whose default set
 *  includes the placeholder character), the atomic ranges and the filters.
 *  `readFor` is the selection the window was read focused on. */
export function holeExtensions(
  holes: RangeSet<HoleValue>,
  readFor: LineSelection | null,
  deps: HoleDeps,
): Extension {
  return [
    holeField.init(() => holes),
    readForField.init(() => readFor),
    Prec.highest(
      EditorView.decorations.from(holeField, (set) =>
        holeDecorations(set, deps),
      ),
    ),
    EditorView.atomicRanges.of((view) => view.state.field(holeField)),
    holeTheme,
    holeFilters(deps),
  ];
}
