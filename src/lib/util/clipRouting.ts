// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Where a copy goes when the text is too big for the web clipboard: through a
// clip file the core writes and hands to the system clipboard, or the way the
// browser does it. Free of the DOM and Tauri, so it unit-tests in isolation.

import { globalOpPath, type LineSelection } from './windowSelection';
/** Where focus is, as far as the clipboard rules care. */
export type ClipFocus = 'editor' | 'none' | 'other';
/** 'session': the editor copies a selection of its session through a clip.
 *  'file': the viewer copies lines of the file through a clip. 'text': the
 *  browser's own copy, or the text field that has focus. */
export type ClipRoute = 'session' | 'file' | 'text';
/** What the Rust `clip_status` and a finished clip copy report. */
export interface ClipInfo {
  id: string;
  bytes: number;
  lines: number;
  utf16_len: number;
  /** How many line breaks are `\r\n`, a pair counting once. */
  crlf: number;
  linewise: boolean;
}
/** How a clip copy ended; the last two show no message. */
export type ClipOutcome =
  | ({ kind: 'offered' } & ClipInfo)
  | { kind: 'superseded' }
  | { kind: 'offer_failed' };
/** What `clip_copy_file` copies: lines are 0-based and both ends are included. */
export type ClipRange =
  { kind: 'whole' } | { kind: 'lines'; start: number; end: number };
/** A column past the end of any line: the core stops at the line break. */
export const LINE_END_COL = Number.MAX_SAFE_INTEGER;
/** The viewer's loaded lines: the first one and how many. */
export interface LoadedRows {
  startLine: number;
  count: number;
}
/** What holds a focused element. */
interface Root<T> {
  contains(node: T): boolean;
}
/** Where focus is in the viewer: nowhere (no element, or the page body), in the
 *  rows (`content`), or elsewhere, the find and goto fields among them. The
 *  rows' scroll area is `content`; `wrap` also holds the fields and so says
 *  nothing about the rows. */
export function viewerFocus<T>(
  active: T | null,
  roots: { content: Root<T> | null; wrap: Root<T> | null; body: T },
): ClipFocus {
  if (active === null || active === roots.body) {
    return 'none';
  }
  return roots.content?.contains(active) === true ? 'editor' : 'other';
}
/** The way a copy goes. */
export function clipCopyRoute(s: {
  mode: 'edit' | 'view';
  focus: ClipFocus;
  /** The editor's global selection (editing only). */
  globalSel: LineSelection | null;
  /** The viewer's Select All stands for the whole file. */
  wholeFile: boolean;
  /** The browser's selection in the viewer is not empty. */
  domSelection: boolean;
  /** The viewer's line range from the gutter. */
  sel: { start: number; end: number } | null;
  loadedRows: LoadedRows | null;
}): ClipRoute {
  if (s.focus === 'other') {
    return 'text';
  }
  if (s.mode === 'edit') {
    return s.globalSel !== null && globalOpPath(s.globalSel)
      ? 'session'
      : 'text';
  }
  if (s.wholeFile) {
    return 'file';
  }
  if (s.domSelection) {
    return 'text';
  }
  if (s.sel !== null && outsideLoaded(s.sel, s.loadedRows)) {
    return 'file';
  }
  return 'text';
}

function outsideLoaded(
  sel: { start: number; end: number },
  rows: LoadedRows | null,
): boolean {
  return (
    rows === null ||
    sel.start < rows.startLine ||
    sel.end >= rows.startLine + rows.count
  );
}
/** What the viewer's clip copy takes: the whole file, or the line range. */
export function clipFileRange(s: {
  wholeFile: boolean;
  sel: { start: number; end: number } | null;
}): ClipRange | null {
  if (s.wholeFile) {
    return { kind: 'whole' };
  }
  return s.sel === null
    ? null
    : { kind: 'lines', start: s.sel.start, end: s.sel.end };
}
/** A cut through a clip: the text is offered first, and only an offered clip
 *  takes the selection out of the file. */
export async function runClipCut<R>(s: {
  offer: () => Promise<ClipOutcome>;
  remove: () => Promise<R>;
}): Promise<{ outcome: ClipOutcome; removed: R | null }> {
  const outcome = await s.offer();
  if (outcome.kind !== 'offered') {
    return { outcome, removed: null };
  }
  return { outcome, removed: await s.remove() };
}
