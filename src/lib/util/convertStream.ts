// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
// What a paste that makes a tab a large file sends to the core, in order: the
// document up to the first place the paste goes, what is pasted there, the
// document up to the next place, and so on to the end. Free of the DOM and
// Tauri, so it unit-tests in isolation.

import type { Text } from '@codemirror/state';
import type { PasteRange, PasteSource } from './pasteRouting';
/** The most UTF-16 units one text block holds. */
export const CONVERT_CHUNK = 1024 * 1024;
/** One thing sent to the conversion file. */
export type ConvertOp =
  | { kind: 'text'; text: string }
  /** The whole pinned clip. */
  | { kind: 'clip' }
  /** One line (0-based) of the pinned clip, without its break. */
  | { kind: 'clipLine'; line: number };
/** Where a block `[at, end)` of a string may end without cutting a surrogate
 *  pair (or a CR from the LF after it): `end` itself, or one unit less. */
function safeEnd(unit: (i: number) => number, at: number, end: number): number {
  const last = unit(end - 1);
  const next = unit(end);
  const splitsPair =
    last >= 0xd800 && last < 0xdc00 && next >= 0xdc00 && next < 0xe000;
  const splitsBreak = last === 0x0d && next === 0x0a;
  return (splitsPair || splitsBreak) && end - 1 > at ? end - 1 : end;
}
/** The slice `[from, to)` of a document, a block at a time. */
function* docBlocks(doc: Text, from: number, to: number): Generator<string> {
  let at = from;
  while (at < to) {
    let end = Math.min(at + CONVERT_CHUNK, to);
    if (end < to) {
      const around = doc.sliceString(end - 1, end + 1);
      end = safeEnd((i) => around.charCodeAt(i - end + 1), at, end);
    }
    yield doc.sliceString(at, end);
    at = end;
  }
}
/** A piece of pasted text, a block at a time. A CR that ends the piece is a
 *  break of its own and its block goes with its breaks as LFs: the core joins
 *  a CR to an LF that comes next, and what follows the piece is not part of it. */
function* pieceBlocks(text: string): Generator<string> {
  let at = 0;
  while (at < text.length) {
    let end = Math.min(at + CONVERT_CHUNK, text.length);
    if (end < text.length) {
      end = safeEnd((i) => text.charCodeAt(i), at, end);
    }
    const block = text.slice(at, end);
    yield end === text.length && block.endsWith('\r')
      ? block.replace(/\r\n?/g, '\n')
      : block;
    at = end;
  }
}
/** The lines of a pasted text as CodeMirror splits it. */
export function pastedLines(text: string): string[] {
  return text.split(/\r\n?|\n/);
}
/** The operations that build the converted file for a paste. `ranges` are the
 *  selection's, in order and apart. A piece is a clip, the text of a line of
 *  the pasted text, or the whole text; with `linewise` a line break follows it. */
export function* convertOps(s: {
  doc: Text;
  ranges: PasteRange[];
  linewise: boolean;
  source: PasteSource;
}): Generator<ConvertOp> {
  const byLine =
    s.source.kind === 'text' && s.ranges.some((r) => r.line !== null);
  const lines =
    byLine && s.source.kind === 'text' ? pastedLines(s.source.text) : null;
  let at = 0;
  for (const r of s.ranges) {
    for (const text of docBlocks(s.doc, at, r.from)) {
      yield { kind: 'text', text };
    }
    at = r.to;
    if (s.source.kind === 'clip') {
      yield r.line === null
        ? { kind: 'clip' }
        : { kind: 'clipLine', line: r.line - 1 };
    } else if (r.line !== null && lines !== null) {
      for (const text of pieceBlocks(lines[r.line - 1] ?? '')) {
        yield { kind: 'text', text };
      }
    } else {
      for (const text of pieceBlocks(s.source.text)) {
        yield { kind: 'text', text };
      }
    }
    if (s.linewise) {
      yield { kind: 'text', text: '\n' };
    }
  }
  for (const text of docBlocks(s.doc, at, s.doc.length)) {
    yield { kind: 'text', text };
  }
}
