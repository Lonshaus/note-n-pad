// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Turning a Markdown syntax tree into something the view can draw.
 *
 *  Two properties matter and both are structural rather than remembered:
 *  - Nothing here produces HTML. The output is a tree of plain objects whose
 *    payload is text, or — for `link`/`image` — a raw destination string that
 *    nothing here or in the current view turns into a live `<a>`/`<img>`. A
 *    document containing `<script>` or an `onerror=` attribute renders as the
 *    characters the author typed.
 *  - The whole document is never converted at once. A ten-million-character
 *    document is ~710,000 syntax nodes; `topLevelBlocks` indexes it cheaply and
 *    `renderBlocks` converts only the slice the viewport asks for.
 *
 *  This module is free of DOM and worker APIs so it runs, and is tested, in
 *  plain node. */
import type { SyntaxNode, Tree } from '@lezer/common';
import { normalizeLabel } from './scan';

/** Where one top-level block sits. The index is all the main thread needs to
 *  size the scrollbar and decide what to ask for. */
export interface MdBlockRef {
  type: string;
  from: number;
  to: number;
}

export interface MdListItem {
  /** null when the item is not a task-list item. */
  checked: boolean | null;
  children: MdNode[];
}

/** The render model. Every variant carries text, other nodes, or a plain
 *  string — never markup. `link`/`image` may now carry a destination exactly
 *  as written in the source (unresolved, unvalidated); nothing in this module
 *  or the current view turns it into a live `<a>`/`<img>`, that is later work
 *  gated behind a setting and a containment check. */
export type MdNode =
  | { kind: 'text'; text: string }
  | { kind: 'emphasis'; children: MdNode[] }
  | { kind: 'strong'; children: MdNode[] }
  | { kind: 'strike'; children: MdNode[] }
  | { kind: 'code'; text: string }
  | { kind: 'heading'; level: number; children: MdNode[] }
  | { kind: 'paragraph'; children: MdNode[] }
  | { kind: 'quote'; children: MdNode[] }
  | { kind: 'list'; ordered: boolean; items: MdListItem[] }
  | { kind: 'codeblock'; info: string; text: string }
  | { kind: 'table'; header: MdNode[][]; rows: MdNode[][][] }
  | { kind: 'rule' }
  | { kind: 'html'; text: string }
  | { kind: 'link'; dest: string; children: MdNode[] }
  | { kind: 'image'; dest: string; alt: string };

/** Syntax nodes that exist to mark up the source and carry no content of their
 *  own: the `#` of a heading, the `**` of bold, a table's pipes. Their text is
 *  skipped, which is what turns source into rendered content. */
const MARKS = new Set([
  'HeaderMark',
  'EmphasisMark',
  'CodeMark',
  'StrikethroughMark',
  'ListMark',
  'QuoteMark',
  'TableDelimiter',
  'LinkMark',
  'LinkTitle',
  'LinkLabel',
  'TaskMarker',
  'CodeInfo',
]);

function textOf(text: string, node: SyntaxNode): string {
  return text.slice(node.from, node.to);
}

function namedChild(node: SyntaxNode, name: string): SyntaxNode | null {
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    if (child.name === name) {
      return child;
    }
  }
  return null;
}

/** Destination of a `Link`/`Image` node: an inline `(url)` if present,
 *  otherwise a reference label — `[x][label]`, collapsed `[x][]`, or
 *  shortcut `[x]` — resolved against `refs`. `null` when nothing resolves,
 *  which per CommonMark makes it plain text, not a link. */
function resolveDest(
  node: SyntaxNode,
  text: string,
  refs: Map<string, string>,
  fallbackLabel: () => string,
): string | null {
  const url = namedChild(node, 'URL');
  if (url !== null) {
    return textOf(text, url);
  }
  const label = namedChild(node, 'LinkLabel');
  const raw = label !== null ? textOf(text, label).slice(1, -1) : '';
  const key = normalizeLabel(raw !== '' ? raw : fallbackLabel());
  return refs.get(key) ?? null;
}

/** Append `node`, merging it into the previous entry when both are plain text
 *  so the view draws one span instead of a run of adjacent ones. */
function push(out: MdNode[], node: MdNode): void {
  const last = out[out.length - 1];
  if (node.kind === 'text' && last !== undefined && last.kind === 'text') {
    last.text += node.text;
    return;
  }
  out.push(node);
}

