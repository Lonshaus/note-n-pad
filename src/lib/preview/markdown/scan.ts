// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Finding where Markdown blocks start and end, without building a tree.
 *
 *  Parsing a whole document into a syntax tree costs memory in proportion to
 *  the document: measured, a 36-million-character file took 2.5 seconds and
 *  1.1 GB. This scanner reads the text once, records two integers per block,
 *  and lets the parser run on one block at a time — 60 million characters
 *  scan in 81ms, and a screenful parses in about 1ms. Memory then tracks what
 *  is on screen rather than the size of the file, which is the rule the rest of
 *  the app already follows for large documents.
 *
 *  Offsets live in a flat `Int32Array`: two entries per block, `from` then
 *  `to`. A JS array of pairs costs several times more for the same numbers. */

/** Blocks as a flat `[from, to, from, to, …]` array. */
export type BlockIndex = Int32Array;

/** Result of one scan: the block index, plus the two document-wide facts a
 *  windowed renderer cannot get from the blocks it happens to have on screen —
 *  where a reference label points, and which block holds a given heading. */
export interface ScanResult {
  index: BlockIndex;
  refs: Map<string, string>;
  /** Heading slug to the ordinal of the block holding it. */
  headings: Map<string, number>;
}

export function blockCount(index: BlockIndex): number {
  return index.length >> 1;
}

export function blockStart(index: BlockIndex, i: number): number {
  return index[i << 1] ?? 0;
}

export function blockEnd(index: BlockIndex, i: number): number {
  return index[(i << 1) + 1] ?? 0;
}

/** Is this line a bullet or ordered list marker? */
function isListLine(line: string): boolean {
  return /^\s{0,3}(?:[-*+]\s|\d{1,9}[.)]\s)/.test(line);
}

/** A line that continues the block above it across a blank line: an indented
 *  continuation, or the next item of a list that has blank lines between its
 *  items. */
function continuesBlock(line: string, blockIsList: boolean): boolean {
  if (line.trim() === '') {
    return false;
  }
  if (/^(?: {4,}|\t)/.test(line)) {
    return true;
  }
  return blockIsList && isListLine(line);
}

/** CommonMark label matching: case-insensitive, internal whitespace runs
 *  collapsed. Used on both the definition and the lookup side so they agree. */
export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** ATX headings only. A setext heading (`Title` underlined with `===`) needs
 *  the line after it, and `---` is also a thematic break; neither is worth the
 *  lookahead until someone asks for it. */
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

/** The text of an ATX heading, or null if the line is not one. CommonMark
 *  requires the space after the hashes, so `#foo` is a paragraph. */
export function headingText(line: string): string | null {
  const m = ATX.exec(line);
  if (m === null) {
    return null;
  }
  // `## foo ##` is "foo": the trailing hashes close the heading.
  return (m[2] ?? '').replace(/[ \t]+#+$/, '');
}

/** GitHub's slug rule, which is what a `#heading` link in the wild is written
 *  against: lowercase, punctuation dropped, spaces to hyphens. Letters and
 *  digits are matched by Unicode property, so a CJK heading keeps its text
 *  instead of slugging to nothing. */
export function slugify(text: string): string {
  return (
    text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      // Trimmed after the strip, not before: `## !!! ???` is left as two spaces
      // either side of one, and hyphenating those would give a slug of `-`.
      .trim()
      .replace(/\s+/g, '-')
  );
}

/** Slugs for one document, disambiguating repeats the way GitHub does: the
 *  second `## Notes` is `notes-1`. Stateful because that suffix depends on
 *  every heading before it. */
export function createSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text: string): string => {
    const base = slugify(text);
    const used = seen.get(base);
    if (used === undefined) {
      seen.set(base, 0);
      return base;
    }
    seen.set(base, used + 1);
    return `${base}-${used + 1}`;
  };
}

// Matches the single-line form `[label]: dest` or `[label]: dest "title"`.
const DEFINITION = /^ {0,3}\[([^\]]+)\]:\s*(<[^>]*>|\S+)/;

