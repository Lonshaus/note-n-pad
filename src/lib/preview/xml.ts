// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** The XML preview never lets a parsed node reach the screen. This layer
 *  reads names and text out of the document, hands the view plain strings,
 *  and keeps its own bookkeeping private: nothing the view can reach is a
 *  parser node.
 *
 *  Structure comes from `xmlScan.ts`'s scan, not from parsing the whole
 *  document with `@lezer/xml`: that cost 577ms and 450MB of garbage at
 *  9.6M characters, against a full document scan of 20ms and 2MB. Only the
 *  start tag of a row that is actually built gets handed to `@lezer/xml`,
 *  to read its name and attributes — a few microseconds each, and never for
 *  a row nobody scrolled to.
 *
 *  It still uses `@lezer/xml` rather than `DOMParser` for that one job,
 *  for the reason the module used to use it for the whole parse: a DOM
 *  costs what the document costs, and `parseFromString` expands
 *  DTD-declared entities before any size check can run, which is how a
 *  794-byte billion-laughs file wedged the window for good. Nothing below
 *  ever resolves a declared entity, so that document is structurally
 *  harmless here rather than refused. */

import { parser } from '@lezer/xml';
import {
  countChildren,
  endOfTag,
  findStructuralError,
  iterateChildren,
  type ScanRange,
} from './xmlScan';

export type XmlNodeKind =
  'element' | 'text' | 'cdata' | 'comment' | 'instruction' | 'document';

export interface XmlAttribute {
  name: string;
  value: string;
}

/** One row of the tree. Strings and numbers only — deliberately. */
export interface XmlNode {
  kind: XmlNodeKind;
  /** Element or instruction name; empty for text, CDATA and comments. */
  name: string;
  attributes: readonly XmlAttribute[];
  /** Text for the leaf kinds, null for elements and the document. */
  value: string | null;
  childCount: number;
}

export interface XmlParseError {
  /** Only one reason left: the scan integrates everything else. */
  reason: 'syntax';
  message: string;
  /** The offending line, when the scan pins one down; null is allowed so the
   *  view keeps a message for a position it cannot name. */
  position: { line: number; column: number } | null;
}

export type XmlParseResult =
  { ok: true; root: XmlNode } | { ok: false; error: XmlParseError };

/** What this module reads from the document. A CodeMirror `Text` satisfies
 *  it; a test can pass anything of the same shape. Deliberately not a
 *  `Document`: the mapping stays free of DOM globals and testable in plain
 *  node. */
export interface XmlText {
  length: number;
  sliceString(from: number, to: number): string;
  lineAt(pos: number): { number: number; from: number; to: number };
}

/** How much of the offending line the error message quotes. */
const DETAIL_CHARS = 80;

/** The scan record each row came from, plus the document string it reads
 *  and the shared per-parse child-walk cache. A `WeakMap` rather than
 *  fields on `XmlNode`: the view holds `XmlNode`s, so there is no path from
 *  the rendered tree back to this bookkeeping. Only `element` and
 *  `document` rows — the container kinds — get an entry. */
/** What one parse shares: the flattened document, the rope it came from, and
 *  the child-walk cache. Held by reference from every node's `ScanSource`, so
 *  letting the document go is one assignment rather than a hunt through
 *  however many nodes happen to have been built. */
interface ScanDoc {
  source: string;
  text: XmlText;
  cache: WalkCache;
  /** Set by `disposeXmlPreview`. Checked before any walk: `source` is emptied
   *  on disposal, and scanning an empty string against the old bounds would
   *  step one character at a time to the end of a document that is no longer
   *  there. */
  disposed: boolean;
}

interface ScanSource {
  /** Where this container's content starts: right after its own open tag
   *  for an element, `0` for the document. */
  contentFrom: number;
  /** Where this container's content is bounded by — its own `to` (which
   *  includes its close tag, if it has one) or the document's length.
   *  `iterateChildren` stops at the first close tag it meets regardless of
   *  this bound, so it only has to be "far enough", not exact. */
  contentTo: number;
  doc: ScanDoc;
}

const sourceOf = new WeakMap<XmlNode, ScanSource>();

/** Only the five predefined entities and character references are ever
 *  decoded. A reference to a declared entity is left exactly as the author
 *  typed it — never resolved, never expanded. That is what makes a
 *  billion-laughs document impossible here rather than merely refused. */
