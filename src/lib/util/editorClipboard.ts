// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import type { EditorView } from '@codemirror/view';
import { invoke } from '@tauri-apps/api/core';

/** The CM view's selected text, joined the same way CM6's own copy handler
 *  joins a multi-selection (one line per range). */
function selectedText(view: EditorView): string {
  return view.state.selection.ranges
    .map((r) => view.state.sliceDoc(r.from, r.to))
    .join('\n');
}

/** Edit > Copy against a CodeMirror view: write the selection to the
 *  clipboard, or do nothing when there is none. */
export function editorCopy(view: EditorView): void {
  const text = selectedText(view);
  if (text !== '') {
    void navigator.clipboard.writeText(text);
  }
}

/** Edit > Cut against a CodeMirror view: copy the selection, then remove it
 *  as a single edit so it lands in CM's undo history as one step.
 *  The write is awaited before the delete — a rejected clipboard write with the
 *  delete already dispatched would destroy the selection with no copy of it
 *  anywhere. */
export async function editorCut(view: EditorView): Promise<void> {
  const text = selectedText(view);
  if (text === '') {
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return;
  }
  view.dispatch(view.state.replaceSelection(''));
}

/** Edit > Paste against a CodeMirror view. Unlike Copy/Cut, this needs
 *  clipboard *read* access. WebKitGTK on Linux blocks
 *  `navigator.clipboard.readText()` outright, so a throw or an empty result
 *  there falls back to the `read_clipboard_text` Rust command (a no-op
 *  `None` on macOS/Windows, which already succeeded via `readText()` and
 *  never reaches this fallback). Paste is a no-op only when both fail. */
export async function editorPaste(view: EditorView): Promise<void> {
  // LANDMINE: the core command is tried first, not second. On WebKitGTK
  // `navigator.clipboard.readText()` neither resolves nor rejects, so awaiting
  // it first strands the paste forever and any code after it never runs. The
  // command answers `null` off Linux, where `readText()` then works.
  // A rejected invoke would surface as an unhandled rejection: every caller
  // fires this off with `void`.
  const fromCore = await invoke<string | null>('read_clipboard_text').catch(
    () => null,
  );
  let text = fromCore ?? '';
  if (text === '') {
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return;
    }
  }
  if (text === '') {
    return;
  }
  view.dispatch(view.state.replaceSelection(text));
}
