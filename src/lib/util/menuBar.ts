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
 *  `DocumentApp.svelte`) but has no cut/paste of its own. A windowed
 *  (large-file range-edit) tab owns undo/redo through its own Rust-journal
 *  history instead of a CodeMirror command, and exposes no clipboard hooks at
 *  all. Anything else falls back to the CodeMirror view when one is mounted,
 *  or 'none' when it is not (e.g. a plain large-file tab). */
export function editActionSurface(
  action: EditAction,
  ctx: { isTable: boolean; isWindowed: boolean; hasEditorView: boolean },
): 'table' | 'editor' | 'windowed' | 'none' {
  if (action === 'undo' || action === 'redo') {
    if (ctx.isWindowed) {
      return 'windowed';
    }
    if (ctx.isTable) {
      return 'table';
    }
    return ctx.hasEditorView ? 'editor' : 'none';
  }
  if (ctx.isTable) {
    return action === 'select-all' || action === 'copy' ? 'table' : 'none';
  }
  return ctx.hasEditorView ? 'editor' : 'none';
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