const REFERENCE = /&(#[0-9]+|#[xX][0-9a-fA-F]+|amp|lt|gt|quot|apos);/g;
const PREDEFINED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeReferences(source: string): string {
  if (!source.includes('&')) {
    return source;
  }
  return source.replace(REFERENCE, (whole: string, ref: string) => {
    if (!ref.startsWith('#')) {
      return PREDEFINED[ref] ?? whole;
    }
    const hex = ref[1] === 'x' || ref[1] === 'X';
    const code = Number.parseInt(ref.slice(hex ? 2 : 1), hex ? 16 : 10);
    // Out of range or a lone surrogate stays as typed rather than becoming a
    // replacement character.
    if (
      !Number.isFinite(code) ||
      code < 0 ||
      code > 0x10ffff ||
      (code >= 0xd800 && code <= 0xdfff)
    ) {
      return whole;
    }
    return String.fromCodePoint(code);
  });
}

/** An attribute value arrives with its quotes. */
function unquote(raw: string): string {
  const first = raw[0];
  if (
    (first === '"' || first === "'") &&
    raw.length >= 2 &&
    raw.endsWith(first)
  ) {
    return decodeReferences(raw.slice(1, -1));
  }
  return decodeReferences(raw);
}

/** Text between a leaf range's delimiters, clamped so a document that ends
 *  mid-comment does not slice backwards. */
function inner(
  source: string,
  range: ScanRange,
  open: number,
  close: number,
): string {
  const from = range.from + open;
  return source.slice(from, Math.max(from, range.to - close));
}

/** `<?target data?>` splits at the first whitespace, the way a DOM
 *  instruction's name and data do. */
function instructionParts(raw: string): [string, string] {
  const space = raw.search(/\s/);
  if (space === -1) {
    return [raw, ''];
  }
  return [raw.slice(0, space), raw.slice(space).trimStart()];
}

/** An element's name and attributes, read by handing `@lezer/xml` just its
 *  own start tag — never the rest of the document. Parsing `<foo a="1">` in
 *  isolation is unclosed as far as the grammar is concerned, but its
 *  `OpenTag`/`SelfClosingTag` production completes exactly the same either
 *  way, so the trailing error the grammar adds is simply never looked at. */
function tagInfo(tagText: string): {
  name: string;
  attributes: XmlAttribute[];
} {
  const element = parser.parse(tagText).topNode.getChild('Element');
  const tag =
    element?.getChild('OpenTag') ?? element?.getChild('SelfClosingTag');
  if (tag === null || tag === undefined) {
    return { name: '', attributes: [] };
  }
  const tagName = tag.getChild('TagName');
  const name = tagName === null ? '' : tagText.slice(tagName.from, tagName.to);
  const attributes: XmlAttribute[] = [];
  for (const attr of tag.getChildren('Attribute')) {
    const nameNode = attr.getChild('AttributeName');
    if (nameNode === null) {
      continue;
    }
    const valueNode = attr.getChild('AttributeValue');
    attributes.push({
      name: tagText.slice(nameNode.from, nameNode.to),
      value:
        valueNode === null
          ? ''
          : unquote(tagText.slice(valueNode.from, valueNode.to)),
    });
  }
  return { name, attributes };
}

/** One level's worth of resumable scan: `gen` is where `iterateChildren`
 *  last stopped, `pieces` is every row-eligible child found so far. Kept
 *  per container position (`contentFrom`, unique within one document) so a
 *  second slice of the same container resumes instead of re-walking from
 *  its first child — the difference between a 115,556-child scroll being
 *  O(index) once and O(n^2) overall. */
interface WalkState {
  gen: Generator<ScanRange, unknown, void>;
  pieces: ScanRange[];
  done: boolean;
}

/** Shared by every `ScanSource` from one parse, so a fresh `XmlNode` built
 *  for "the same" element on a later scroll frame still finds its walk. */
type WalkCache = Map<number, WalkState>;

/** A doctype declaration is never a row — this app drops it exactly like a
 *  DOM parser's document would never surface it as a sibling to walk. */
function isRowKind(kind: ScanRange['kind']): boolean {
  return kind !== 'doctype';
}

function extendWalk(walk: WalkState, count: number): void {
  while (!walk.done && walk.pieces.length < count) {
    const step = walk.gen.next();
    if (step.done) {
      walk.done = true;
      break;
    }
    if (isRowKind(step.value.kind)) {
      walk.pieces.push(step.value);
    }
  }
}

function walkFor(ctx: ScanSource): WalkState {
  const existing = ctx.doc.cache.get(ctx.contentFrom);
  if (existing !== undefined) {
    return existing;
  }
  const walk: WalkState = {
    gen: iterateChildren(ctx.doc.source, ctx.contentFrom, ctx.contentTo),
    pieces: [],
    done: false,
  };
  ctx.doc.cache.set(ctx.contentFrom, walk);
  return walk;
}

/** Convert one scanned range to a row. For an element, this is the only
 *  place its start tag is ever parsed — and only once, when the row is
 *  actually built. */
function nodeFrom(piece: ScanRange, ctx: ScanSource): XmlNode {
  const { source } = ctx.doc;
  switch (piece.kind) {
    case 'text':
      return {
        kind: 'text',
        name: '',
        attributes: [],
        value: decodeReferences(source.slice(piece.from, piece.to)),
        childCount: 0,
      };
    case 'cdata':
      return {
        kind: 'cdata',
        name: '',
        attributes: [],
        value: inner(source, piece, 9, 3),
        childCount: 0,
      };
    case 'comment':
      return {
        kind: 'comment',
        name: '',
        attributes: [],
        value: inner(source, piece, 4, 3),
        childCount: 0,
      };
    case 'instruction': {
      const [name, value] = instructionParts(inner(source, piece, 2, 2));
      return {
        kind: 'instruction',
        name,
        attributes: [],
        value,
        childCount: 0,
      };
    }
    case 'element': {
      const openTag = endOfTag(source, piece.from, piece.to);
      const tagEnd = openTag?.end ?? piece.to;
      const selfClosing = openTag?.self ?? true;
      const { name, attributes } = tagInfo(source.slice(piece.from, tagEnd));
      const contentFrom = tagEnd;
      const contentTo = piece.to;
      if (!selfClosing) {
        const sub: ScanSource = { contentFrom, contentTo, doc: ctx.doc };
        const childCount = countChildren(source, contentFrom, contentTo);
        const node: XmlNode = {
          kind: 'element',
          name,
          attributes,
          value: null,
          childCount,
        };
        sourceOf.set(node, sub);
        return node;
      }
      return { kind: 'element', name, attributes, value: null, childCount: 0 };
    }
    default:
      // `doctype` is filtered out before `nodeFrom` is ever called with one.
      throw new Error(`xml preview: unexpected scan kind "${piece.kind}"`);
  }
}

/** Let go of a preview's document.
 *
 *  The flattened source is a whole copy of the file, so leaving it to the
 *  collector means a closed preview still counts against the process until a
 *  collection happens to run — measured, reopening one repeatedly grew the
 *  window by about a document each time and never gave any of it back. Calling
 *  this makes the release a property of closing the view rather than a hope
 *  about the collector.
 *
 *  Afterwards the tree produces no rows, which is what a closed preview shows
 *  anyway. Idempotent, and safe on a root that was never a preview's. */
export function disposeXmlPreview(root: XmlNode): void {
  const ctx = sourceOf.get(root);
  if (ctx === undefined) {
    return;
  }
  ctx.doc.disposed = true;
  ctx.doc.source = '';
  ctx.doc.cache.clear();
}

/** Immediate children, built on demand. A collapsed subtree costs nothing,
 *  which is what keeps a large document off the main thread. */
export function childrenOf(node: XmlNode): XmlNode[] {
  const ctx = sourceOf.get(node);
  if (ctx === undefined || ctx.doc.disposed) {
    return [];
  }
  const out: XmlNode[] = [];
  for (const piece of iterateChildren(
    ctx.doc.source,
    ctx.contentFrom,
    ctx.contentTo,
  )) {
    if (isRowKind(piece.kind)) {
      out.push(nodeFrom(piece, ctx));
    }
  }
  return out;
}

/** Children `[from, to)`, without walking — let alone building — anything
 *  before or after that range. Resumes the same underlying scan a previous
 *  call left off at, via `WalkCache`, so a scroll that only ever moves the
 *  window forward costs the same total work `childrenOf` would have, just
 *  spread over many calls instead of paid up front. */
export function childrenSlice(
  node: XmlNode,
  from: number,
  to: number,
): XmlNode[] {
  const ctx = sourceOf.get(node);
  if (ctx === undefined || ctx.doc.disposed || to <= from) {
    return [];
  }
  const walk = walkFor(ctx);
  extendWalk(walk, to);
  return walk.pieces
    .slice(Math.max(0, from), Math.min(to, walk.pieces.length))
    .map((piece) => nodeFrom(piece, ctx));
}

/** One child, or `undefined` past the end. */
function childAt(node: XmlNode, index: number): XmlNode | undefined {
  return childrenSlice(node, index, index + 1)[0];
}

/** A node's position in the visible tree: dot-joined child indices from the
 *  top, e.g. the third grandchild of the second root is `"1.2"`. Paths, not
 *  object identity, because rows are rebuilt on every scroll — a `WeakSet` of
 *  `XmlNode`s would forget everything the instant the window moved. */
function childPath(parent: string, index: number): string {
  return parent === '' ? String(index) : `${parent}.${index}`;
}

/** Paths the user has toggled away from their default state. A root
 *  (`depth === 0`) starts open; anything deeper starts closed — so a path in
 *  this set means "closed" at depth 0 and "open" everywhere else. */
export type ExpandedPaths = ReadonlySet<string>;

/** Whether the node at `path`/`depth` is open, given which paths were
 *  toggled. */
export function isRowOpen(
  path: string,
  depth: number,
  toggled: ExpandedPaths,
): boolean {
  return (depth === 0) !== toggled.has(path);
}

/** Every toggled-open path, grouped by its immediate parent path, each list
 *  sorted ascending. Bounded by how many nodes the user has actually
 *  expanded — never by document size — so the tree-walking functions below
 *  only ever recurse into those, and treat every other child as the single
 *  collapsed row it renders as. */
function openChildrenByParent(toggled: ExpandedPaths): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const path of toggled) {
    const dot = path.lastIndexOf('.');
    const depth = path.split('.').length - 1;
    if (!isRowOpen(path, depth, toggled)) {
      continue;
    }
    const parent = dot === -1 ? '' : path.slice(0, dot);
    const index = Number(path.slice(dot + 1));
    const list = map.get(parent);
    if (list === undefined) {
      map.set(parent, [index]);
    } else {
      list.push(index);
    }
  }
  for (const list of map.values()) {
    list.sort((a, b) => a - b);
  }
  return map;
}

