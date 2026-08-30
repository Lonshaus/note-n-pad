// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** In-document `#heading` links: the slug a link refers to, and the context a
 *  node uses to jump. The slug rule itself lives in `scan.ts` beside the one
 *  for reference labels, because the scanner is what applies it to every
 *  heading in the document. Kept out of `core.ts` so that module stays free of
 *  Svelte. */
import { getContext, setContext } from 'svelte';
import { slugify } from './scan';

/** The slug a `#...` destination refers to, or null if the destination is not
 *  an anchor. Percent-decoded first: a link to a CJK heading is written
 *  encoded, and decoding can fail on a malformed escape. */
export function anchorSlug(dest: string): string | null {
  if (!dest.startsWith('#')) {
    return null;
  }
  const raw = dest.slice(1);
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Malformed escape: the literal text is still worth a lookup.
  }
  return slugify(decoded);
}

/** Read through methods, never captured: the heading map is rebuilt on every
 *  edit. */
export interface PreviewAnchors {
  /** Which block holds the heading this destination names, or null when
   *  nothing does — an anchor with no target stays plain text. */
  find(dest: string): number | null;
  jump(block: number): void;
}

const KEY = Symbol('markdown-preview-anchors');

export function setPreviewAnchors(value: PreviewAnchors): void {
  setContext(KEY, value);
}

/** Undefined when no view provided it, which leaves anchors as plain text. */
export function getPreviewAnchors(): PreviewAnchors | undefined {
  return getContext<PreviewAnchors | undefined>(KEY);
}