// Matches `[label]:` with nothing after the colon — the multi-line form,
// destination expected on the next line.
const LABEL_ONLY = /^ {0,3}\[([^\]]+)\]:\s*$/;

// The destination token on the line after a label-only definition line.
const DEST_LINE = /^\s*(<[^>]*>|\S+)/;

/** Definitions collected caps here so a document that is nothing but
 *  definitions can't grow the map without bound — same rule as the block
 *  index, memory tracks structure, not size. */
const MAX_REFS = 4096;

/** Same rule for headings: a jump target costs a map entry, and a document is
 *  not allowed to buy unbounded ones. */
const MAX_HEADINGS = 4096;

/** Longest block handed to the parser in one piece, outside a fenced block.
 *
 *  A document with no blank lines anywhere — a log file renamed `.md` — would
 *  otherwise be a single block, and parsing it would cost exactly what this
 *  design exists to avoid. Inside a fence the cap is not applied: fenced text
 *  is one node to the parser however long it is, and splitting a large embedded
 *  file would break it for no gain. */
export const MAX_BLOCK = 64 * 1024;

/** Lines of `text`, without their line breaks, produced one at a time. */
function* splitLines(text: string): Generator<string> {
  let i = 0;
  while (i <= text.length) {
    let end = text.indexOf('\n', i);
    if (end === -1) {
      end = text.length;
    }
    yield text.slice(i, end);
    i = end + 1;
  }
}

/** Index the top-level blocks of `text`. Convenience for tests and small
 *  strings; the app scans straight off the document rope. */
export function scanBlocks(text: string): ScanResult {
  return scanLines(splitLines(text));
}

/** Index the top-level blocks of a document given as lines.
 *
 *  Taking lines rather than one string is what lets the scan run over a rope
 *  without ever materialising it: the only strings that exist are one line at a
 *  time. A blank line ends a block, except inside a fenced code block, and
 *  except where the next content line continues it — an indented line, or the
 *  next item of a list. Those two exceptions are what stop a fence or a loose
 *  list from being torn into pieces that would then parse as unrelated
 *  blocks. */