/** Rows `node` itself contributes: one for itself, plus one for every
 *  collapsed child (from `childCount`, never built), plus the real count of
 *  every child the user actually opened (built and recursed into — the only
 *  children touched at all). */
function subtreeRowCount(
  node: XmlNode,
  path: string,
  depth: number,
  toggled: ExpandedPaths,
  openMap: Map<string, number[]>,
): number {
  if (!isRowOpen(path, depth, toggled) || node.childCount === 0) {
    return 1;
  }
  let total = 1 + node.childCount;
  for (const index of openMap.get(path) ?? []) {
    const child = childAt(node, index);
    if (child === undefined) {
      continue;
    }
    total +=
      subtreeRowCount(
        child,
        childPath(path, index),
        depth + 1,
        toggled,
        openMap,
      ) - 1;
  }
  return total;
}

/** Total visible rows for a forest of top-level roots (the document's own
 *  children — the document node itself is never a row). Independent of
 *  scroll position, so callers can hold it in a `$derived` that only changes
 *  when the parse or the expansion state does. */
export function visibleRowCount(
  roots: readonly XmlNode[],
  toggled: ExpandedPaths,
): number {
  const openMap = openChildrenByParent(toggled);
  let total = 0;
  for (let i = 0; i < roots.length; i += 1) {
    total += subtreeRowCount(roots[i]!, String(i), 0, toggled, openMap);
  }
  return total;
}

