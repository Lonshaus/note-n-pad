// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Finds element ranges by scanning the source text, without building a parse
 *  tree. `@lezer/xml` parsing the whole document up front cost 577ms and
 *  450MB of garbage at 9.6M characters, of which the resulting tree kept only
 *  6MB — the cost was the act of parsing, not the tree it produced. This scan
 *  does the structural work (where does each element start and end) without
 *  ever building node objects for content nobody asked to see; `xml.ts` hands
 *  only the start tag of a row that is actually rendered to `@lezer/xml`, one
 *  tag at a time, to read its name and attributes.
 *
 *  This module never validates well-formedness beyond finding tag
 *  boundaries — `findStructuralError` does that separately, once, over the
 *  whole document, because the view has to report a malformed document
 *  before the user scrolls anywhere near the damage. */

export type ScanKind =
  'element' | 'text' | 'cdata' | 'comment' | 'instruction' | 'doctype';

/** One child at a single level: `element`s carry their whole tag-to-tag span
 *  (including the closing tag, if any), everything else its whole markup
 *  span. Never a row by itself — `xml.ts` turns a range into an `XmlNode`. */
export interface ScanRange {
  kind: ScanKind;
  from: number;
  to: number;
}

/** End of the level `scanChildren`/`iterateChildren` were asked to look at:
 *  `end` is where a matching close tag starts (or `to`, if none was found —
 *  an unclosed document or element), `closeEnd` is just past it. */
export interface ScanLevel {
  end: number;
  closeEnd: number;
}

/** Scratch record `scanTagEnd` writes into instead of allocating a fresh
 *  object per tag — the dive loops below look at hundreds of thousands of
 *  tags per document and never need to hold more than one result at a time.
 *  Every caller reads these fields before the next `scanTagEnd`/`endOfTag`
 *  call (`endOfTag` copies them into a fresh object for its own callers, who
 *  may hold on to the result), so nothing can alias two live tags. */
const tagScratch: { end: number; close: boolean; self: boolean } = {
  end: 0,
  close: false,
  self: false,
};

/** End of one tag starting at `i`, honouring quoted attribute values so a
 *  `>` inside `attr="a>b"` does not end the tag early. Writes into
 *  `tagScratch`; returns whether a tag was found at all. */
