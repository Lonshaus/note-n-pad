// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** The plain text of the Markdown view, built from the document through the
 *  view's own renderer rather than from the DOM: the view draws only the
 *  blocks near the viewport, so Select All + Copy has to cover the rest itself. */
import type { Tree } from '@lezer/common';
import { renderBlockSource, type MdNode } from './core';
import { blockCount, blockEnd, blockStart, type BlockIndex } from './scan';

const BLOCK_KINDS: ReadonlySet<MdNode['kind']> = new Set([
  'heading',
  'paragraph',
  'quote',
  'list',
  'codeblock',
  'table',
  'rule',
  'html',
]);
/** Inline runs are concatenated; each block stands on its own line. */
function joinNodes(nodes: readonly MdNode[]): string {
  const lines: string[] = [];
  let run = '';
  for (const node of nodes) {
    if (BLOCK_KINDS.has(node.kind)) {
      if (run !== '') {
        lines.push(run);
        run = '';
      }
      lines.push(markdownNodeText(node));
    } else {
      run += markdownNodeText(node);
    }
  }
  if (run !== '') {
    lines.push(run);
  }
  return lines.join('\n');
}

function cellsText(cells: readonly (readonly MdNode[])[]): string {
  return cells.map((cell) => joinNodes(cell)).join('\t');
}
/** One node as displayed: marks are gone, a list item keeps its bullet,
 *  number or task box, and a table row becomes tab-separated cells. */
export function markdownNodeText(node: MdNode): string {
  switch (node.kind) {
    case 'text':
    case 'code':
    case 'html':
    case 'codeblock':
      return node.text;
    case 'emphasis':
    case 'strong':
    case 'strike':
    case 'link':
    case 'heading':
    case 'paragraph':
    case 'quote':
      return joinNodes(node.children);
    case 'image':
      return node.alt;
    case 'rule':
      return '';
    case 'list':
      return node.items
        .map((item, i) => {
          let marker = node.ordered ? `${i + 1}.` : '•';
          if (item.checked !== null) {
            marker = item.checked ? '[x]' : '[ ]';
          }
          const body = joinNodes(item.children).replace(/\n/g, '\n  ');
          return `${marker} ${body}`;
        })
        .join('\n');
    case 'table':
      return [cellsText(node.header), ...node.rows.map(cellsText)].join('\n');
  }
}
/** Every block of the document as displayed, blocks separated by a blank line.
 *  Reads the whole document, so it is for a deliberate Copy, never for
 *  drawing. */
export function markdownViewText(
  doc: { sliceString(from: number, to: number): string },
  index: BlockIndex,
  refs: Map<string, string>,
  parse: (src: string) => Tree,
): string {
  const parts: string[] = [];
  for (let i = 0; i < blockCount(index); i += 1) {
    const source = doc.sliceString(blockStart(index, i), blockEnd(index, i));
    for (const node of renderBlockSource(parse, source, refs)) {
      const text = markdownNodeText(node);
      if (text !== '') {
        parts.push(text);
      }
    }
  }
  return parts.join('\n\n');
}
