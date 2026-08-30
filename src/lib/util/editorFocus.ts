// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Automatic keyboard-focus handoff for editor windows. A document/sticky window
// opened programmatically (or restored on launch) leaves focus on BODY, so the
// WebView silently drops keystrokes until the user clicks the editor. These
// helpers reclaim focus for the editor, but only when nobody else is holding it.

// Elements we must never steal keyboard focus from: text inputs, textareas,
// selects, search fields, and any contenteditable (which includes a CodeMirror
// editor that already holds focus). A null or BODY activeElement means nobody
// holds focus, so the editor is free to claim it.
export function isInputLike(el: Element | null): boolean {
  if (el === null) {
    return false;
  }
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  if ((el as HTMLElement).isContentEditable) {
    return true;
  }
  const role = el.getAttribute('role');
  return role === 'searchbox' || role === 'search';
}

// Whether the editor may take keyboard focus now: never while a dialog/modal is
// up, and never when focus already rests on an input-like element. Only the
// idle BODY/null state is claimed, so a click in a field or an open dialog is
// never interrupted.
export function shouldFocusEditor(
  active: Element | null,
  modalOpen: boolean,
): boolean {
  return !modalOpen && !isInputLike(active);
}

// Focus the given editor (a CodeMirror view or any focusable container) only
// when nobody else holds keyboard focus. Safe to call at load, on window focus,
// and after a tab switch.
export function focusEditorIfIdle(
  focusable: { focus: () => void } | null | undefined,
  modalOpen: boolean,
): void {
  if (
    focusable != null &&
    shouldFocusEditor(document.activeElement, modalOpen)
  ) {
    focusable.focus();
  }
}