/** Inline content of `node`: its children converted in order, with the source
 *  between them kept as literal text. */
function inlineChildren(
  node: SyntaxNode,
  text: string,
  refs: Map<string, string>,
): MdNode[] {
  const out: MdNode[] = [];
  let pos = node.from;
  // A mark that opens the block — the `#` of a heading, the `[x]` of a task —
  // is followed by a delimiting space that is not content. A *closing* mark is
  // different: the space after `**bold**` belongs to the sentence, so only a
  // mark sitting at the very start of the block licenses the trim.
  let afterOpeningMark = false;
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    if (child.from > pos) {
      const gap = text.slice(pos, child.from);
      push(out, {
        kind: 'text',
        text: afterOpeningMark ? gap.replace(/^[ \t]+/, '') : gap,
      });
    }
    for (const converted of inlineNode(child, text, refs)) {
      push(out, converted);
    }
    afterOpeningMark = MARKS.has(child.name) && child.from === node.from;
    pos = child.to;
  }
  if (pos < node.to) {
    const tail = text.slice(pos, node.to);
    push(out, {
      kind: 'text',
      text: afterOpeningMark ? tail.replace(/^[ \t]+/, '') : tail,
    });
  }
  return out;
}

/** Flatten a node to plain text, marks and all skipped. Exported for tests:
 *  it's the function that would silently drop content if a new MdNode
 *  variant were added here without a case. */
export function flatten(nodes: MdNode[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
      case 'code':
        out += node.text;
        break;
      case 'emphasis':
      case 'strong':
      case 'strike':
      case 'link':
        out += flatten(node.children);
        break;
      case 'image':
        out += node.alt;
        break;
      default:
        break;
    }
  }
  return out;
}

function inlineNode(
  node: SyntaxNode,
  text: string,
  refs: Map<string, string>,
): MdNode[] {
  if (MARKS.has(node.name)) {
    return [];
  }
  // A `URL` node is the destination text. As a child of `Link`/`Image` it is
  // read separately by `resolveDest` and must stay dropped here. Anywhere
  // else it is the whole content — a standalone autolink, bracketed
  // (`<https://…>`) or bare (GFM) — and is the address it names.
  if (node.name === 'URL') {
    const parentName = node.parent?.name;
    if (parentName === 'Link' || parentName === 'Image') {
      return [];
    }
    const url = textOf(text, node);
    return [
      { kind: 'link', dest: url, children: [{ kind: 'text', text: url }] },
    ];
  }
  switch (node.name) {
    case 'Emphasis':
      return [{ kind: 'emphasis', children: inlineChildren(node, text, refs) }];
    case 'StrongEmphasis':
      return [{ kind: 'strong', children: inlineChildren(node, text, refs) }];
    case 'Strikethrough':
      return [{ kind: 'strike', children: inlineChildren(node, text, refs) }];
    case 'InlineCode':
      return [
        { kind: 'code', text: flatten(inlineChildren(node, text, refs)) },
      ];
    // Destination resolves to null for an undefined reference, which per
    // CommonMark is not a link — falls back to plain content.
    case 'Link': {
      const children = inlineChildren(node, text, refs);
      const dest = resolveDest(node, text, refs, () => flatten(children));
      return dest === null ? children : [{ kind: 'link', dest, children }];
    }
    case 'Image': {
      const children = inlineChildren(node, text, refs);
      const dest = resolveDest(node, text, refs, () => flatten(children));
      return dest === null
        ? children
        : [{ kind: 'image', dest, alt: flatten(children) }];
    }
    // Inline HTML is content, not markup: the characters the author typed.
    case 'HTMLTag':
      return [{ kind: 'text', text: textOf(text, node) }];
    default:
      return inlineChildren(node, text, refs);
  }
}

const HEADING = /^(?:ATX|Setext)Heading(\d)$/;

