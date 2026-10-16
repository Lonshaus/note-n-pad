// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Decisions of the windowed editor's input replay: which keydowns are queued
// (typed text, key commands, AltGr characters, chords) and replayed once the
// window is back on the selection, and the clipboard rules that go with it.
// Free of the DOM and Tauri, so it unit-tests in isolation.

import { EditorSelection, type EditorState } from '@codemirror/state';
import type { TransactionSpec } from '@codemirror/state';
import type { Command, KeyBinding } from '@codemirror/view';
import {
  cursorCharLeft,
  cursorCharRight,
  cursorLineBoundaryBackward,
  cursorLineBoundaryForward,
  cursorLineDown,
  cursorLineUp,
  cursorMatchingBracket,
  cursorPageDown,
  deleteCharBackward,
  deleteCharForward,
  deleteGroupBackward,
  deleteToLineEnd,
  indentLess,
  indentMore,
  selectCharLeft,
  selectCharRight,
  selectLineBoundaryBackward,
  selectLineBoundaryForward,
  selectLineDown,
  selectLineUp,
  selectMatchingBracket,
  transposeChars,
} from '@codemirror/commands';
import {
  isEditingKey,
  replayKind,
  type ReplayKeyEvent,
} from './windowSelection';
/** What decides whether typed input is queued for the replay. */
export interface ReplayState {
  locked: boolean;
  /** Focus is in another element than the editor (or `body`). */
  focusElsewhere: boolean;
  /** Whole-file work that refuses typed input: a replace all pass. */
  dropHold: boolean;
  /** Work that queues typed input until it is over: an undo or a redo. */
  queueHold: boolean;
  swapping: boolean;
  /** Something is queued, or the swap that replays it is running. */
  replayPending: boolean;
  /** The selection lies outside the loaded window (and fits one). */
  outside: boolean;
}
/** Whether input should be handled by the replay: the selection is outside the
 *  window, a replay is running, or an undo/redo is under way. A plain window
 *  swap, a replace all pass and a locked editor refuse input instead. */
export function replayWanted(s: ReplayState): boolean {
  if (
    s.locked ||
    s.focusElsewhere ||
    s.dropHold ||
    (s.swapping && !s.replayPending && !s.queueHold)
  ) {
    return false;
  }
  return s.replayPending || s.queueHold || s.outside;
}
/** The keys' AltGr characters, by `KeyboardEvent.code`, as the Rust
 *  `altgr_table` command reports them. A code without an entry types nothing
 *  under Ctrl+Alt. */
export interface AltGrEntry {
  ctrl_alt: string;
  ctrl_alt_shift: string;
}
export type AltGrTable = Readonly<Record<string, AltGrEntry>>;
/** A keydown as far as the key-name rules look at it. */
export interface KeyLike {
  key: string;
  keyCode: number;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}
/** The character a Windows Ctrl+Alt keydown types, or null when it is a
 *  shortcut: the keydown's `key` must be what the layout types for its
 *  physical key at its Shift state. Without a table every Ctrl+Alt is a
 *  shortcut. */
export function altGrText(
  e: KeyLike & { code: string },
  isWindows: boolean,
  table: AltGrTable | null,
): string | null {
  if (!isWindows || table === null || !e.ctrlKey || !e.altKey || e.metaKey) {
    return null;
  }
  const entry = table[e.code];
  if (entry === undefined) {
    return null;
  }
  const typed = e.shiftKey ? entry.ctrl_alt_shift : entry.ctrl_alt;
  return typed !== '' && e.key === typed ? typed : null;
}
/** The commands a chord is replayed for when it is a no-op at the window edge
 *  (the caret outside the window sits there): moves, selections, deletions
 *  and the other edits an Emacs-style or rebound key can run. */
