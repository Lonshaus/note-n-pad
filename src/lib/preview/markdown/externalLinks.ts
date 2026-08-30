// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Whether an `external` link (http/https/mailto, see `links.ts`) may render
 *  as a clickable `<a>` for reasons other than the local-resources setting —
 *  a document that ships inside the app, like the privacy policy, has no
 *  "someone else's file" risk and no folder to gate on. Kept separate from
 *  `images.ts`: that setting must keep governing images and relative links on
 *  its own, unaffected by this. */
import { getContext, setContext } from 'svelte';

/** Read through a getter, never captured, for the same reason as
 *  `PreviewImages`: the prop it wraps could in principle vary over the view's
 *  lifetime. */
export interface PreviewExternalLinks {
  readonly allowed: boolean;
}

const KEY = Symbol('markdown-preview-external-links');

export function setPreviewExternalLinks(value: PreviewExternalLinks): void {
  setContext(KEY, value);
}

/** Undefined when no view provided it, which is every case but the privacy
 *  window — treated the same as `allowed: false`. */
export function getPreviewExternalLinks(): PreviewExternalLinks | undefined {
  return getContext<PreviewExternalLinks | undefined>(KEY);
}
