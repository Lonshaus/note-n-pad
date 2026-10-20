// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Builds the editors' key bindings from the shortcuts the Rust core says are
// in effect. Every command the user can rebind is taken out of CodeMirror's
// stock keymaps and bound again at the key the registry holds; everything else
// in those keymaps stays exactly as CodeMirror ships it.

import { Prec, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  type Command,
  type KeyBinding,
} from '@codemirror/view';
import {
  addCursorAbove,
  addCursorBelow,
  cursorLineStart,
  cursorMatchingBracket,
  copyLineDown,
  copyLineUp,
  defaultKeymap,
  deleteLine,
  deleteTrailingWhitespace,
  historyKeymap,
  indentLess,
  indentMore,
  indentSelection,
  insertBlankLine,
  lineComment,
  lineUncomment,
  moveLineDown,
  moveLineUp,
  redoSelection,
  selectLine,
  selectMatchingBracket,
  selectParentSyntax,
  toggleBlockComment,
  toggleComment,
  toggleTabFocusMode,
  undoSelection,
} from '@codemirror/commands';
import {
  foldAll,
  foldCode,
  foldKeymap,
  unfoldAll,
  unfoldCode,
} from '@codemirror/language';
import {
  gotoLine,
  searchKeymap,
  selectNextOccurrence,
  selectSelectionMatches,
} from '@codemirror/search';
import {
  closeBracketsKeymap,
  completionKeymap,
  startCompletion,
} from '@codemirror/autocomplete';
import {
  namedKey,
  isComposingKey,
  namedKeyFromCode,
  splitAccelerator,
  type KeyLike,
} from '../util/accelerator';
import { offscreenArrowKeys } from './offscreenArrow';
/** Which editor a keymap is for: the document editor, the sticky note editor,
 *  or the editor of a windowed (very large) file. */
export type KeymapProfile = 'document' | 'sticky' | 'windowed';

interface RebindableCommand {
  /** The registry id the key comes from. */
  id: string;
  run: Command;
  profiles: readonly KeymapProfile[];
  /** Bound at the highest precedence, beside the completion list's own keys. */
  highest?: true;
}