/** One flattened row: the node to draw, its path (for expansion state and
 *  Svelte keying) and its indent depth. */
export interface VisibleRow {
  node: XmlNode;
  path: string;
  depth: number;
}

/** Rows `node`'s own subtree would contribute in the closed half-open range
 *  `[start, end)` of the whole visible list, where `base` is the flat index
 *  `node` itself sits at. Skips whole collapsed runs by arithmetic rather
 *  than iterating them — the loop only ever touches `end - start` children
 *  plus whichever ones the user opened. */
function collectSubtree(
  node: XmlNode,
  path: string,
  depth: number,
  base: number,
  start: number,
  end: number,
  toggled: ExpandedPaths,
  openMap: Map<string, number[]>,
  out: VisibleRow[],
): void {
  if (base >= start && base < end) {
    out.push({ node, path, depth });
  }
  if (!isRowOpen(path, depth, toggled) || node.childCount === 0) {
    return;
  }
  const openIndexes = openMap.get(path) ?? [];
  let cursor = 0;
  let pos = base + 1;
  const collectCollapsedRun = (from: number, to: number): void => {
    const lo = Math.max(from, from + (start - pos));
    const hi = Math.min(to, from + (end - pos));
    for (let index = lo; index < hi; index += 1) {
      const rowPos = pos + (index - from);
      if (rowPos < start || rowPos >= end) {
        continue;
      }
      const child = childAt(node, index);
      if (child !== undefined) {
        out.push({
          node: child,
          path: childPath(path, index),
          depth: depth + 1,
        });
      }
    }
  };
  for (const openIndex of openIndexes) {
    const gap = openIndex - cursor;
    if (gap > 0 && pos + gap > start && pos < end) {
      collectCollapsedRun(cursor, openIndex);
    }
    pos += gap;
    const child = childAt(node, openIndex);
    if (child !== undefined) {
      const grandPath = childPath(path, openIndex);
      const count = subtreeRowCount(
        child,
        grandPath,
        depth + 1,
        toggled,
        openMap,
      );
      if (pos + count > start && pos < end) {
        collectSubtree(
          child,
          grandPath,
          depth + 1,
          pos,
          start,
          end,
          toggled,
          openMap,
          out,
        );
      }
      pos += count;
    }
    cursor = openIndex + 1;
  }
  if (
    cursor < node.childCount &&
    pos + (node.childCount - cursor) > start &&
    pos < end
  ) {
    collectCollapsedRun(cursor, node.childCount);
  }
}

