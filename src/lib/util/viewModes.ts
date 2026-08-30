// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Which view a document tab is showing. `source` is the editor itself and is
 *  always available; every other mode is an alternative rendering of the same
 *  text, chosen per tab and never persisted. `table` edits the document,
 *  the preview modes are read-only. */
export type ViewMode = 'source' | 'table' | 'json' | 'xml' | 'markdown';

/** Longest document each preview will render.
 *
 *  One number for all three was wrong: measured in WebKit, the same document
 *  costs an order of magnitude more in one format than another, so a single
 *  ceiling either strangles the cheap formats or lets the expensive ones
 *  exhaust a small machine.
 *  - `json` builds the whole parsed value: 30.8M characters measured at 183MB.
 *  - `xml` builds a whole DOM: 24.3M characters measured at 485MB, by far the
 *    worst of the three.
 *  - `markdown` builds nothing whole-document at all. Its scanner records two
 *    integers per block and the parser runs on the blocks on screen — 120M
 *    characters measured at 186ms and 30MB. Its old ceiling was inherited from
 *    an eager parse that no longer exists; what is left is only the index's own
 *    worst case, and at that size the large-file viewer has taken the file
 *    anyway. */
export const MAX_PREVIEW_CHARS: Readonly<Record<string, number>> = {
  json: 10_000_000,
  xml: 10_000_000,
  markdown: 100_000_000,
};

/** The ceiling for `mode`, or `Infinity` for modes that have none. */
export function previewCharLimit(mode: ViewMode): number {
  return MAX_PREVIEW_CHARS[mode] ?? Number.POSITIVE_INFINITY;
}

/** Modes offered for `path`, in the order the switcher should list them. The
 *  first entry is the mode a freshly opened tab starts in. A path with no
 *  alternative rendering gets `['source']`, which the caller reads as "no
 *  switcher at all". */
export function viewModesFor(path: string | null): ViewMode[] {
  if (path === null) {
    return ['source'];
  }
  const dot = path.lastIndexOf('.');
  if (dot === -1) {
    return ['source'];
  }
  // Extensions are compared lowercased: a file saved as NOTES.JSON is still
  // JSON, and case-insensitive filesystems hand back either spelling.
  const ext = path.slice(dot + 1).toLowerCase();
  switch (ext) {
    case 'csv':
    case 'tsv':
      // Table first: tabular files have opened in the table view since before
      // previews existed, and that default is not changing.
      return ['table', 'source'];
    case 'json':
      return ['source', 'json'];
    case 'xml':
      return ['source', 'xml'];
    case 'md':
    case 'markdown':
      return ['source', 'markdown'];
    default:
      return ['source'];
  }
}

/** The mode a tab for `path` opens in. */
export function defaultViewModeFor(path: string | null): ViewMode {
  const modes = viewModesFor(path);
  return modes[0] ?? 'source';
}

/** Why a mode cannot be picked. The caller turns this into a message; keeping
 *  the rule itself free of i18n is what makes it testable on its own. */
export type ViewModeBlocked = 'windowed' | 'too-large';

/** State a tab is in, as far as the switcher is concerned. */
export interface ViewModeContext {
  /** The tab renders through the windowed editor, which nothing else can draw
   *  on top of. */
  windowed: boolean;
  /** Document length in characters. */
  length: number;
}

/** Why `mode` is unavailable for a tab in `ctx`, or null when it is fine.
 *
 *  Two rules, in this order:
 *  - A windowed tab supports none of the alternative views, the table included.
 *  - The ceiling is the one for that mode. The table view has never had a size
 *    limit of its own, and giving it one here would take away something that
 *    works today. */
export function modeBlockedBy(
  mode: ViewMode,
  ctx: ViewModeContext,
): ViewModeBlocked | null {
  if (mode === 'source') {
    return null;
  }
  if (ctx.windowed) {
    return 'windowed';
  }
  if (ctx.length > previewCharLimit(mode)) {
    return 'too-large';
  }
  return null;
}
