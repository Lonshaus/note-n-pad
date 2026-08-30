// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** What a Markdown link destination is. Only a classification: whether a
 *  destination may actually be opened is decided in the Rust core, which is
 *  handed the destination whole. Kept out of `core.ts` so that module stays
 *  free of anything but parsing. */

/** Schemes that may be handed to the OS. Everything else carrying a scheme is
 *  `blocked`, so a `javascript:` or `file:` destination never becomes an
 *  `<a href>` at all, and no click handler has to be the thing that stops it. */
const EXTERNAL_SCHEMES = ['http', 'https', 'mailto'];

/** A scheme per RFC 3986: a letter, then letters, digits, `+`, `-`, `.`. */
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/** Strip C0 controls and space off both ends: the range the URL parser
 *  removes before it reads a scheme. `trim()` is not enough, it leaves U+0001
 *  in place, and a stray control character is exactly how ` javascript:x`
 *  gets past a check that reads the first character as a path. */
function trimEdgeJunk(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 0x20) {
    start += 1;
  }
  while (end > start && s.charCodeAt(end - 1) <= 0x20) {
    end -= 1;
  }
  return s.slice(start, end);
}

/** `anchor` is an in-document `#heading`, which is not a file and does nothing
 *  here. `relative` is anything the Rust core may try to resolve against the
 *  document's folder, including things it will refuse. */
export type LinkKind = 'external' | 'relative' | 'anchor' | 'blocked';

export function linkKind(dest: string): LinkKind {
  const trimmed = trimEdgeJunk(dest);
  if (trimmed === '') {
    return 'blocked';
  }
  if (trimmed.startsWith('#')) {
    return 'anchor';
  }
  const scheme = SCHEME.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme === undefined) {
    return 'relative';
  }
  return EXTERNAL_SCHEMES.includes(scheme) ? 'external' : 'blocked';
}

/** Whether a link node renders as a clickable `<a>` rather than plain text.
 *  `relative` stays behind `imagesOn` alone: it resolves against a document
 *  folder, and the image setting is the only thing that says that resolution
 *  may happen. `external` additionally opens under `externalLinksAllowed`
 *  (set for a document with no folder and no third-party risk, e.g. the
 *  bundled privacy policy) without that also loosening `relative` or images.
 *  `hasAnchorTarget` needs neither: the jump stays inside the document. */
export function showsAsLink(
  kind: LinkKind,
  imagesOn: boolean,
  externalLinksAllowed: boolean,
  hasAnchorTarget: boolean,
): boolean {
  if (hasAnchorTarget) {
    return true;
  }
  if (kind === 'relative') {
    return imagesOn;
  }
  if (kind === 'external') {
    return imagesOn || externalLinksAllowed;
  }
  return false;
}