export const EDGE_COMMANDS: ReadonlySet<Command> = new Set<Command>([
  cursorCharLeft,
  cursorCharRight,
  cursorLineUp,
  cursorLineDown,
  cursorLineBoundaryBackward,
  cursorLineBoundaryForward,
  cursorPageDown,
  selectCharLeft,
  selectCharRight,
  selectLineUp,
  selectLineDown,
  selectLineBoundaryBackward,
  selectLineBoundaryForward,
  deleteCharBackward,
  deleteCharForward,
  deleteGroupBackward,
  deleteToLineEnd,
  transposeChars,
  indentLess,
  indentMore,
  cursorMatchingBracket,
  selectMatchingBracket,
]);
/** Key names by key code, as the keys type unshifted and shifted. */
const BASE_CODES: Record<number, string> = {
  186: ';',
  187: '=',
  188: ',',
  189: '-',
  190: '.',
  191: '/',
  192: '`',
  219: '[',
  220: '\\',
  221: ']',
  222: "'",
};
const SHIFT_CODES: Record<number, string> = {
  186: ':',
  187: '+',
  188: '<',
  189: '_',
  190: '>',
  191: '?',
  192: '~',
  219: '{',
  220: '|',
  221: '}',
  222: '"',
};
const SHIFTED_DIGITS = ')!@#$%^&*(';

function keyCodeName(keyCode: number, shift: boolean): string | undefined {
  if (keyCode >= 48 && keyCode <= 57) {
    return shift ? SHIFTED_DIGITS[keyCode - 48] : String.fromCharCode(keyCode);
  }
  if (keyCode >= 65 && keyCode <= 90) {
    const letter = String.fromCharCode(keyCode);
    return shift ? letter : letter.toLowerCase();
  }
  return (shift ? SHIFT_CODES : BASE_CODES)[keyCode];
}
/** CodeMirror's name for the key of a keydown. */
function eventName(e: KeyLike, os: string): string {
  // Command+Shift on macOS makes `key` the shifted character; CodeMirror
  // reads the key code instead.
  const ignoreKey =
    os === 'macos' && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey;
  const name =
    (!ignoreKey && e.key !== 'Unidentified' && e.key) ||
    keyCodeName(e.keyCode, e.shiftKey) ||
    e.key ||
    'Unidentified';
  return name === 'Esc' ? 'Escape' : name;
}

function withModifiers(name: string, e: KeyLike, shift: boolean): string {
  let result = name;
  if (e.altKey) {
    result = `Alt-${result}`;
  }
  if (e.ctrlKey) {
    result = `Ctrl-${result}`;
  }
  if (e.metaKey) {
    result = `Meta-${result}`;
  }
  if (shift && e.shiftKey) {
    result = `Shift-${result}`;
  }
  return result;
}
/** The names CodeMirror looks a keydown up under, in the order it tries them. */
export function eventKeyNames(e: KeyLike, os: string): string[] {
  const name = eventName(e, os);
  const isChar = [...name].length === 1 && name !== ' ';
  const names = [withModifiers(name, e, !isChar)];
  const base = keyCodeName(e.keyCode, false);
  if (
    isChar &&
    (e.altKey || e.metaKey || e.ctrlKey) &&
    // Ctrl+Alt may be AltGr on Windows; Option characters are typed on macOS.
    !(os === 'windows' && e.ctrlKey && e.altKey) &&
    !(os === 'macos' && e.altKey && !(e.ctrlKey || e.metaKey)) &&
    base !== undefined &&
    base !== name
  ) {
    names.push(withModifiers(base, e, true));
    const shifted = keyCodeName(e.keyCode, true);
    if (
      e.shiftKey &&
      shifted !== undefined &&
      shifted !== name &&
      shifted !== base
    ) {
      names.push(withModifiers(shifted, e, false));
    }
  } else if (isChar && e.shiftKey) {
    names.push(withModifiers(name, e, true));
  }
  return names;
}
/** A key name in CodeMirror's canonical spelling (modifiers in one fixed order
 *  and alias), or null when it names a key sequence or an unknown modifier. */
