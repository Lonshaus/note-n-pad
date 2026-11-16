// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import { EditorView } from '@codemirror/view';
import { attachMarquee, type MarqueeHandle } from '../util/marquee';

const handles = new WeakMap<EditorView, Map<HTMLElement, MarqueeHandle>>();
/** Runs the text of a CodeMirror dialog's submit button (go to line) as a
 *  marquee when it does not fit; the dialog's markup is built by CodeMirror. */
export const dialogMarquee = EditorView.updateListener.of((update) => {
  if (!update.transactions.some((tr) => tr.effects.length > 0)) {
    return;
  }
  const view = update.view;
  let attached = handles.get(view);
  if (attached === undefined) {
    attached = new Map();
    handles.set(view, attached);
  }
  for (const [button, handle] of attached) {
    if (!button.isConnected) {
      handle.destroy();
      attached.delete(button);
    }
  }
  const buttons = view.dom.querySelectorAll<HTMLElement>(
    '.cm-dialog button.cm-button[type=submit]',
  );
  for (const button of buttons) {
    if (button.querySelector('.marquee') !== null) {
      continue;
    }
    const label = document.createElement('span');
    label.className = 'marquee';
    const inner = document.createElement('span');
    inner.textContent = button.textContent;
    label.append(inner);
    button.replaceChildren(label);
    attached.set(button, attachMarquee(label, button));
  }
});
