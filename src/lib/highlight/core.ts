// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Editor-engine-agnostic highlighting core built directly on Lezer.
 *
 *  No CodeMirror runtime is imported anywhere in this file (or its worker) — the
 *  only dependencies are `@lezer/common` and `@lezer/highlight`, both standalone
 *  libraries. That keeps this module reusable by any future editor surface. */
import type { Parser, PartialParse, Tree } from '@lezer/common';
import { TreeFragment } from '@lezer/common';
import type { ChangedRange } from '@lezer/common';
import { classHighlighter, highlightTree } from '@lezer/highlight';
import type { Edit, SpanRange } from './protocol';

/** Extract highlight ranges for `[from, to)` of `doc` from an already-parsed
 *  `tree`, using Lezer's `classHighlighter`. Ranges are returned in document
 *  order; only regions the tree actually covers produce spans. */
export function extractSpans(
  tree: Tree,
  from: number,
  to: number,
): SpanRange[] {
  const ranges: SpanRange[] = [];
  highlightTree(
    tree,
    classHighlighter,
    (f, t, cls) => {
      ranges.push({ from: f, to: t, cls });
    },
    from,
    to,
  );
  return ranges;
}

/** Decide the position the parser should reach next. The viewport is parsed
 *  before the rest of the document: while the parse has not yet covered the
 *  viewport end, that end is the target; afterwards the remaining tail is filled
 *  in. Pure — this is the scheduling decision, isolated for testing. */
export function nextStopPos(
  parsedPos: number,
  viewportTo: number,
  docLength: number,
): number {
  const viewportEnd = Math.min(Math.max(viewportTo, 0), docLength);
  if (parsedPos < viewportEnd) {
    return viewportEnd;
  }
  return docLength;
}

/** Translate an edit batch (coordinates in the pre-edit document) into Lezer
 *  `ChangedRange`s (which also carry post-edit coordinates). Pure. */
export function toChangedRanges(edits: readonly Edit[]): ChangedRange[] {
  const changes: ChangedRange[] = [];
  let delta = 0;
  for (const edit of edits) {
    const fromB = edit.from + delta;
    const toB = fromB + edit.insert.length;
    changes.push({ fromA: edit.from, toA: edit.to, fromB, toB });
    delta += edit.insert.length - (edit.to - edit.from);
  }
  return changes;
}

/** Apply an edit batch to `doc`, returning the new document text. Edits must be
 *  sorted by `from` and non-overlapping. Pure. */
export function applyEditsToText(doc: string, edits: readonly Edit[]): string {
  let result = '';
  let pos = 0;
  for (const edit of edits) {
    result += doc.slice(pos, edit.from) + edit.insert;
    pos = edit.to;
  }
  result += doc.slice(pos);
  return result;
}

/** A single cancellable, time-budgeted incremental parse toward one stop
 *  position. Wall-clock time is injected via `now` so the advance loop is
 *  deterministic under test. */
export class HighlightSession {
  private readonly parse: PartialParse;
  private cancelled = false;
  private completed: Tree | null = null;

  /** @param stopPos  If less than the document length, the parse is capped here
   *  (viewport-first). Omit or pass the full length to parse to the end. */
  constructor(
    parser: Parser,
    doc: string,
    fragments: readonly TreeFragment[] = [],
    stopPos?: number,
  ) {
    this.parse = parser.startParse(doc, fragments);
    if (stopPos !== undefined && stopPos < doc.length) {
      this.parse.stopAt(stopPos);
    }
  }

  /** Byte offset parsed so far. */
  get parsedPos(): number {
    return this.parse.parsedPos;
  }

  /** The finished tree once `advance` has reached the stop position, else null. */
  get tree(): Tree | null {
    return this.completed;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  /** Request abort; the running `advance` loop bails out at its next check. */
  cancel(): void {
    this.cancelled = true;
  }

  /** Advance the parse, spending at most `budgetMs` before yielding. Returns the
   *  finished tree when the stop position is reached within this slice,
   *  otherwise null (budget exhausted or cancelled) — call again to resume. */
  advance(budgetMs: number, now: () => number): Tree | null {
    const start = now();
    for (;;) {
      if (this.cancelled) {
        return null;
      }
      const done = this.parse.advance();
      if (done) {
        this.completed = done;
        return done;
      }
      if (now() - start >= budgetMs) {
        return null;
      }
    }
  }
}

/** Fragments describing the reusable parts of `tree` after `edits`, ready to
 *  seed the next `HighlightSession` for cheap incremental reparse. */
export function reusableFragments(
  tree: Tree,
  edits: readonly Edit[],
): readonly TreeFragment[] {
  const base = TreeFragment.addTree(tree);
  return TreeFragment.applyChanges(base, toChangedRanges(edits));
}