/** The flattened rows in `[start, end)` of the visible tree — the whole
 *  point of this module: a caller asking for rows 40,000–40,050 of a
 *  115,556-child root never builds row 0, row 1, or any of the other
 *  115,506 it did not ask for. */
export function visibleRows(
  roots: readonly XmlNode[],
  toggled: ExpandedPaths,
  start: number,
  end: number,
): VisibleRow[] {
  const openMap = openChildrenByParent(toggled);
  const out: VisibleRow[] = [];
  let offset = 0;
  for (let i = 0; i < roots.length && offset < end; i += 1) {
    const path = String(i);
    const count = subtreeRowCount(roots[i]!, path, 0, toggled, openMap);
    if (offset + count > start) {
      collectSubtree(
        roots[i]!,
        path,
        0,
        offset,
        start,
        end,
        toggled,
        openMap,
        out,
      );
    }
    offset += count;
  }
  return out;
}

/** Whether a row is layout whitespace. Such rows are dropped on the way out,
 *  so this is the rule they were dropped by. CDATA is left alone: its
 *  whitespace was written deliberately. */
export function isIgnorableText(node: XmlNode): boolean {
  return node.kind === 'text' && (node.value ?? '').trim() === '';
}

/** A single tick, so a document that moved on between the call and here has
 *  a chance to say so via `isStale` before a result lands. The scan itself
 *  is fast enough (milliseconds, even at 9.6M characters) that it does not
 *  need to be sliced the way the old whole-document parse did — this is
 *  only about giving cancellation a chance to run, not about spreading out
 *  real work. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function errorFrom(offset: number, text: XmlText): XmlParseError {
  const line = text.lineAt(offset);
  const detail = text
    .sliceString(line.from, Math.min(line.to, line.from + DETAIL_CHARS))
    .trim();
  return {
    reason: 'syntax',
    message: detail,
    position: { line: line.number, column: offset - line.from + 1 },
  };
}

/** Scan for the preview. Runs eagerly and whole-document, because the view
 *  has to report a malformed document without waiting for the user to
 *  scroll to the damage — but the scan is cheap enough (milliseconds, not
 *  hundreds) that this no longer needs the slicing the old full parse did.
 *  Returns null when `isStale` says the document moved on, which is the
 *  caller's cue to drop the result rather than let it land on a document it
 *  does not belong to. */
export async function parseXmlForPreview(
  text: XmlText,
  isStale: () => boolean,
): Promise<XmlParseResult | null> {
  const source = text.sliceString(0, text.length);
  const issue = findStructuralError(source);
  await yieldToEventLoop();
  if (isStale()) {
    return null;
  }
  if (issue !== null) {
    return { ok: false, error: errorFrom(issue.from, text) };
  }
  const ctx: ScanSource = {
    contentFrom: 0,
    contentTo: source.length,
    doc: { source, text, cache: new Map(), disposed: false },
  };
  const childCount = countChildren(source, 0, source.length);
  const root: XmlNode = {
    kind: 'document',
    name: '',
    attributes: [],
    value: null,
    childCount,
  };
  sourceOf.set(root, ctx);
  return { ok: true, root };
}
