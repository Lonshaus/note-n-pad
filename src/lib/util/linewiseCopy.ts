// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// The text the last copy or cut left for a line-wise paste, shared by every
// editor of the window. CodeMirror keeps this in a module variable of its own
// that a paste dispatched by us cannot read.

import type { EditorState } from '@codemirror/state';
import { copiedRange, linewiseAfterCopy } from './replayKeys';

let last: string | null = null;
/** The text of the last copy made with nothing selected, else null. */
export function lastLinewiseCopy(): string | null {
  return last;
}
/** What CodeMirror's copy and cut handler records (view `index.js:5218-5230`):
 *  nothing copied from an empty document leaves the record alone, a copy of a
 *  caret line sets it, a copy of a selection clears it. */
export function rememberCopy(state: EditorState): void {
  const copied = copiedRange(state);
  if (copied.text === '' && !copied.linewise) {
    return;
  }
  last = linewiseAfterCopy(copied);
}
/** Forget the record (tests). */
export function resetLinewiseCopy(): void {
  last = null;
}
