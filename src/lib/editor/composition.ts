// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// Ending an IME composition on purpose, and cancelling one on macOS.

import type { EditorState, Extension } from '@codemirror/state';
import { ViewPlugin, type EditorView } from '@codemirror/view';
/** How long to wait for `compositionend` after the blur before moving on. */
export const COMPOSITION_END_TIMEOUT_MS = 200;
/** What `settleComposition` needs from an editor. */
export interface CompositionHost {
  composing: () => boolean;
  /** Take focus away, which makes the browser commit the composition. */
  blur: () => void;
  /** Call `done` once on the next `compositionend`; returns the unsubscribe. */
  onEnd: (done: () => void) => () => void;
}
/** Resolve once nothing is composing any more and the editor has read the
 *  committed text into its state. Immediately when nothing is composing. */
export function settleComposition(
  host: CompositionHost,
  timeoutMs = COMPOSITION_END_TIMEOUT_MS,
): Promise<void> {
  if (!host.composing()) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let stop = (): void => {};
    const timer = setTimeout(() => {
      stop();
      resolve();
    }, timeoutMs);
    stop = host.onEnd(() => {
      clearTimeout(timer);
      // CodeMirror's own flush of the pending DOM changes is already queued as
      // a microtask by its compositionend handler; run after it.
      void Promise.resolve().then(resolve);
    });
    host.blur();
  });
}
/** End the composition with `settle`, then wait for `drain` (the edits it
 *  committed still being applied) before resolving. */
export async function settleThenDrain(
  settle: () => Promise<void>,
  drain: () => Promise<void>,
): Promise<void> {
  await settle();
  await drain();
}
/** The composition host of a CodeMirror view. */
export function viewHost(view: EditorView): CompositionHost {
  return {
    composing: () => view.compositionStarted,
    blur: () => view.contentDOM.blur(),
    onEnd: (done) => {
      view.contentDOM.addEventListener('compositionend', done, { once: true });
      return () => view.contentDOM.removeEventListener('compositionend', done);
    },
  };
}
/** `settleComposition` for a view. */
export function settleViewComposition(view: EditorView): Promise<void> {
  return settleComposition(viewHost(view));
}
/** Cancel the composition `view` is in: end it, then put `snapshot` back and
 *  hand the restored view to `restored`. */
export async function cancelViewComposition(
  view: EditorView,
  snapshot: EditorState,
  restored: (view: EditorView) => void,
): Promise<void> {
  const scroll = view.scrollSnapshot();
  await settleViewComposition(view);
  if (!view.dom.isConnected) {
    return;
  }
  // The state from just before the composition began, so the document,
  // selection and undo history read as if it never happened.
  view.setState(snapshot);
  view.dispatch({ effects: scroll });
  restored(view);
  view.focus();
}
/** macOS only: Undo while composing cancels the composition (as TextEdit does).
 *  `isUndo` says whether a keydown is the effective Undo shortcut; `restored`
 *  runs after the state is back, to sync whatever mirrors the document. */
export function compositionCancel(
  isUndo: (event: KeyboardEvent) => boolean,
  restored: (view: EditorView) => void,
): Extension {
  return ViewPlugin.define((view) => {
    let snapshot: EditorState | null = null;
    // Capture phase: runs before CodeMirror's own handler, which may delete a
    // multi-line selection as a separate history step when the composition starts.
    const onStart = (): void => {
      snapshot = view.state;
    };
    // A plain listener: CodeMirror's keymaps ignore every key while composing.
    const onKeydown = (event: KeyboardEvent): void => {
      if (snapshot === null || !view.compositionStarted || !isUndo(event)) {
        return;
      }
      event.preventDefault();
      void cancelViewComposition(view, snapshot, restored);
    };
    view.dom.addEventListener('compositionstart', onStart, true);
    view.contentDOM.addEventListener('keydown', onKeydown);
    return {
      destroy: (): void => {
        view.dom.removeEventListener('compositionstart', onStart, true);
        view.contentDOM.removeEventListener('keydown', onKeydown);
      },
    };
  });
}