function scanTagEnd(text: string, i: number, to: number): boolean {
  if (text[i] !== '<') {
    return false;
  }
  const close = text[i + 1] === '/';
  let j = i + 1;
  let quote = '';
  while (j < to) {
    const c = text[j];
    if (quote !== '') {
      if (c === quote) {
        quote = '';
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      tagScratch.end = j + 1;
      tagScratch.close = close;
      tagScratch.self = text[j - 1] === '/';
      return true;
    }
    j += 1;
  }
  return false;
}

/** `scanTagEnd`, boxed into a fresh object for callers that hold on to the
 *  result (or hold several at once) rather than reading it immediately. */
export function endOfTag(
  text: string,
  i: number,
  to: number,
): { end: number; close: boolean; self: boolean } | null {
  if (!scanTagEnd(text, i, to)) {
    return null;
  }
  return {
    end: tagScratch.end,
    close: tagScratch.close,
    self: tagScratch.self,
  };
}

function isXmlNameSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

/** Scratch record `scanTagName` writes into — same reuse rationale as
 *  `tagScratch`: `findStructuralError` reads it once, immediately, per tag,
 *  and never needs two live name ranges at once (it compares by range, not
 *  by copying a name out). */
const nameScratch: { from: number; to: number } = { from: 0, to: 0 };

/** The tag name's own `[from, to)` range right after `<` or `</` in
 *  `text[tagFrom, tagEnd)`, stopping at the first whitespace, `/` or `>`.
 *  Writes into `nameScratch` rather than slicing — a name is never
 *  materialised as a string just to find or compare it. */
function scanTagName(text: string, tagFrom: number, tagEnd: number): void {
  let i = tagFrom + 1;
  if (text[i] === '/') {
    i += 1;
  }
  while (i < tagEnd && isXmlNameSpace(text[i]!)) {
    i += 1;
  }
  nameScratch.from = i;
  while (
    i < tagEnd &&
    text[i] !== '/' &&
    text[i] !== '>' &&
    !isXmlNameSpace(text[i]!)
  ) {
    i += 1;
  }
  nameScratch.to = i;
}

/** Two ranges of `text` hold the same characters, without allocating either
 *  as its own string. */
export function sameRange(
  text: string,
  aFrom: number,
  aTo: number,
  bFrom: number,
  bTo: number,
): boolean {
  if (aTo - aFrom !== bTo - bFrom) {
    return false;
  }
  const len = aTo - aFrom;
  for (let k = 0; k < len; k += 1) {
    if (text[aFrom + k] !== text[bFrom + k]) {
      return false;
    }
  }
  return true;
}

/** Markup that is not an element tag: comment, CDATA, processing
 *  instruction, or a doctype declaration. Returns `null` when `text[i]` is
 *  an element open or close tag instead — the only case the caller has to
 *  handle itself, since it needs to distinguish open from close. */
function skipMarkup(
  text: string,
  i: number,
  to: number,
): { kind: ScanKind; stop: number } | null {
  if (text.startsWith('<!--', i)) {
    const end = text.indexOf('-->', i + 4);
    return { kind: 'comment', stop: end === -1 ? to : end + 3 };
  }
  if (text.startsWith('<![CDATA[', i)) {
    const end = text.indexOf(']]>', i + 9);
    return { kind: 'cdata', stop: end === -1 ? to : end + 3 };
  }
  if (text.startsWith('<?', i)) {
    const end = text.indexOf('?>', i + 2);
    return { kind: 'instruction', stop: end === -1 ? to : end + 2 };
  }
  if (text.startsWith('<!', i)) {
    // A doctype may carry a bracketed internal subset before its closing
    // '>'. `@lezer/xml`'s grammar ends `DoctypeDecl` at the *first* '>',
    // which lands inside the subset (e.g. after `<!ENTITY lol "lol">`) and
    // turns the rest of the subset into a stray `Text` node — that is a
    // known lezer bug, not something to match. Finding the matching ']'
    // first is what keeps the whole declaration, and everything it
    // declares, out of the scan entirely.
    const bracket = text.indexOf('[', i);
    const gt = text.indexOf('>', i);
    let stop: number;
    if (bracket !== -1 && (gt === -1 || bracket < gt)) {
      const close = text.indexOf(']', bracket);
      const after = close === -1 ? -1 : text.indexOf('>', close);
      stop = after === -1 ? to : after + 1;
    } else {
      stop = gt === -1 ? to : gt + 1;
    }
    return { kind: 'doctype', stop };
  }
  return null;
}

/** The direct children of `[from, to)`, one at a time, in document order.
 *  Stops as soon as a close tag ends the level, so a caller that only wants
 *  the first few children (`xml.ts`'s `childrenSlice`) can drain exactly
 *  that many and no more. */
export function* iterateChildren(
  text: string,
  from: number,
  to: number,
): Generator<ScanRange, ScanLevel, void> {
  let i = from;
  let textStart = -1;
  while (i < to) {
    if (text[i] !== '<') {
      if (textStart === -1) {
        textStart = i;
      }
      i += 1;
      continue;
    }
    if (textStart !== -1) {
      if (text.slice(textStart, i).trim() !== '') {
        yield { kind: 'text', from: textStart, to: i };
      }
      textStart = -1;
    }
    const special = skipMarkup(text, i, to);
    if (special !== null) {
      yield { kind: special.kind, from: i, to: special.stop };
      i = special.stop;
      continue;
    }
    if (text[i + 1] === '/') {
      // A close tag at this level ends the parent's content.
      const gt = text.indexOf('>', i);
      return { end: i, closeEnd: gt === -1 ? to : gt + 1 };
    }
    const start = i;
    const openTag = endOfTag(text, i, to);
    if (openTag === null) {
      i = to;
      break;
    }
    if (openTag.self) {
      yield { kind: 'element', from: start, to: openTag.end };
      i = openTag.end;
      continue;
    }
    // Walk descendant tags, tracking only nesting depth, until this
    // element's own close tag brings it back to zero. Whether each close
    // tag's *name* actually matches is `findStructuralError`'s job, run once
    // for the whole document — this loop only has to find where the range
    // ends, which is why it stays a flat scan instead of a recursive one.
    let depth = 1;
    i = openTag.end;
    for (;;) {
      const next = text.indexOf('<', i);
      if (next === -1 || next >= to) {
        i = to;
        break;
      }
      i = next;
      const inner = skipMarkup(text, i, to);
      if (inner !== null) {
        i = inner.stop;
        continue;
      }
      if (!scanTagEnd(text, i, to)) {
        i = to;
        break;
      }
      const tagEnd = tagScratch.end;
      if (tagScratch.self) {
        i = tagEnd;
        continue;
      }
      if (tagScratch.close) {
        depth -= 1;
        i = tagEnd;
        if (depth === 0) {
          break;
        }
        continue;
      }
      depth += 1;
      i = tagEnd;
    }
    yield { kind: 'element', from: start, to: i };
  }
  if (textStart !== -1 && text.slice(textStart, to).trim() !== '') {
    yield { kind: 'text', from: textStart, to };
  }
  return { end: to, closeEnd: to };
}

/** `iterateChildren`, drained. Only what the property test and `xmlScan`'s
 *  own callers that want everything (not a slice) need — `xml.ts` uses the
 *  generator directly wherever draining early matters. */
export function scanChildren(
  text: string,
  from: number,
  to: number,
): ScanLevel & { children: ScanRange[] } {
  const children: ScanRange[] = [];
  const gen = iterateChildren(text, from, to);
  let step = gen.next();
  while (!step.done) {
    children.push(step.value);
    step = gen.next();
  }
  return { children, end: step.value.end, closeEnd: step.value.closeEnd };
}

/** How many children `iterateChildren` would yield for `[from, to)] — same
 *  filtering (no doctype, no whitespace-only text) — without building a
 *  `ScanRange`, or even a per-tag `endOfTag` result, for any of them. A
 *  caller that only wants `childCount` (every element row, and the document
 *  root) used to drain the generator for it, which for a 115,556-child
 *  element meant allocating and discarding 115,556 records just to learn
 *  their count. */
export function countChildren(text: string, from: number, to: number): number {
  let count = 0;
  let i = from;
  let textStart = -1;
  while (i < to) {
    if (text[i] !== '<') {
      if (textStart === -1) {
        textStart = i;
      }
      i += 1;
      continue;
    }
    if (textStart !== -1) {
      if (text.slice(textStart, i).trim() !== '') {
        count += 1;
      }
      textStart = -1;
    }
    const special = skipMarkup(text, i, to);
    if (special !== null) {
      if (special.kind !== 'doctype') {
        count += 1;
      }
      i = special.stop;
      continue;
    }
    if (text[i + 1] === '/') {
      return count;
    }
    if (!scanTagEnd(text, i, to)) {
      break;
    }
    count += 1;
    if (tagScratch.self) {
      i = tagScratch.end;
      continue;
    }
    let depth = 1;
    i = tagScratch.end;
    for (;;) {
      const next = text.indexOf('<', i);
      if (next === -1 || next >= to) {
        i = to;
        break;
      }
      i = next;
      const inner = skipMarkup(text, i, to);
      if (inner !== null) {
        i = inner.stop;
        continue;
      }
      if (!scanTagEnd(text, i, to)) {
        i = to;
        break;
      }
      const tagEnd = tagScratch.end;
      if (tagScratch.self) {
        i = tagEnd;
        continue;
      }
      if (tagScratch.close) {
        depth -= 1;
        i = tagEnd;
        if (depth === 0) {
          break;
        }
        continue;
      }
      depth += 1;
      i = tagEnd;
    }
  }
  if (textStart !== -1 && text.slice(textStart, to).trim() !== '') {
    count += 1;
  }
  return count;
}

/** The first structural problem in the whole document, or `null` if it is
 *  well-formed by this scanner's rules: every close tag matches the
 *  innermost still-open element by name, every opened element is closed,
 *  and the document has exactly one root element to speak of (zero is
 *  reported as damage; more than one is not checked — not exercised by
 *  anything this app needs to catch).
 *
 *  Deliberately narrower than `@lezer/xml`: this app's grammar-shaped
 *  divergences (a bare `&` not starting a reference, for instance) are not
 *  reported here. Only the three kinds of damage a scan can see without a
 *  grammar — a close tag naming the wrong element, a close tag with no open
 *  element, an element that is never closed — are structural enough to stop
 *  the preview outright. */
export function findStructuralError(text: string): { from: number } | null {
  const to = text.length;
  // Three parallel arrays, not one array of `{nameFrom, nameTo, from}`
  // objects: a number array's backing store is a flat, unboxed block, so
  // pushing a SMI onto it is not an allocation the way pushing an object
  // (even a 3-field one) is. This is the still-open element stack — one
  // push per open tag, up to 338,000 of them for the largest fixture.
  const stackNameFrom: number[] = [];
  const stackNameTo: number[] = [];
  const stackFrom: number[] = [];
  let sawElement = false;
  let i = 0;
  while (i < to) {
    if (text[i] !== '<') {
      i += 1;
      continue;
    }
    const special = skipMarkup(text, i, to);
    if (special !== null) {
      i = special.stop;
      continue;
    }
    if (text[i + 1] === '/') {
      if (!scanTagEnd(text, i, to)) {
        return { from: i };
      }
      const tagEnd = tagScratch.end;
      scanTagName(text, i, tagEnd);
      const nameFrom = nameScratch.from;
      const nameTo = nameScratch.to;
      const topNameFrom = stackNameFrom.pop();
      const topNameTo = stackNameTo.pop();
      stackFrom.pop();
      if (
        topNameFrom === undefined ||
        topNameTo === undefined ||
        !sameRange(text, topNameFrom, topNameTo, nameFrom, nameTo)
      ) {
        return { from: i };
      }
      i = tagEnd;
      continue;
    }
    if (!scanTagEnd(text, i, to)) {
      return { from: i };
    }
    const tagEnd = tagScratch.end;
    sawElement = true;
    if (!tagScratch.self) {
      scanTagName(text, i, tagEnd);
      stackNameFrom.push(nameScratch.from);
      stackNameTo.push(nameScratch.to);
      stackFrom.push(i);
    }
    i = tagEnd;
  }
  if (stackFrom.length > 0) {
    // Report the innermost element that never saw its close tag.
    return { from: stackFrom[stackFrom.length - 1]! };
  }
  if (!sawElement) {
    return { from: 0 };
  }
  return null;
}