const EVERY: readonly KeymapProfile[] = ['document', 'sticky', 'windowed'];
const TEXT: readonly KeymapProfile[] = ['document', 'sticky'];
const DOCUMENT: readonly KeymapProfile[] = ['document'];
/** Every editor command whose key the user can change. */
export const REBINDABLE: readonly RebindableCommand[] = [
  { id: 'goto-line', run: gotoLine, profiles: TEXT },
  { id: 'editor.move-line-up', run: moveLineUp, profiles: EVERY },
  { id: 'editor.move-line-down', run: moveLineDown, profiles: EVERY },
  { id: 'editor.copy-line-up', run: copyLineUp, profiles: EVERY },
  { id: 'editor.copy-line-down', run: copyLineDown, profiles: EVERY },
  { id: 'editor.add-cursor-above', run: addCursorAbove, profiles: EVERY },
  { id: 'editor.add-cursor-below', run: addCursorBelow, profiles: EVERY },
  { id: 'editor.insert-line-below', run: insertBlankLine, profiles: EVERY },
  { id: 'editor.select-line', run: selectLine, profiles: EVERY },
  { id: 'editor.expand-selection', run: selectParentSyntax, profiles: EVERY },
  { id: 'editor.outdent', run: indentLess, profiles: EVERY },
  { id: 'editor.indent', run: indentMore, profiles: EVERY },
  { id: 'editor.reindent', run: indentSelection, profiles: EVERY },
  { id: 'editor.delete-line', run: deleteLine, profiles: EVERY },
  { id: 'editor.go-to-bracket', run: cursorMatchingBracket, profiles: EVERY },
  { id: 'editor.toggle-line-comment', run: toggleComment, profiles: EVERY },
  {
    id: 'editor.toggle-block-comment',
    run: toggleBlockComment,
    profiles: EVERY,
  },
  { id: 'editor.toggle-tab-focus', run: toggleTabFocusMode, profiles: EVERY },
  { id: 'editor.cursor-undo', run: undoSelection, profiles: TEXT },
  { id: 'editor.cursor-redo', run: redoSelection, profiles: TEXT },
  {
    id: 'editor.add-next-occurrence',
    run: selectNextOccurrence,
    profiles: TEXT,
  },
  {
    id: 'editor.select-all-occurrences',
    run: selectSelectionMatches,
    profiles: TEXT,
  },
  { id: 'editor.fold', run: foldCode, profiles: DOCUMENT },
  { id: 'editor.unfold', run: unfoldCode, profiles: DOCUMENT },
  { id: 'editor.fold-all', run: foldAll, profiles: DOCUMENT },
  { id: 'editor.unfold-all', run: unfoldAll, profiles: DOCUMENT },
  {
    id: 'editor.trigger-suggest',
    run: startCompletion,
    profiles: DOCUMENT,
    highest: true,
  },
  {
    id: 'editor.trim-trailing-whitespace',
    run: deleteTrailingWhitespace,
    profiles: EVERY,
  },
  { id: 'editor.add-line-comment', run: lineComment, profiles: EVERY },
  { id: 'editor.remove-line-comment', run: lineUncomment, profiles: EVERY },
  {
    id: 'editor.select-to-bracket',
    run: selectMatchingBracket,
    profiles: EVERY,
  },
];
// The sticky editor binds three search commands without taking the search
// keymap (a sticky has no search panel). They are kept only so a sticky
// binding carries the same flags the document editor's does.
const STICKY_SEARCH: readonly KeyBinding[] = [
  { key: 'Mod-Alt-g', run: gotoLine },
  { key: 'Mod-d', run: selectNextOccurrence, preventDefault: true },
  { key: 'Mod-Shift-l', run: selectSelectionMatches },
];
/** CodeMirror key names for a canonical shortcut. Written with explicit
 *  modifiers rather than `Mod-` so it means the same on every platform. On
 *  Windows, Ctrl+Alt+Shift+letter reaches CodeMirror only as the shifted
 *  capital letter without a Shift modifier (Ctrl+Alt is AltGr there), so that
 *  spelling is added. */
export function toCodeMirrorKeys(accel: string, os: string): string[] {
  const { mods, key } = splitAccelerator(accel);
  const parts: string[] = [];
  if (mods.includes('Ctrl')) {
    parts.push('Ctrl');
  }
  if (mods.includes('Alt')) {
    parts.push('Alt');
  }
  const shift = mods.includes('Shift');
  if (shift) {
    parts.push('Shift');
  }
  if (mods.includes('Cmd') || mods.includes('Win')) {
    parts.push('Meta');
  }
  const isLetter = /^[A-Z]$/.test(key);
  const base = isLetter ? key.toLowerCase() : key;
  const keys = [[...parts, base].join('-')];
  if (
    os !== 'macos' &&
    isLetter &&
    shift &&
    mods.includes('Ctrl') &&
    mods.includes('Alt')
  ) {
    keys.push([...parts.filter((p) => p !== 'Shift'), key].join('-'));
  }
  return keys;
}
/** Tab: indent the lines when any range spans more than one line, otherwise
 *  replace each range (a caret included) with a tab character. A whole line
 *  selected without its line break is still one line. Not `indentMore`
 *  itself, so it is never taken for the rebindable Indent. */