function listItems(
  node: SyntaxNode,
  text: string,
  refs: Map<string, string>,
): MdListItem[] {
  const items: MdListItem[] = [];
  for (let item = node.firstChild; item !== null; item = item.nextSibling) {
    if (item.name !== 'ListItem') {
      continue;
    }
    let checked: boolean | null = null;
    const children: MdNode[] = [];
    for (let part = item.firstChild; part !== null; part = part.nextSibling) {
      if (MARKS.has(part.name)) {
        continue;
      }
      if (part.name === 'Task') {
        const marker = part.firstChild;
        if (marker !== null && marker.name === 'TaskMarker') {
          checked = /\[[xX]\]/.test(textOf(text, marker));
        }
        for (const node2 of inlineChildren(part, text, refs)) {
          push(children, node2);
        }
        continue;
      }
      for (const converted of blockNode(part, text, refs)) {
        children.push(converted);
      }
    }
    items.push({ checked, children });
  }
  return items;
}

function tableCells(
  row: SyntaxNode,
  text: string,
  refs: Map<string, string>,
): MdNode[][] {
  const cells: MdNode[][] = [];
  for (let cell = row.firstChild; cell !== null; cell = cell.nextSibling) {
    if (cell.name === 'TableCell') {
      cells.push(inlineChildren(cell, text, refs));
    }
  }
  return cells;
}

/** Convert one block-level node. Returns a list because some source nodes
 *  produce nothing at all. */
export function blockNode(
  node: SyntaxNode,
  text: string,
  refs: Map<string, string>,
): MdNode[] {
  const heading = HEADING.exec(node.name);
  if (heading !== null) {
    const level = Number.parseInt(heading[1] ?? '1', 10);
    return [
      { kind: 'heading', level, children: inlineChildren(node, text, refs) },
    ];
  }
  switch (node.name) {
    case 'Paragraph':
      return [
        { kind: 'paragraph', children: inlineChildren(node, text, refs) },
      ];
    case 'Blockquote': {
      const children: MdNode[] = [];
      for (let c = node.firstChild; c !== null; c = c.nextSibling) {
        if (MARKS.has(c.name)) {
          continue;
        }
        for (const converted of blockNode(c, text, refs)) {
          children.push(converted);
        }
      }
      return [{ kind: 'quote', children }];
    }
    case 'BulletList':
      return [
        { kind: 'list', ordered: false, items: listItems(node, text, refs) },
      ];
    case 'OrderedList':
      return [
        { kind: 'list', ordered: true, items: listItems(node, text, refs) },
      ];
    case 'FencedCode':
    case 'CodeBlock': {
      let info = '';
      let body = '';
      for (let c = node.firstChild; c !== null; c = c.nextSibling) {
        if (c.name === 'CodeInfo') {
          info = textOf(text, c);
        } else if (c.name === 'CodeText') {
          body = textOf(text, c);
        }
      }
      if (body === '' && node.name === 'CodeBlock') {
        body = textOf(text, node);
      }
      return [{ kind: 'codeblock', info, text: body }];
    }
    case 'Table': {
      let header: MdNode[][] = [];
      const rows: MdNode[][][] = [];
      for (let c = node.firstChild; c !== null; c = c.nextSibling) {
        if (c.name === 'TableHeader') {
          header = tableCells(c, text, refs);
        } else if (c.name === 'TableRow') {
          rows.push(tableCells(c, text, refs));
        }
      }
      return [{ kind: 'table', header, rows }];
    }
    case 'HorizontalRule':
      return [{ kind: 'rule' }];
    // A block of raw HTML is shown as the text it is. This is the one place a
    // Markdown renderer usually hands the document control, and the one place
    // this one refuses to.
    case 'HTMLBlock':
    case 'CommentBlock':
    case 'ProcessingInstructionBlock':
      return [{ kind: 'html', text: textOf(text, node) }];
    // A definition block is not content — it's already reflected in `refs`.
    case 'LinkReference':
      return [];
    default:
      return [
        { kind: 'paragraph', children: inlineChildren(node, text, refs) },
      ];
  }
}

/** Convert one block's own source into render nodes.
 *
 *  The block is parsed on its own, from the slice the index recorded, so the
 *  cost of showing a screenful never depends on how large the document is. */
export function renderBlockSource(
  parse: (src: string) => Tree,
  source: string,
  refs: Map<string, string>,
): MdNode[] {
  const tree = parse(source);
  const out: MdNode[] = [];
  const cursor = tree.cursor();
  if (!cursor.firstChild()) {
    return out;
  }
  do {
    const node = cursor.node;
    for (const converted of blockNode(node, source, refs)) {
      out.push(converted);
    }
  } while (cursor.nextSibling());
  return out;
}