function normalizeName(name: string, os: string): string | null {
  if (name.includes(' ') && name !== ' ') {
    return null;
  }
  const parts = name.split(/-(?!$)/);
  let key = parts[parts.length - 1] ?? '';
  if (key === 'Space') {
    key = ' ';
  }
  let alt = false;
  let ctrl = false;
  let shift = false;
  let meta = false;
  for (const part of parts.slice(0, -1)) {
    if (/^(cmd|meta|m)$/i.test(part)) {
      meta = true;
    } else if (/^a(lt)?$/i.test(part)) {
      alt = true;
    } else if (/^(c|ctrl|control)$/i.test(part)) {
      ctrl = true;
    } else if (/^s(hift)?$/i.test(part)) {
      shift = true;
    } else if (/^mod$/i.test(part)) {
      if (os === 'macos') {
        meta = true;
      } else {
        ctrl = true;
      }
    } else {
      return null;
    }
  }
  if (alt) {
    key = `Alt-${key}`;
  }
  if (ctrl) {
    key = `Ctrl-${key}`;
  }
  if (meta) {
    key = `Meta-${key}`;
  }
  if (shift) {
    key = `Shift-${key}`;
  }
  return key;
}
/** Bindings in the order CodeMirror ranks them, highest precedence first. */
export type KeyLayers = readonly (readonly KeyBinding[])[];
/** Every command a keydown falls through, in the order CodeMirror runs them:
 *  for each name it is looked up under, the commands of the matching bindings
 *  of every layer from the highest precedence down. Only the editor scope. */
export function commandChain(
  layers: KeyLayers,
  e: KeyLike,
  os: string,
): Command[] {
  const chain: Command[] = [];
  for (const name of eventKeyNames(e, os)) {
    for (const layer of layers) {
      for (const binding of layer) {
        const scopes = (binding.scope ?? 'editor').split(' ');
        const raw =
          (os === 'macos'
            ? binding.mac
            : os === 'windows'
              ? binding.win
              : binding.linux) ?? binding.key;
        if (!scopes.includes('editor') || raw === undefined) {
          continue;
        }
        const own = normalizeName(raw, os);
        if (own === null) {
          continue;
        }
        if (own === name && binding.run !== undefined) {
          chain.push(binding.run);
        }
        if (`Shift-${own}` === name && binding.shift !== undefined) {
          chain.push(binding.shift);
        }
      }
    }
  }
  return chain;
}
/** Whether the keydown matches a key binding of the editor. */
export function matchesBinding(
  layers: KeyLayers,
  e: KeyLike,
  os: string,
): boolean {
  return commandChain(layers, e, os).length > 0;
}
/** Whether a chord that left no transaction at the window edge is replayed once
 *  the window is back: when any command it falls through is an edge command,
 *  or it is an editing key (arrows, Home, Backspace and the like) held with
 *  Ctrl or Meta. The commands in `never` (undo, the tab-focus toggle) are not
 *  replayed whatever key they are bound to. */
export function chordReplaysAtEdge(
  layers: KeyLayers,
  e: KeyLike,
  os: string,
  never: ReadonlySet<Command>,
): boolean {
  const chain = commandChain(layers, e, os);
  if (chain.some((command) => never.has(command))) {
    return false;
  }
  return (
    chain.some((command) => EDGE_COMMANDS.has(command)) || isEditingKey(e.key)
  );
}
/** The windowed editor's own keys, besides the shared keymap: Escape closes
 *  the find box, Select All takes the visible lines, undo and redo go to the
 *  journal in the core. */
export function coreKeyBindings(commands: {
  closeBox: Command;
  selectVisible: Command;
  undo: Command;
  redo: Command;
}): KeyBinding[] {
  return [
    { key: 'Escape', run: commands.closeBox },
    { key: 'Mod-a', preventDefault: true, run: commands.selectVisible },
    { key: 'Mod-z', preventDefault: true, run: commands.undo },
    { key: 'Mod-Shift-z', preventDefault: true, run: commands.redo },
  ];
}
/** What a keydown does while the replay may be wanted. */
export type KeyAction =
  | { type: 'none' }
  | { type: 'text'; text: string }
  /** Replay the key command later. */
  | { type: 'key' };

