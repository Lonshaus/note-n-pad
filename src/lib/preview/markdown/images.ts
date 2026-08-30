// Copyright © 2026 Lonshaus
// SPDX-License-Identifier: GPL-3.0-only
/** Local images in the Markdown preview: the `docimg` URL an image node asks
 *  for, and the context that tells the recursive node renderer whether to ask
 *  at all. Kept out of `core.ts` so that module stays free of Svelte. */
import { getContext, setContext } from 'svelte';

/** The `docimg` URL for a Markdown image destination. The destination travels
 *  whole in a query parameter, percent-encoded, so nothing between here and the
 *  Rust containment check reads any part of it as a path. Windows and Android
 *  serve a custom scheme as `http://<scheme>.localhost`; elsewhere it is
 *  `<scheme>://`, and both forms are in the CSP's `img-src`. */
export function docimgUrl(dest: string, windows: boolean): string {
  const origin = windows ? 'http://docimg.localhost' : 'docimg://localhost';
  return `${origin}/?p=${encodeURIComponent(dest)}`;
}

/** Whether an image request would be accepted, which is the only safe moment
 *  to render an `<img>`: a request that arrives before the core has this
 *  document's folder is refused, and the node latches that refusal for good.
 *  `registered` is the folder the core has confirmed for this webview, so it
 *  lags `wanted` across a launch or a switch to a document in another folder. */
export function previewImagesReady(
  settingOn: boolean,
  wanted: string | null,
  registered: string | null,
): boolean {
  return settingOn && wanted !== null && registered === wanted;
}

/** Read through getters, never captured: the setting can be toggled while a
 *  preview is open. */
export interface PreviewImages {
  /** True only when a request would be accepted — see `previewImagesReady`.
   *  Gates clickable links too: same setting, same folder. */
  readonly on: boolean;
  readonly windows: boolean;
}

const KEY = Symbol('markdown-preview-images');

export function setPreviewImages(value: PreviewImages): void {
  setContext(KEY, value);
}

/** Undefined when no view provided it, which renders alt text — the same as
 *  the setting being off. */
export function getPreviewImages(): PreviewImages | undefined {
  return getContext<PreviewImages | undefined>(KEY);
}