export const tabKey: Command = (view) => {
  const { state } = view;
  if (state.readOnly) {
    return false;
  }
  const doc = state.doc;
  const multiLine = state.selection.ranges.some(
    (r) => doc.lineAt(r.from).number !== doc.lineAt(r.to).number,
  );
  if (multiLine) {
    return indentMore(view);
  }
  view.dispatch(
    state.update(state.replaceSelection('\t'), {
      scrollIntoView: true,
      userEvent: 'input',
    }),
  );
  return true;
};
/** Shift-Tab: outdent the lines. Not `indentLess` itself, for the same reason. */
export const shiftTabKey: Command = (view) => indentLess(view);
/** A copy of `binding` without its Shift variant. */
function withoutShift(binding: KeyBinding): KeyBinding {
  return Object.fromEntries(
    Object.entries(binding).filter(([name]) => name !== 'shift'),
  ) as KeyBinding;
}
/** Keep every stock binding except the ones that run a rebindable command,
 *  which are remembered so their flags carry over to the rebound key. The
 *  macOS Emacs binding for selecting to the line start loses its Shift
 *  variant: that key is Toggle Block Comment's default there, and stays out of
 *  the fixed keys whether or not Toggle Block Comment still holds it. */
function strip(
  sources: readonly (readonly KeyBinding[])[],
  removable: ReadonlySet<Command>,
): { kept: KeyBinding[]; origin: Map<Command, KeyBinding> } {
  const kept: KeyBinding[] = [];
  const origin = new Map<Command, KeyBinding>();
  for (const source of sources) {
    for (const binding of source) {
      const run = binding.run;
      if (run !== undefined && removable.has(run)) {
        if (!origin.has(run)) {
          origin.set(run, binding);
        }
      } else if (
        run === cursorLineStart &&
        binding.mac === 'Ctrl-a' &&
        binding.shift !== undefined
      ) {
        kept.push(withoutShift(binding));
      } else {
        kept.push(binding);
      }
    }
  }
  return { kept, origin };
}
/** The macOS Emacs keys for the same two moves: Ctrl-p and Ctrl-n, with their
 *  Shift variants, run the commands bound to ArrowUp and ArrowDown. */
const offscreenEmacsKeys: readonly KeyBinding[] = offscreenArrowKeys.map(
  (binding) => ({
    mac: binding.key === 'ArrowUp' ? 'Ctrl-p' : 'Ctrl-n',
    ...(binding.run !== undefined ? { run: binding.run } : {}),
    ...(binding.shift !== undefined ? { shift: binding.shift } : {}),
  }),
);

export interface KeymapBindings {
  /** Bindings at normal precedence. */
  normal: KeyBinding[];
  /** The completion list's bindings, which must outrank everything else. */
  completion: KeyBinding[];
  /** Up and Down (and, on macOS, Ctrl-p and Ctrl-n) for a caret outside the
   *  rendered lines; they come right after the completion list's keys and
   *  before everything else. */
  offscreen: KeyBinding[];
}

const SOURCES: Record<KeymapProfile, readonly (readonly KeyBinding[])[]> = {
  document: [
    closeBracketsKeymap,
    defaultKeymap,
    searchKeymap,
    historyKeymap,
    foldKeymap,
  ],
  sticky: [defaultKeymap, historyKeymap, STICKY_SEARCH],
  windowed: [defaultKeymap],
};
/** The bindings for `profile`. `accel` gives the key in effect for a registry
 *  id as canonical text, or null when the row is unset. */