export function scanLines(lines: Iterable<string>): ScanResult {
  // Grown in place rather than collected into JS arrays first: at four million
  // blocks those intermediate arrays are eight million doubles, a transient
  // ~100MB spike that would land on exactly the machines this design exists to
  // protect.
  let buf = new Int32Array(1024);
  let len = 0;
  const record = (from: number, to: number): void => {
    if (len + 2 > buf.length) {
      const next = new Int32Array(buf.length * 2);
      next.set(buf);
      buf = next;
    }
    buf[len] = from;
    buf[len + 1] = Math.max(from, to);
    len += 2;
  };
  const refs = new Map<string, string>();
  const addRef = (label: string, rawDest: string): void => {
    if (refs.size >= MAX_REFS) {
      return;
    }
    const norm = normalizeLabel(label);
    let dest = rawDest;
    if (dest.startsWith('<') && dest.endsWith('>')) {
      dest = dest.slice(1, -1);
    }
    if (norm !== '' && !refs.has(norm)) {
      refs.set(norm, dest);
    }
  };
  // Label seen on a `[label]:` line whose destination is still expected on
  // the next line.
  let pendingLabel: string | null = null;
  // Checked only while the current block's lines have all been definitions
  // so far — a definition-looking line mid-paragraph is just text.
  const scanDefLine = (line: string): boolean => {
    if (pendingLabel !== null) {
      const label = pendingLabel;
      pendingLabel = null;
      // A definition never supplies the destination of the one above it.
      // CommonMark drops the incomplete `[label]:` rather than swallowing the
      // next definition as its destination, which would lose both.
      if (DEFINITION.test(line) || LABEL_ONLY.test(line)) {
        return scanDefLine(line);
      }
      // Always matches: line is never blank here.
      const m = DEST_LINE.exec(line);
      addRef(label, m?.[1] ?? '');
      return true;
    }
    const full = DEFINITION.exec(line);
    if (full !== null) {
      addRef(full[1] ?? '', full[2] ?? '');
      return true;
    }
    const labelOnly = LABEL_ONLY.exec(line);
    if (labelOnly !== null) {
      pendingLabel = labelOnly[1] ?? '';
      return true;
    }
    return false;
  };
  const headings = new Map<string, number>();
  const nextSlug = createSlugger();
  // `len >> 1` is the ordinal of the block being accumulated: every earlier
  // block has already been recorded, and this one is recorded next.
  const addHeading = (line: string): void => {
    if (headings.size >= MAX_HEADINGS) {
      return;
    }
    const text = headingText(line);
    if (text === null) {
      return;
    }
    const slug = nextSlug(text);
    if (slug !== '') {
      headings.set(slug, len >> 1);
    }
  };
  let defRunActive = false;
  // Starts the definition run fresh for a new block.
  const startBlockDef = (line: string): void => {
    pendingLabel = null;
    defRunActive = scanDefLine(line);
  };
  let i = 0;
  let blockStartAt = -1;
  let blockIsList = false;
  let inFence = false;
  let fence = '';
  let pendingBlank = false;
  // End of the most recent content line. A block ends there, not at whatever
  // offset the scan happens to have reached after skipping blank lines.
  let lastEnd = 0;

  for (const line of lines) {
    const lineEnd = i + line.length;
    const trimmed = line.trim();

    if (inFence) {
      // Blank lines inside a fence belong to the code, but a run of them at the
      // end of an unclosed fence is not content and must not extend the block.
      if (trimmed !== '') {
        lastEnd = lineEnd;
      }
      if (trimmed.startsWith(fence)) {
        inFence = false;
        record(blockStartAt, lineEnd);
        blockStartAt = -1;
        blockIsList = false;
      }
    } else if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      // A fence opens a block of its own; anything pending ends first.
      if (blockStartAt !== -1) {
        record(blockStartAt, lastEnd);
      }
      blockStartAt = i;
      blockIsList = false;
      inFence = true;
      fence = trimmed.slice(0, 3);
      pendingBlank = false;
      lastEnd = lineEnd;
    } else if (trimmed === '') {
      pendingBlank = blockStartAt !== -1;
      // CommonMark forbids a blank line inside a definition; without this an
      // indented continuation after the blank could leak the run past it.
      defRunActive = false;
    } else if (blockStartAt === -1) {
      blockStartAt = i;
      blockIsList = isListLine(line);
      pendingBlank = false;
      lastEnd = lineEnd;
      startBlockDef(line);
    } else if (pendingBlank) {
      if (continuesBlock(line, blockIsList)) {
        pendingBlank = false;
      } else {
        record(blockStartAt, lastEnd);
        blockStartAt = i;
        blockIsList = isListLine(line);
        pendingBlank = false;
        startBlockDef(line);
      }
      lastEnd = lineEnd;
    } else {
      if (defRunActive) {
        defRunActive = scanDefLine(line);
      }
      lastEnd = lineEnd;
    }
    // Before the length check below, which may record this block and move the
    // ordinal on. An ATX heading may interrupt a paragraph, so every content
    // line outside a fence is a candidate, not just the first of a block.
    if (!inFence && trimmed !== '' && blockStartAt !== -1) {
      addHeading(line);
    }
    if (
      !inFence &&
      blockStartAt !== -1 &&
      lastEnd - blockStartAt >= MAX_BLOCK
    ) {
      record(blockStartAt, lastEnd);
      blockStartAt = -1;
      blockIsList = false;
      pendingBlank = false;
    }
    i = lineEnd + 1;
  }
  if (blockStartAt !== -1) {
    record(blockStartAt, lastEnd);
  }

  return { index: buf.subarray(0, len), refs, headings };
}

/** First block at or after `offset`, for jumping to a position. */
export function blockAtOffset(index: BlockIndex, offset: number): number {
  let lo = 0;
  let hi = blockCount(index) - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blockStart(index, mid) <= offset) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
