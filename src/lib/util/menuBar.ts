// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import type { LineEnding } from './text';

/** A parameterized menu action ("set-encoding:Big5") split into its command and
 *  argument. Plain actions (no colon) return null and are handled by name. The
 *  argument keeps everything after the first colon; a label or language name
 *  never contains one, but the split is robust if one ever did. */
export function splitMenuAction(
  action: string,
): { command: string; arg: string } | null {
  const i = action.indexOf(':');
  if (i === -1) {
    return null;
  }
  return { command: action.slice(0, i), arg: action.slice(i + 1) };
}

/** The syntax argument as a language name, or null for the empty "Plain Text"
 *  argument (`set-language:`), matching the null the editor uses for no language. */
export function languageArg(arg: string): string | null {
  return arg === '' ? null : arg;
}

/** An Edit-menu action that needs a live editing surface to run against. */
export type EditAction =
  'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'select-all';

const EDIT_ACTIONS: readonly string[] = [
  'undo',
  'redo',
  'cut',
  'copy',
  'paste',
  'select-all',
];

/** Whether `action` is one of the six Edit-menu clipboard/history commands, so
 *  callers can narrow a raw menu-action string to `EditAction`. */
export function isEditAction(action: string): action is EditAction {
  return EDIT_ACTIONS.includes(action);
}

/** The surface an `EditAction` should run against, given the active tab's
 *  shape. A table view owns undo/redo/copy/select-all through the same
 *  CodeMirror history as the source view (see `tableUndo`/`tableRedo` in
 *  `DocumentApp.svelte`) but has no cut/paste of its own. A JSON, XML or
 *  Markdown view ('overlay') replays undo/redo on the source editor's history,
 *  which it is drawn over, and owns select-all/copy itself; it has no cut/paste
 *  either, and the hidden editor behind it is never the target. A windowed
 *  (large-file range-edit) tab owns undo/redo through its own Rust-journal
 *  history instead of a CodeMirror command, and exposes no clipboard hooks at
 *  all. Anything else falls back to the CodeMirror view when one is mounted,
 *  or 'none' when it is not (e.g. a plain large-file tab). Undo/redo with
 *  focus in a text field of its own ('field': the find bar, a table cell being
 *  edited) belong to that field's native history, whatever the tab shows.
 *  Select-all is custom on macOS too (the native one selects the whole page),
 *  so it is routed by tab shape like the rest: a focused text field first, then
 *  a windowed tab ('windowed': the on-screen span), a large-file viewer tab
 *  ('viewer': the fully visible rows), a table or a JSON/XML/Markdown view. */
export function editActionSurface(
  action: EditAction,
  ctx: {
    isTable: boolean;
    isWindowed: boolean;
    hasEditorView: boolean;
    isOverlay?: boolean;
    isViewer?: boolean;
    fieldFocused?: boolean;
    modalOpen?: boolean;
  },
): 'table' | 'overlay' | 'viewer' | 'editor' | 'windowed' | 'field' | 'none' {
  if (action === 'undo' || action === 'redo') {
    if (ctx.fieldFocused === true) {
      return 'field';
    }
    if (ctx.isWindowed) {
      return 'windowed';
    }
    if (ctx.isTable) {
      return 'table';
    }
    if (ctx.isOverlay === true) {
      return ctx.hasEditorView ? 'overlay' : 'none';
    }
    return ctx.hasEditorView ? 'editor' : 'none';
  }
  if (action === 'select-all') {
    // A dialog on top owns the page: select-all stays native there, as it was
    // before the custom item, and never reaches the tab behind it.
    if (ctx.fieldFocused === true || ctx.modalOpen === true) {
      return 'field';
    }
    if (ctx.isWindowed) {
      return 'windowed';
    }
    if (ctx.isViewer === true) {
      return 'viewer';
    }
  }
  if (ctx.isTable) {
    return action === 'select-all' || action === 'copy' ? 'table' : 'none';
  }
  if (ctx.isOverlay === true) {
    return action === 'select-all' || action === 'copy' ? 'overlay' : 'none';
  }
  return ctx.hasEditorView ? 'editor' : 'none';
}
/** The part of a DOM element `isNativeUndoField` reads. */
export interface FieldLike {
  tagName: string;
  type?: string;
  isContentEditable?: boolean;
  closest(selector: string): unknown;
}

const TEXT_INPUT_TYPES: readonly string[] = [
  '',
  'text',
  'search',
  'url',
  'tel',
  'email',
  'password',
  'number',
];
/** Whether `el` is a text field whose own native undo history Undo/Redo
 *  should drive: an `<input>` that takes text, a `<textarea>`, or a
 *  contenteditable that is not a CodeMirror content area (CodeMirror keeps its
 *  own history). */
export function isNativeUndoField(el: FieldLike | null): boolean {
  if (el === null) {
    return false;
  }
  if (el.tagName === 'INPUT') {
    return TEXT_INPUT_TYPES.includes(el.type ?? '');
  }
  if (el.tagName === 'TEXTAREA') {
    return true;
  }
  return el.isContentEditable === true && el.closest('.cm-content') === null;
}
/** Run Undo or Redo on the focused text field through the browser's own
 *  history. The macOS Edit menu no longer hands these to the responder chain,
 *  so every window that has editable fields forwards them here. */
export function nativeFieldHistory(action: 'undo' | 'redo'): void {
  document.execCommand(action);
}
/** Select the text of the focused field, or the window's selectable text when
 *  none is focused. The macOS Select All is a custom item, so every window
 *  with text forwards it here. */
export function nativeSelectAll(): void {
  document.execCommand('selectAll');
}

/** One tab as reported to the Rust menu/Dock state. Extends the old (name,
 *  tabIndex) shape with the fields the Format/File menu checks read off the
 *  active tab. */
export interface TabReportEntry {
  tabIndex: number;
  name: string;
  hasPath: boolean;
  lineEnding: LineEnding;
  encoding: string;
  language: string | null;
}

/** Shape one document tab into its report entry. `hasPath` is derived from the
 *  path (an untitled tab carries an empty path); everything else passes through.
 *  Pure so the derivation is unit-tested apart from the reactive report effect. */
export function tabReportEntry(tab: {
  tabIndex: number;
  name: string;
  path: string;
  lineEnding: LineEnding;
  encoding: string;
  language: string | null;
}): TabReportEntry {
  return {
    tabIndex: tab.tabIndex,
    name: tab.name,
    hasPath: tab.path !== '',
    lineEnding: tab.lineEnding,
    encoding: tab.encoding,
    language: tab.language,
  };
}
