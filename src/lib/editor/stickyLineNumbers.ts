// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only

import type { Extension } from '@codemirror/state';
import { EditorView, GutterMarker, gutter, gutters } from '@codemirror/view';

/** The widest line number the gutter makes room for: 9, 99, 999, ... the
 *  smallest such number not below `lines` (CodeMirror's own rule). */
export function maxLineNumber(lines: number): number {
  let last = 9;
  while (last < lines) {
    last = last * 10 + 9;
  }
  return last;
}
/** A line number in its own element, so it can stick to the top of the screen
 *  while the rest of its wrapped line is still on it. */
export class StickyNumber extends GutterMarker {
  readonly text: string;
  constructor(text: string) {
    super();
    this.text = text;
  }
  override eq(other: GutterMarker): boolean {
    return other instanceof StickyNumber && other.text === this.text;
  }
  override toDOM(): Node {
    const span = document.createElement('span');
    span.className = 'cm-stickyNumber';
    span.textContent = this.text;
    return span;
  }
}
// `.cm-gutter` is `overflow: hidden`, which would make the column the sticky
// number's scroll container; `clip` clips the same without being one.
const stickyTheme = EditorView.baseTheme({
  '.cm-gutter.cm-lineNumbers': { overflow: 'clip' },
  '.cm-stickyNumber': { display: 'block', position: 'sticky', top: 0 },
});
/** CodeMirror's line-number gutter, with each number following the scroll
 *  down its wrapped line. `format` turns a document line number into text. */
export function stickyLineNumbers(
  format: (n: number) => string = String,
): Extension {
  const spacerFor = (lines: number): StickyNumber =>
    new StickyNumber(format(maxLineNumber(lines)));
  return [
    gutters(),
    gutter({
      class: 'cm-lineNumbers',
      renderEmptyElements: false,
      lineMarker: (view, line) =>
        new StickyNumber(format(view.state.doc.lineAt(line.from).number)),
      initialSpacer: (view) => spacerFor(view.state.doc.lines),
      updateSpacer: (spacer, update) => {
        const next = spacerFor(update.view.state.doc.lines);
        return spacer.eq(next) ? spacer : next;
      },
    }),
    stickyTheme,
  ];
}