export interface KeyDecisionInput {
  event: KeyLike &
    ReplayKeyEvent & {
      code: string;
    };
  os: string;
  state: ReplayState;
  /** The drain is running (it may be waiting on the clipboard). */
  draining: boolean;
  altGr: AltGrTable | null;
  /** The editor's bindings; asked for only when a chord needs them. */
  layers: () => KeyLayers;
}
/** How a keydown is handled by the replay. */
export function decideKey(i: KeyDecisionInput): KeyAction {
  const e = i.event;
  if (!replayWanted(i.state)) {
    return { type: 'none' };
  }
  const isWindows = i.os === 'windows';
  const kind = replayKind(e, isWindows);
  if (kind === 'text') {
    return { type: 'text', text: e.key };
  }
  if (kind === 'key') {
    return { type: 'key' };
  }
  if (kind === 'chord' && (i.state.replayPending || i.state.queueHold)) {
    const typed = altGrText(e, isWindows, i.altGr);
    if (typed !== null) {
      return { type: 'text', text: typed };
    }
    // The queue must run in order: an editor shortcut pressed while it drains
    // or while an undo/redo is under way (another undo included) waits behind
    // what is already queued, a menu accelerator does not.
    if (
      (i.draining || i.state.queueHold) &&
      matchesBinding(i.layers(), e, i.os)
    ) {
      return { type: 'key' };
    }
  }
  return { type: 'none' };
}
/** What CodeMirror's copy takes from the selection: the selected texts, or with
 *  only empty ranges the text of each caret line (once per line), whose range
 *  is the line and its break. */
export function copiedRange(state: EditorState): {
  text: string;
  ranges: { from: number; to: number }[];
  linewise: boolean;
} {
  const content: string[] = [];
  const ranges: { from: number; to: number }[] = [];
  for (const range of state.selection.ranges) {
    if (!range.empty) {
      content.push(state.sliceDoc(range.from, range.to));
      ranges.push({ from: range.from, to: range.to });
    }
  }
  let linewise = false;
  if (content.length === 0) {
    let upto = -1;
    for (const { from } of state.selection.ranges) {
      const line = state.doc.lineAt(from);
      if (line.number > upto) {
        content.push(line.text);
        ranges.push({
          from: line.from,
          to: Math.min(state.doc.length, line.to + 1),
        });
      }
      upto = line.number;
    }
    linewise = true;
  }
  return { text: content.join(state.lineBreak), ranges, linewise };
}
/** The line-wise text a copy leaves for the next paste: the copied text when
 *  nothing was selected, nothing otherwise. */
export function linewiseAfterCopy(copied: {
  text: string;
  linewise: boolean;
}): string | null {
  return copied.linewise ? copied.text : null;
}
/** Whether a paste of `text` inserts whole lines above the caret lines: the
 *  text is what the last copy took with nothing selected, and nothing is
 *  selected now. */
export function pasteIsLinewise(
  state: EditorState,
  text: string,
  remembered: string | null,
): boolean {
  return (
    remembered !== null &&
    state.selection.ranges.every((range) => range.empty) &&
    remembered === state.toText(text).toString()
  );
}
/** CodeMirror's paste of `text`: a line-wise paste inserts each line above its
 *  caret line, anything else replaces the selection. */
export function pasteSpec(
  state: EditorState,
  text: string,
  remembered: string | null,
): TransactionSpec {
  if (!pasteIsLinewise(state, text, remembered)) {
    return state.replaceSelection(text);
  }
  const pasted = state.toText(text);
  const byLine = pasted.lines === state.selection.ranges.length;
  let next = 1;
  let lastLine = -1;
  return state.changeByRange((range) => {
    const line = state.doc.lineAt(range.from);
    if (line.from === lastLine) {
      return { range };
    }
    lastLine = line.from;
    const insert = state.toText(
      (byLine ? pasted.line(next++).text : text) + state.lineBreak,
    );
    return {
      changes: { from: line.from, insert },
      range: EditorSelection.cursor(range.from + insert.length, -1),
    };
  });
}
