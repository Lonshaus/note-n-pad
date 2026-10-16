// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** The plain text of the XML view, built from its rows rather than from the
 *  DOM: the view draws only the rows near the viewport, so Select All + Copy
 *  has to read the whole row list itself. Mirrors what `XmlRow.svelte` shows,
 *  minus the expand arrows. */

import {
  isRowOpen,
  type ExpandedPaths,
  type VisibleRow,
  type XmlNode,
} from './xml';
/** One level of indentation, standing in for the view's per-depth padding. */
const INDENT = '  ';
/** The tag column of a row: what the view shows in place of the node's name.
 *  Shared with `XmlRow.svelte`, so the row and the copied text cannot drift. */
export function xmlNodeLabel(node: XmlNode): string {
  switch (node.kind) {
    case 'element':
      return `<${node.name}>`;
    case 'instruction':
      return `<?${node.name}?>`;
    case 'comment':
      return '<!-- -->';
    case 'cdata':
      return 'CDATA';
    case 'document':
      return '#document';
    default:
      return '';
  }
}
/** One row as displayed: indentation, then the tag, attributes, leaf text and
 *  (for a collapsed container) its child count, separated by single spaces. */
export function xmlRowText(
  node: XmlNode,
  depth: number,
  open: boolean,
): string {
  const parts: string[] = [];
  if (node.kind === 'text') {
    parts.push(node.value ?? '');
  } else {
    parts.push(xmlNodeLabel(node));
    for (const attr of node.attributes) {
      parts.push(`${attr.name}="${attr.value}"`);
    }
    if (
      node.kind === 'comment' ||
      node.kind === 'cdata' ||
      node.kind === 'instruction'
    ) {
      parts.push(node.value ?? '');
    }
    if (node.childCount > 0 && !open) {
      parts.push(String(node.childCount));
    }
  }
  return INDENT.repeat(depth) + parts.filter((p) => p !== '').join(' ');
}
/** Every row of `rows` as displayed, one per line, in order. */
export function xmlViewText(
  rows: readonly VisibleRow[],
  toggled: ExpandedPaths,
): string {
  return rows
    .map((row) =>
      xmlRowText(row.node, row.depth, isRowOpen(row.path, row.depth, toggled)),
    )
    .join('\n');
}