export function buildKeymap(
  profile: KeymapProfile,
  os: string,
  accel: (id: string) => string | null,
): KeymapBindings {
  const mine = REBINDABLE.filter((c) => c.profiles.includes(profile));
  const removable = new Set(mine.map((c) => c.run));
  const rest = strip(SOURCES[profile], removable);
  const completion =
    profile === 'document'
      ? strip([completionKeymap], removable)
      : { kept: [], origin: new Map<Command, KeyBinding>() };
  const normal = rest.kept;
  const high = completion.kept;
  for (const command of mine) {
    const key = accel(command.id);
    if (key === null) {
      continue;
    }
    const origin =
      rest.origin.get(command.run) ?? completion.origin.get(command.run);
    for (const name of toCodeMirrorKeys(key, os)) {
      const binding: KeyBinding = {
        key: name,
        run: command.run,
        ...(origin?.preventDefault === true ? { preventDefault: true } : {}),
      };
      (command.highest === true ? high : normal).push(binding);
    }
  }
  normal.push({ key: 'Tab', run: tabKey, shift: shiftTabKey });
  return {
    normal,
    completion: high,
    offscreen: [
      ...offscreenArrowKeys,
      ...(os === 'macos' ? offscreenEmacsKeys : []),
    ],
  };
}
/** CodeMirror's modifier spellings, as the canonical modifier they mean. */
function bindingModifier(part: string, os: string): string | null {
  switch (part.toLowerCase()) {
    case 'ctrl':
    case 'control':
    case 'c':
      return 'Ctrl';
    case 'alt':
    case 'a':
      return 'Alt';
    case 'shift':
    case 's':
      return 'Shift';
    case 'meta':
    case 'cmd':
    case 'm':
      return 'Meta';
    case 'mod':
      return os === 'macos' ? 'Meta' : 'Ctrl';
    default:
      return null;
  }
}
/** A key name with its modifiers in one fixed order, so spellings that differ
 *  only in modifier order or alias compare equal. Null for an unknown modifier. */
function canonicalKeyName(
  mods: readonly string[],
  key: string,
  os: string,
): string | null {
  const found = new Set<string>();
  for (const part of mods) {
    const mod = bindingModifier(part, os);
    if (mod === null) {
      return null;
    }
    found.add(mod);
  }
  return [
    ...['Ctrl', 'Alt', 'Shift', 'Meta'].filter((m) => found.has(m)),
    key,
  ].join('-');
}
/** The command bound to a keydown whose layout turned a named key into a
 *  character (Option+Esc under Zhuyin), found by the key's physical code.
 *  A binding is read the way CodeMirror reads it: its field for `os` first,
 *  `Mod` as Meta on macOS and Ctrl elsewhere, and its `shift` variant when
 *  Shift is held and only the unshifted name matches. Null for every other
 *  event, which CodeMirror matches itself. */
export function resolveCodeNamedKey(
  bindings: readonly KeyBinding[],
  e: KeyLike,
  os: string,
): Command | null {
  if (namedKey(e.key) !== null || isComposingKey(e)) {
    return null;
  }
  const named = namedKeyFromCode(e.code);
  if (named === null) {
    return null;
  }
  const held: string[] = [];
  if (e.ctrlKey) {
    held.push('Ctrl');
  }
  if (e.altKey) {
    held.push('Alt');
  }
  if (e.metaKey) {
    held.push('Meta');
  }
  const plain = canonicalKeyName(held, named, os);
  const shifted = canonicalKeyName([...held, 'Shift'], named, os);
  const wanted = e.shiftKey ? shifted : plain;
  for (const b of bindings) {
    const raw =
      (os === 'macos' ? b.mac : os === 'windows' ? b.win : b.linux) ?? b.key;
    if (raw === undefined) {
      continue;
    }
    const parts = raw.split(/-(?!$)/);
    const name = canonicalKeyName(parts.slice(0, -1), parts.at(-1) ?? '', os);
    if (name === wanted && b.run !== undefined) {
      return b.run;
    }
    if (e.shiftKey && name === plain && b.shift !== undefined) {
      return b.shift;
    }
  }
  return null;
}
/** The CodeMirror extension for `profile`; swap it into a `Compartment` when
 *  the effective shortcuts change. */
export function keymapExtension(
  profile: KeymapProfile,
  os: string,
  accel: (id: string) => string | null,
): Extension {
  const { normal, completion, offscreen } = buildKeymap(profile, os, accel);
  const all = [...completion, ...normal];
  return [
    completion.length > 0 ? Prec.highest(keymap.of(completion)) : [],
    Prec.highest(keymap.of(offscreen)),
    Prec.highest(
      EditorView.domEventHandlers({
        keydown(e, view) {
          const run = resolveCodeNamedKey(all, e, os);
          if (run === null || !run(view)) {
            return false;
          }
          e.preventDefault();
          return true;
        },
      }),
    ),
    keymap.of(normal),
  ];
}
